// HTTP API (mounted in the Vite dev server and in server/main.ts). Live editing goes over /ws.
import os from 'node:os';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  NotFoundError, createBoard, findImage, listBoards, metaOf, putImage, readBoard, renameBoard, trashBoard, isValidId,
} from './store.ts';
import { identify, isCrossSite, isOwner, ownerSecret } from './auth.ts';
import { createInvite, getSharing, revokeInvite, tokenBoards, updateInvite, type InviteRole } from './sharing.ts';
import { liveCounts, refreshAccess } from './realtime.ts';

const MAX_BODY = 80 * 1024 * 1024;

/** Set by the server entry point: is this server reachable from other machines? */
export const network = { lan: false };

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const readJson = async <T>(req: IncomingMessage) => JSON.parse((await readBody(req)).toString('utf8') || '{}') as T;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function lanUrls(req: IncomingMessage): string[] {
  const port = (req.headers.host ?? '').match(/:(\d+)$/)?.[1];
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}${port ? `:${port}` : ''}`);
    }
  }
  return out;
}

/** Returns true when the request was handled. */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';

  // Owner sign-in link for other devices: /?owner=<secret> sets a cookie and strips the secret.
  const ownerParam = url.searchParams.get('owner');
  if (ownerParam && method === 'GET' && !url.pathname.startsWith('/api/')) {
    if (ownerParam === ownerSecret()) {
      url.searchParams.delete('owner');
      res.writeHead(302, {
        'set-cookie': `bb_owner=${encodeURIComponent(ownerParam)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
        location: url.pathname + url.search + url.hash,
      });
      res.end();
      return true;
    }
  }

  if (!url.pathname.startsWith('/api/')) return false;
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"

  try {
    if (isCrossSite(req)) return send(res, 403, { error: 'cross-site request refused' }), true;
    const owner = isOwner(req);

    // ---- images: owners, plus guests holding an invite (editors may upload)
    if (parts[0] === 'images') {
      const id = parts[1];
      const ident = identify(req, url);
      const guestBoards = !owner && ident && !ident.owner ? await tokenBoards(ident.token) : [];
      if (!id && method === 'POST') {
        if (!owner && !guestBoards.some((g) => g.role === 'editor')) return send(res, 403, { error: 'forbidden' }), true;
        const want = url.searchParams.get('id');
        const buf = await readBody(req);
        const saved = await putImage(buf, req.headers['content-type'] ?? null, owner && want && isValidId(want) ? want : undefined);
        return send(res, 201, { id: saved }), true;
      }
      if (id && method === 'GET') {
        if (!owner && !guestBoards.length) return send(res, 403, { error: 'forbidden' }), true;
        const f = await findImage(id);
        if (!f) return send(res, 404, { error: 'not found' }), true;
        res.writeHead(200, { 'content-type': f.mime, 'cache-control': 'private, max-age=31536000, immutable' });
        res.end(await fs.readFile(f.file));
        return true;
      }
    }

    // ---- who am I (lets a guest page check its invite before connecting)
    if (parts[0] === 'me' && method === 'GET') {
      if (owner) return send(res, 200, { role: 'owner' }), true;
      const ident = identify(req, url);
      const boardId = url.searchParams.get('board') ?? '';
      const hit = ident && !ident.owner ? (await tokenBoards(ident.token)).find((g) => g.boardId === boardId) : undefined;
      return send(res, hit ? 200 : 403, hit ? { role: hit.role } : { error: 'invalid invite' }), true;
    }

    if (!owner) return send(res, 403, { error: 'Only the board owner can do that.' }), true;

    if (parts[0] === 'net' && method === 'GET') {
      return send(res, 200, { lan: network.lan, lanUrls: network.lan ? lanUrls(req) : [] }), true;
    }

    if (parts[0] === 'boards') {
      const id = parts[1];
      if (!id) {
        if (method === 'GET') {
          const live = await liveCounts();
          return send(res, 200, (await listBoards()).map((b) => ({ ...b, live: Math.max(0, (live[b.id] ?? 0)) }))), true;
        }
        if (method === 'POST') {
          const body = await readJson<{ name?: string; items?: unknown[] }>(req);
          const b = await createBoard(body.name ?? 'Untitled board', Array.isArray(body.items) ? (body.items as never[]) : []);
          return send(res, 201, metaOf(b)), true;
        }
      } else if (parts[2] === 'share') {
        if (method === 'GET') return send(res, 200, await getSharing(id)), true;
      } else if (parts[2] === 'invites') {
        const token = parts[3];
        if (!token && method === 'POST') {
          const body = await readJson<{ role?: InviteRole; label?: string }>(req);
          const inv = await createInvite(id, body.role === 'editor' ? 'editor' : 'viewer', String(body.label ?? ''));
          return send(res, 201, inv), true;
        }
        if (token && method === 'PATCH') {
          const body = await readJson<{ role?: InviteRole; label?: string }>(req);
          const inv = await updateInvite(id, token, body);
          await refreshAccess(id);
          return send(res, inv ? 200 : 404, inv ?? { error: 'not found' }), true;
        }
        if (token && method === 'DELETE') {
          await revokeInvite(id, token);
          await refreshAccess(id);
          return send(res, 200, { ok: true }), true;
        }
      } else if (!parts[2]) {
        if (method === 'GET') {
          const b = await readBoard(id);
          return send(res, b ? 200 : 404, b ?? { error: 'not found' }), true;
        }
        if (method === 'PATCH') {
          const body = await readJson<{ name?: string }>(req);
          return send(res, 200, metaOf(await renameBoard(id, String(body.name ?? '')))), true;
        }
        if (method === 'DELETE') {
          await trashBoard(id);
          return send(res, 200, { ok: true }), true;
        }
      }
    }

    send(res, 404, { error: 'unknown endpoint' });
  } catch (err) {
    if (err instanceof NotFoundError) send(res, 404, { error: err.message });
    else {
      console.error('[brainboard api]', err);
      send(res, 500, { error: (err as Error).message });
    }
  }
  return true;
}
