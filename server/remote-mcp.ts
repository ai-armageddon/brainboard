// MCP over HTTP, so chat apps (ChatGPT, Claude, Codex, Cursor…) can work on your boards and see what you're doing.
//
//   POST /mcp/<key>                       key in the URL, for apps that only take a URL (ChatGPT, claude.ai)
//   POST /mcp   Authorization: Bearer <key>
//   POST /mcp   from this machine, local mode only: no key needed, sees every board here
//
// A key acts as the browser or account that made it (Connect AI in the app): it sees that person's boards and the
// boards shared with them, with the same role, and nothing else. Stateless: one MCP server per request.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HOSTED, PUBLIC_URL } from './config.ts';
import { anonKey, isCrossSite, isLocalRequest, ownsKey, userKey, type Principal } from './auth.ts';
import { getUser, limited } from './accounts.ts';
import { findKey, touchKey, type AccessKey } from './keys.ts';
import { createBoard, listBoards, readBoard, NotFoundError, type Board } from './store.ts';
import { getOwner, getSharing, setOwner, sharedWith } from './sharing.ts';
import { editBoard, liveBoard, screensOf } from './realtime.ts';
import { instructions, pickBoard, registerBoardTools, type BoardAccess } from './tools.ts';
import type { Role } from '../src/protocol.ts';

const MAX_BODY = 30 * 1024 * 1024; // base64 images

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, www-authenticate',
};

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------- who is calling

interface Caller {
  key: AccessKey | null;
  /** every board on this machine (local keyless access) */
  everything: boolean;
  p: Principal;
  acct: string | null;
}

function callerFromKey(k: AccessKey): Caller {
  const user = k.owner?.startsWith('user:') ? getUser(k.owner.slice(5)) : null;
  const anonId = k.owner?.startsWith('anon:') ? k.owner.slice(5) : null;
  return { key: k, everything: false, p: { user, anonId, local: k.local && !HOSTED }, acct: k.owner };
}

// ---------------------------------------------------------------- what the caller may touch

export async function aiBoards(principal: Principal, boardId?: string, everything = false) {
  const accountKeys = [principal.user ? userKey(principal.user.id) : null, principal.anonId ? anonKey(principal.anonId) : null].filter((k): k is string => !!k);
  const out: (Awaited<ReturnType<typeof listBoards>>[number] & { role: Role; from?: string | null })[] = [];
  const all = (await listBoards()).filter(b => !boardId || b.id === boardId);
  for (const b of all) if (everything || ownsKey(principal, await getOwner(b.id))) out.push({ ...b, role: 'owner' });
  if (!everything && accountKeys.length) {
    const byId = new Map(all.map((b) => [b.id, b]));
    for (const s of await sharedWith(accountKeys, principal.user?.id ?? null)) {
      const meta = byId.get(s.boardId);
      if (!meta || out.some((o) => o.id === s.boardId)) continue;
      const owner = await getOwner(s.boardId);
      const from = owner?.startsWith('user:') ? getUser(owner.slice(5))?.name ?? null : s.invite.from ?? null;
      const paused = s.invite.role === 'editor' && (await getSharing(s.boardId)).settings.paused;
      out.push({ ...meta, role: paused ? 'viewer' : s.invite.role, from });
    }
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated));
}

