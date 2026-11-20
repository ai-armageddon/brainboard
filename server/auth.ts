// Who is making this request?
//  - The owner: a request from this machine to localhost, or anyone holding the owner cookie.
//  - A guest: anyone presenting an invite token for a board.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { DATA_DIR } from './store.ts';

export type Identity = { owner: true } | { owner: false; token: string };

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

/** Direct request from this machine (not relayed through a tunnel or proxy). */
export function isLocalRequest(req: IncomingMessage) {
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

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function isOwner(req: IncomingMessage) {
  if (isLocalRequest(req)) return true;
  const c = cookie(req, 'bb_owner');
  return !!c && safeEqual(c, ownerSecret());
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

export function identify(req: IncomingMessage, url: URL): Identity | null {
  if (isOwner(req)) return { owner: true };
  const token = url.searchParams.get('invite') ?? (req.headers['x-invite'] as string | undefined);
  return token ? { owner: false, token } : null;
}
