// HTTP API (mounted in the Vite dev server and in server/main.ts). Live editing goes over /ws.
import { acceptsPicture } from './profile-picture.ts';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  NotFoundError, createBoard, findImage, listBoards, metaOf, putImage, readBoard, renameBoard, trashBoard, isValidId,
} from './store.ts';
import {
  anonKey, clearSessionCookie, clientIp, cookie, inviteToken, isCrossSite, ownerKeyOf, ownerSecret, owns, ownsKey,
  principal, sessionCookie, userKey, type Principal,
} from './auth.ts';
import {
  createInvite, findInvite, getOwner, getSharing, revokeInvite, setOwner, sharedWith, tokenBoards, transferMemberships,
  transferOwnership, updateInvite, type Invite, type InviteRole,
} from './sharing.ts';
import { liveBoard, liveBoardPresence, onlineByInvite, refreshAccess } from './realtime.ts';
import { EXPORT_TYPES, exportBoard, type ExportFormat } from './export.ts';
import {
  BACKDROPS, addShot, cleanMediaName, getMedia, listMedia, mediaFile, publicMedia, renameMedia, renderShot, transferMedia, trashMedia, type Backdrop,
} from './media.ts';
import {
  checkPassword, cleanEmail, cleanName, createSession, createUser, endSession, getUser, limited, publicUser, updateUser, userByEmail,
  validEmail, type User,
} from './accounts.ts';
import { authenticationOptions, authenticationVerify, registrationOptions, registrationVerify, relyingParty } from './passkeys.ts';
import { HOSTED, ICE_SERVERS, PUBLIC_URL } from './config.ts';
import { BROWSE_ENABLED, handleBrowse } from './browse.ts';

const MAX_BODY = 30 * 1024 * 1024;

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

