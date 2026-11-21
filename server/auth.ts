// Who is making this request?
//  - An account: the `bb_session` cookie, after signing in.
//  - An anonymous browser: the `bb_anon` cookie, handed out on the first visit. Boards made before signing in
//    belong to it, and are moved to the account on sign-in.
//  - This machine (dev / self-hosted only): a direct request to localhost, or the owner link printed by
//    `npm run share`. It also sees boards with no owner (older boards and ones made by AI agents over MCP).
//  - A guest: anyone presenting an invite token for a board.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DATA_DIR } from './store.ts';
import { HOSTED, SECURE_COOKIES, TRUST_PROXY } from './config.ts';
import { SESSION_DAYS, sessionUser, type User } from './accounts.ts';
import { getOwner } from './sharing.ts';

export interface Principal {
  user: User | null;
  anonId: string | null;
  local: boolean;
}

/** Owner keys stored on boards. */
export const userKey = (id: string) => `user:${id}`;
export const anonKey = (id: string) => `anon:${id}`;

/** The key new boards are created under. */
export const ownerKeyOf = (p: Principal) => (p.user ? userKey(p.user.id) : p.anonId ? anonKey(p.anonId) : null);

const SECRET_FILE = path.join(DATA_DIR, 'owner-secret');
let secret: string | null = null;

export function ownerSecret(): string {
  if (secret) return secret;
  try {
    secret = readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    mkdirSync(DATA_DIR, { recursive: true });
    secret = crypto.randomBytes(24).toString('base64url');
    writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  }
  return secret;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Direct request from this machine (not relayed through a tunnel or proxy). Never true when hosted. */
export function isLocalRequest(req: IncomingMessage) {
  if (HOSTED) return false;
  const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
  return (
    LOCAL_HOSTS.has(hostname) &&
    LOOPBACK.has(req.socket.remoteAddress ?? '') &&
    !req.headers['x-forwarded-for'] &&
    !req.headers.forwarded &&
    !req.headers['x-real-ip']
  );
}

export function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function setCookie(res: ServerResponse, name: string, value: string, maxAgeSec: number) {
  const c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE_COOKIES ? '; Secure' : ''}`;
  const prev = res.getHeader('set-cookie');
  res.setHeader('set-cookie', [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), c]);
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** This machine, or a device holding the owner link (local mode only). */
export function isMachineOwner(req: IncomingMessage) {
  if (HOSTED) return false;
  if (isLocalRequest(req)) return true;
  const c = cookie(req, 'bb_owner');
  return !!c && safeEqual(c, ownerSecret());
}

const ANON_RE = /^[A-Za-z0-9_-]{20,64}$/;
const anonIdOf = (token: string) => crypto.createHash('sha256').update(token).digest('base64url').slice(0, 22);

/**
 * Work out who is asking. With `res`, a browser that has no identity yet is given an anonymous one.
 * (WebSocket upgrades can't set cookies, so the app calls /api/session first.)
 */
export function principal(req: IncomingMessage, res?: ServerResponse): Principal {
  const user = sessionUser(cookie(req, 'bb_session'));
  let token = cookie(req, 'bb_anon');
  if (token && !ANON_RE.test(token)) token = null;
  if (!token && res) {
    token = crypto.randomBytes(24).toString('base64url');
    setCookie(res, 'bb_anon', token, 400 * 86400);
  }
  return { user, anonId: token ? anonIdOf(token) : null, local: isMachineOwner(req) };
}

export const sessionCookie = (res: ServerResponse, token: string) => setCookie(res, 'bb_session', token, SESSION_DAYS * 86400);
export const clearSessionCookie = (res: ServerResponse) => setCookie(res, 'bb_session', '', 0);

/** Does this principal own the board? Boards without an owner belong to this machine. */
export async function owns(p: Principal, boardId: string): Promise<boolean> {
  const owner = await getOwner(boardId);
  if (!owner) return p.local;
  return (!!p.user && owner === userKey(p.user.id)) || (!!p.anonId && owner === anonKey(p.anonId));
}

export function ownsKey(p: Principal, owner: string | null): boolean {
  if (!owner) return p.local;
  return (!!p.user && owner === userKey(p.user.id)) || (!!p.anonId && owner === anonKey(p.anonId));
}

/** Requests made by a page on another site must not ride on our credentials. */
export function isCrossSite(req: IncomingMessage) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

export const inviteToken = (req: IncomingMessage, url: URL) =>
  url.searchParams.get('invite') ?? ((req.headers['x-invite'] as string | undefined) || null);

export function clientIp(req: IncomingMessage) {
  const fwd = TRUST_PROXY ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
  return fwd || req.socket.remoteAddress || 'unknown';
}