function accessFor(c: Caller, base: string): BoardAccess {
  const isMe = (acct: string | null, local: boolean) => (c.everything ? local : !!c.acct && acct === c.acct) || (c.p.local && local);
  const list = () => aiBoards(c.p, c.key?.grant?.boardId, c.everything);

  const screens = async () => {
    const mine = await screensOf(isMe);
    const ok = new Set((await list()).map((b) => b.id));
    return mine.filter((s) => ok.has(s.boardId)); // never describe a board this key can't open
  };

  const find = async (ref?: string) => {
    const boards = await list();
    if (ref?.trim()) return pickBoard(boards, ref);
    const open = (await screens())[0];
    const hit = open ? boards.find((b) => b.id === open.boardId) : boards[0];
    if (!hit) throw new NotFoundError('There are no boards yet. Create one with create_board.');
    return hit;
  };

  const read = async (id: string): Promise<Board> => {
    const b = (await liveBoard(id)) ?? (await readBoard(id));
    if (!b) throw new NotFoundError('That board was deleted.');
    return b;
  };

  return {
    list,
    screens,
    defaultHelp: c.key?.grant ? 'Uses the board authorized for this connection.' : 'Defaults to the board the user has open right now, else the most recently edited one.',
    open: async (ref) => read((await find(ref)).id),
    edit: async (ref, fn, opts) => {
      const meta = await find(ref);
      if (meta.role === 'viewer') throw new Error(`"${meta.name}" is shared with you as view-only.`);
      if (opts?.ownerOnly && meta.role !== 'owner') throw new Error(`Only the owner of "${meta.name}" can do that.`);
      const s = (await screens()).find((x) => x.boardId === meta.id && x.view);
      const anchor = s?.view ? { x: s.view.x + s.view.w * 0.08, y: s.view.y + s.view.h * 0.12 } : undefined;
      return editBoard(meta.id, (b) => fn(b, anchor));
    },
    create: async (name) => {
      if (c.key?.grant) throw new Error('This connection is limited to its chosen board.');
      const b = await createBoard(name);
      if (c.acct) await setOwner(b.id, c.acct);
      return b;
    },
    link: (id) => `${base}/#${id}`,
    fetchImage: safeFetchImage,
  };
}

// ---------------------------------------------------------------- downloading images without reaching inside our network

function privateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff');
}

async function safeFetchImage(raw: string): Promise<{ buf: Buffer; mime: string | null }> {
  let url = new URL(raw);
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http(s) image URLs.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!addrs.length || addrs.some((x) => privateAddress(x.address))) throw new Error('That address is not allowed.');
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > 20 * 1024 * 1024) throw new Error('That image is over 20 MB.');
    return { buf: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type')?.split(';')[0] ?? null };
  }
  throw new Error('Too many redirects.');
}

// ---------------------------------------------------------------- the endpoint

export const isMcpPath = (pathname: string) => pathname === '/mcp' || pathname.startsWith('/mcp/');

export function mcpBase(req: IncomingMessage) {
  return PUBLIC_URL ?? `http://${req.headers.host ?? 'localhost:5317'}`;
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL) {
  const method = req.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean); // ["mcp", key?]
  const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;
  const oauth = url.pathname === '/mcp/connect';
  const resource = `${mcpBase(req)}/mcp/connect`;
  const secret = oauth ? bearer : parts[1] ?? bearer;

  let caller: Caller | null = null;
  if (secret) {
    const k = findKey(secret);
    if (k && (oauth ? k.grant?.resource === resource : !k.grant)) caller = callerFromKey(k);
  } else if (!oauth && isLocalRequest(req) && !isCrossSite(req)) {
    caller = { key: null, everything: true, p: { user: null, anonId: null, local: true }, acct: null };
  }
  const cors: Record<string, string> = caller?.key ? CORS : {};

  if (method === 'OPTIONS') { res.writeHead(204, CORS).end(); return; }
  if (!caller || parts.length > 2) {
    return reply(res, 401, {
      jsonrpc: '2.0', id: null,
      error: { code: -32001, message: 'Brainboard needs an access key. Make one in the app: menu → Connect AI.' },
    }, { ...CORS, 'www-authenticate': oauth ? `Bearer resource_metadata="${mcpBase(req)}/.well-known/oauth-protected-resource/mcp/connect", scope="board"` : 'Bearer realm="brainboard"' });
  }
  if (method !== 'POST') {
    // Stateless server: no standalone event stream, no sessions to end.
    return reply(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Use POST.' } }, { ...cors, allow: 'POST, OPTIONS' });
  }
  if (limited(`mcp:${caller.key?.id ?? 'local'}`, 600, 60_000)) {
    return reply(res, 429, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many requests. Slow down a little.' } }, cors);
  }

  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    return reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, cors);
  }
  if (caller.key) touchKey(caller.key);
  for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

  const access = accessFor(caller, mcpBase(req));
  const server = new McpServer({ name: 'brainboard', title: 'Brainboard', version: '0.3.0' }, { instructions: instructions(access) });
  registerBoardTools(server, access);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('[brainboard mcp]', err);
    if (!res.headersSent) reply(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
  }
}