/** What the owner sees of an invite: not who joined with it (browser keys) or which account it's bound to. */
function publicInvite(i: Invite) {
  const { members, userId, ...rest } = i;
  return { ...rest, joined: members?.length ?? 0, forAccount: !!userId };
}

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
  if (ownerParam && !HOSTED && method === 'GET' && !url.pathname.startsWith('/api/')) {
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
    // The shared browser's pages. Checked by the board's browser key, not by cookies: the frame they load in
    // has no origin, so it has no identity here (and is given none).
    if (parts[0] === 'browse' && method === 'GET') return await handleBrowse(req, res, url), true;
    if (isCrossSite(req)) return send(res, 403, { error: 'cross-site request refused' }), true;
    const p = principal(req, res);

    // ---- session & accounts
    if (parts[0] === 'session' && method === 'GET') {
      return send(res, 200, {
        user: p.user ? publicUser(p.user) : null,
        local: p.local,
        hosted: HOSTED,
        publicUrl: PUBLIC_URL,
        passkeys: !!relyingParty(req),
        ice: ICE_SERVERS,
        browser: BROWSE_ENABLED,
      }), true;
    }
    if (parts[0] === 'auth') return await handleAuth(req, res, parts.slice(1), method, p), true;

    // ---- boards shared with me: ones I joined with a link, or addressed to my account. Only ever my own.
    if (parts[0] === 'shared' && method === 'GET') {
      const keys = [p.user ? userKey(p.user.id) : null, p.anonId ? anonKey(p.anonId) : null].filter((k): k is string => !!k);
      if (!keys.length) return send(res, 200, []), true;
      const presence = await liveBoardPresence();
      const out = [];
      for (const { boardId, invite, lastHere } of await sharedWith(keys, p.user?.id ?? null)) {
        const b = await readBoard(boardId);
        if (!b) continue;
        const owner = await getOwner(boardId);
        const ownerName = owner?.startsWith('user:') ? getUser(owner.slice(5))?.name : undefined;
        out.push({
          id: boardId, name: b.name, role: invite.role, from: ownerName ?? invite.from ?? null, token: invite.token,
          updated: b.updated, lastHere, itemCount: b.items.length, ...(presence.get(boardId) ?? { people: [], inCall: 0 }),
        });
      }
      return send(res, 200, out), true;
    }

    // ---- images: anyone with a browser identity or an invite (guests read; editors upload)
    if (parts[0] === 'images') {
      const id = parts[1];
      const token = inviteToken(req, url);
      if (!id && method === 'POST') {
        const guestEditor = token ? (await tokenBoards(token)).some((g) => g.role === 'editor') : false;
        if (!p.user && !p.anonId && !p.local && !guestEditor) return send(res, 403, { error: 'forbidden' }), true;
        const want = url.searchParams.get('id');
        const buf = await readBody(req);
        const saved = await putImage(buf, req.headers['content-type'] ?? null, p.local && want && isValidId(want) ? want : undefined);
        return send(res, 201, { id: saved }), true;
      }
      if (id && method === 'GET') {
        if (!p.user && !p.anonId && !p.local && !(token && (await tokenBoards(token)).length)) return send(res, 403, { error: 'forbidden' }), true;
        const f = await findImage(id);
        if (!f) return send(res, 404, { error: 'not found' }), true;
        res.writeHead(200, { 'content-type': f.mime, 'cache-control': 'private, max-age=31536000, immutable' });
        res.end(await fs.readFile(f.file));
        return true;
      }
    }

    // ---- my role on a board (owner, or the role an invite gives)
    if (parts[0] === 'me' && method === 'GET') {
      const boardId = url.searchParams.get('board') ?? '';
      if (isValidId(boardId) && await owns(p, boardId)) {
        const owner = await getOwner(boardId);
        // "saved" = kept in an account (or on this machine's disk), not just tied to this browser
        return send(res, 200, { role: 'owner', saved: !owner || owner.startsWith('user:') }), true;
      }
      const token = inviteToken(req, url);
      const inv = token && isValidId(boardId) ? await findInvite(boardId, token) : null;
      if (!inv) return send(res, 403, { error: 'invalid invite' }), true;
      // Enough for a friendly join screen: who it's for, which board, and who sent it.
      const owner = await getOwner(boardId);
      const ownerName = owner?.startsWith('user:') ? getUser(owner.slice(5))?.name : undefined;
      return send(res, 200, {
        role: inv.role,
        name: inv.name ?? null,
        from: ownerName ?? inv.from ?? null,
        board: (await readBoard(boardId))?.name ?? null,
      }), true;
    }

    if (parts[0] === 'net' && method === 'GET') {
      return send(res, 200, { lan: network.lan, lanUrls: network.lan ? lanUrls(req) : [], hosted: HOSTED, publicUrl: PUBLIC_URL }), true;
    }

    // ---- export: anyone who can open the board (owner or invite holder)
    if (parts[0] === 'boards' && parts[2] === 'export' && method === 'GET') {
      const id = parts[1];
      const token = inviteToken(req, url);
      if (!isValidId(id) || !((await owns(p, id)) || (token && (await findInvite(id, token))))) return send(res, 403, { error: 'forbidden' }), true;
      const b = (await liveBoard(id)) ?? (await readBoard(id));
      if (!b) return send(res, 404, { error: 'not found' }), true;
      const format = url.searchParams.get('format') as ExportFormat;
      if (!(format in EXPORT_TYPES)) return send(res, 400, { error: 'unknown format' }), true;
      const q = url.searchParams;
      const out = await exportBoard(b, format, {
        ids: q.get('ids')?.split(',').filter(isValidId),
        theme: q.get('theme') === 'dark' ? 'dark' : 'light',
        background: q.get('bg') !== '0',
        scale: Number(q.get('scale')) || 2,
        max: Number(q.get('max')) || undefined,
      });
      if (out === null) return send(res, 422, { error: 'Nothing to export yet' }), true;
      const name = `${(b.name || 'brainboard').replace(/[\\/:*?"<>|]+/g, '').trim() || 'brainboard'}.${EXPORT_TYPES[format].ext}`;
      res.writeHead(200, {
        'content-type': EXPORT_TYPES[format].mime,
        'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'cache-control': 'no-store',
      });
      res.end(out);
      return true;
    }

    // ---- screenshots: anyone who can open the board takes one into their own media
    if (parts[0] === 'boards' && parts[2] === 'screenshot' && method === 'POST') {
      const id = parts[1];
      const token = inviteToken(req, url);
      if (!isValidId(id) || !((await owns(p, id)) || (token && (await findInvite(id, token))))) return send(res, 403, { error: 'forbidden' }), true;
      const owner = ownerKeyOf(p);
      if (!owner && !p.local) return send(res, 403, { error: 'forbidden' }), true;
      if (limited(`shot:${clientIp(req)}`, 90)) return send(res, 429, { error: 'Too many screenshots at once. Try again in a few minutes.' }), true;
      const b = (await liveBoard(id)) ?? (await readBoard(id));
      if (!b) return send(res, 404, { error: 'not found' }), true;
      const body = await readJson<{ frame?: Record<string, unknown>; scale?: number; theme?: string; grid?: boolean; zoom?: number; backdrop?: string; name?: string }>(req);
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e8 ? v : NaN);
      const frame = { x: num(body.frame?.x), y: num(body.frame?.y), w: num(body.frame?.w), h: num(body.frame?.h) };
      if (Object.values(frame).some(Number.isNaN) || frame.w < 1 || frame.h < 1) return send(res, 400, { error: 'Frame an area first' }), true;
      const backdrop: Backdrop = (BACKDROPS as readonly string[]).includes(String(body.backdrop)) ? body.backdrop as Backdrop : 'none';
      const theme = body.theme === 'dark' ? 'dark' : 'light';
      const zoom = num(body.zoom);
      const shot = await renderShot(b, { frame, scale: num(body.scale) || 2, theme, backdrop, grid: body.grid && zoom > 0 ? { zoom } : undefined });
      const item = await addShot({
        name: cleanMediaName(body.name) || `${b.name} screenshot`, owner, board: { id: b.id, name: b.name },
        w: shot.w, h: shot.h, backdrop, theme,
      }, shot.png, shot.thumb);
      return send(res, 201, publicMedia(item)), true;
    }

    // ---- media: your own screenshots
    if (parts[0] === 'media') {
      const mine = (owner: string | null) => ownsKey(p, owner);
      const id = parts[1]?.replace(/\.png$/, '');
      if (!id && method === 'GET') return send(res, 200, (await listMedia(mine)).map(publicMedia)), true;
      const it = id ? await getMedia(id) : null;
      if (!it || !mine(it.owner)) return send(res, 404, { error: 'not found' }), true;
      if (method === 'GET') {
        const thumb = url.searchParams.has('thumb');
        const data = await fs.readFile(mediaFile(it.id, thumb)).catch(() => (thumb ? fs.readFile(mediaFile(it.id)) : null));
        if (!data) return send(res, 404, { error: 'not found' }), true;
        const name = `${it.name}.png`;
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'private, max-age=31536000, immutable',
          ...(url.searchParams.has('download')
            ? { 'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}` }
            : {}),
        });
        res.end(data);
        return true;
      }
      if (method === 'PATCH') {
        const body = await readJson<{ name?: string }>(req);
        const renamed = await renameMedia(it.id, String(body.name ?? ''));
        return send(res, 200, renamed ? publicMedia(renamed) : { error: 'not found' }), true;
      }
      if (method === 'DELETE') {
        await trashMedia(it.id);
        return send(res, 200, { ok: true }), true;
      }
    }

    if (parts[0] === 'boards') {
      const id = parts[1];
      if (!id) {
        if (method === 'GET') {
          const presence = await liveBoardPresence();
          const mine = [];
          for (const b of await listBoards()) {
            if (!ownsKey(p, await getOwner(b.id))) continue;
            const live = presence.get(b.id) ?? { people: [], inCall: 0 };
            mine.push({ ...b, ...live, live: live.people.length });
          }
          return send(res, 200, mine), true;
        }
        if (method === 'POST') {
          const key = ownerKeyOf(p);
          if (!key && !p.local) return send(res, 403, { error: 'forbidden' }), true;
          const body = await readJson<{ name?: string; items?: unknown[] }>(req);
          const b = await createBoard(String(body.name ?? 'Untitled board').slice(0, 80), Array.isArray(body.items) ? (body.items as never[]) : []);
          if (key) await setOwner(b.id, key);
          return send(res, 201, metaOf(b)), true;
        }
      }
      if (!isValidId(id) || !(await owns(p, id))) return send(res, 403, { error: 'Only the board owner can do that.' }), true;
      if (parts[2] === 'share') {
        if (method === 'GET') {
          const s = await getSharing(id);
          const online = await onlineByInvite(id);
          return send(res, 200, { invites: s.invites.map((i) => ({ ...publicInvite(i), online: online[i.token] ?? [] })), settings: s.settings }), true;
        }
      } else if (parts[2] === 'invites') {
        const token = parts[3];
        if (!token && method === 'POST') {
          const body = await readJson<{ role?: InviteRole; label?: string; from?: string; email?: string }>(req);
          const inviter = p.user?.name ?? String(body.from ?? '');
          const email = cleanEmail(body.email);
          if (email && !validEmail(email)) return send(res, 400, { error: 'That email doesn’t look right' }), true;
          // Bind to the account that has this email right now. Emails aren't verified, so an account made later
          // with the same address must not pick the board up; the link itself still works for whoever gets it.
          const account = email ? userByEmail(email) : null;
          const label = String(body.label ?? '').trim() || account?.name || email;
          const inv = await createInvite(id, body.role === 'editor' ? 'editor' : 'viewer', label, inviter, {
            email: email || undefined, userId: account?.id,
          });
          return send(res, 201, { ...publicInvite(inv), account: account ? { name: account.name } : null }), true;
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
          return send(res, 200, metaOf(await renameBoard(id, String(body.name ?? '').slice(0, 80)))), true;
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

// ---------------------------------------------------------------- accounts

class AuthError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

/** Sign the browser in and move its anonymous boards into the account. */
async function signIn(res: ServerResponse, p: Principal, user: User) {
  sessionCookie(res, await createSession(user.id));
  const claimed = p.anonId ? await transferOwnership(anonKey(p.anonId), userKey(user.id)) : 0;
  if (p.anonId) await transferMemberships(anonKey(p.anonId), userKey(user.id));
  if (p.anonId) await transferMedia(anonKey(p.anonId), userKey(user.id));
  return { user: publicUser(user), claimed };
}

function profilePicture(value: unknown) {
  if (value === undefined) return undefined;
  if (!acceptsPicture(value)) throw new AuthError(400, 'Invalid profile picture.');
  return value;
}

async function handleAuth(req: IncomingMessage, res: ServerResponse, parts: string[], method: string, p: Principal) {
  const route = `${method} ${parts.join('/')}`;
  const ip = clientIp(req);
  try {
    if (method === 'POST' && route !== 'POST logout' && limited(`auth:${ip}`, 30)) {
      throw new AuthError(429, 'Too many attempts. Please wait a few minutes and try again.');
    }
    switch (route) {
      case 'POST signup': {
        const b = await readJson<{ name?: string; email?: string; password?: string; picture?: string }>(req);
        const name = cleanName(b.name), email = cleanEmail(b.email), password = String(b.password ?? '');
        if (!name) throw new AuthError(400, 'Choose a screen name.');
        if (!validEmail(email)) throw new AuthError(400, 'That email doesn’t look right.');
        if (password.length < 8) throw new AuthError(400, 'Use at least 8 characters for your password.');
        if (password.length > 200) throw new AuthError(400, 'That password is too long.');
        if (userByEmail(email)) throw new AuthError(409, 'There’s already an account with this email. Sign in instead.');
        const user = await createUser({ name, email, password, picture: profilePicture(b.picture) });
        return send(res, 201, await signIn(res, p, user));
      }
      case 'POST login': {
        const b = await readJson<{ email?: string; password?: string }>(req);
        const email = cleanEmail(b.email);
        if (limited(`login:${email}`, 10)) throw new AuthError(429, 'Too many attempts. Please wait a few minutes and try again.');
        const user = userByEmail(email);
        if (!(await checkPassword(user, String(b.password ?? '')))) throw new AuthError(401, 'Email or password is incorrect.');
        return send(res, 200, await signIn(res, p, user!));
      }
      case 'POST passkey/register/options': {
        const b = await readJson<{ name?: string }>(req);
        const name = cleanName(b.name);
        if (!p.user && !name) throw new AuthError(400, 'Choose a screen name.');
        return send(res, 200, await registrationOptions(req, { name, user: p.user }));
      }
      case 'POST passkey/register/verify': {
        const b = await readJson<{ flow?: string; response?: never; picture?: string }>(req);
        const user = await registrationVerify(req, b.flow, b.response!, profilePicture(b.picture));
        if (p.user?.id === user.id) return send(res, 200, { user: publicUser(user), claimed: 0 });
        return send(res, 201, await signIn(res, p, user));
      }
      case 'POST passkey/login/options':
        return send(res, 200, await authenticationOptions(req));
      case 'POST passkey/login/verify': {
        const b = await readJson<{ flow?: string; response?: never }>(req);
        const user = await authenticationVerify(req, b.flow, b.response!);
        return send(res, 200, await signIn(res, p, user));
      }
      case 'POST logout':
        await endSession(cookie(req, 'bb_session'));
        clearSessionCookie(res);
        return send(res, 200, { ok: true });
      case 'PATCH me': {
        if (!p.user) throw new AuthError(401, 'Sign in first.');
        const b = await readJson<{ name?: string; picture?: string }>(req);
        const name = cleanName(b.name);
        if (!name) throw new AuthError(400, 'Choose a screen name.');
        const picture = profilePicture(b.picture);
        const u = await updateUser(p.user.id, (x) => {
          x.name = name;
          if (picture !== undefined) x.picture = picture || undefined;
        });
        return send(res, 200, { user: publicUser(u!) });
      }
    }
    send(res, 404, { error: 'unknown endpoint' });
  } catch (err) {
    if (err instanceof AuthError) return send(res, err.status, { error: err.message });
    console.warn('[brainboard auth]', (err as Error).message);
    send(res, 400, { error: (err as Error).message || 'Something went wrong.' });
  }
}
