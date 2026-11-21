// Accounts: screen name + passkeys and/or email & password. Sessions are random tokens; only their hashes are stored.
// Layout: <DATA_DIR>/accounts/users.json, <DATA_DIR>/accounts/sessions.json
import { promises as fs, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DATA_DIR } from './store.ts';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;

export interface Passkey {
  id: string; // credential id, base64url
  publicKey: string; // base64url COSE key
  counter: number;
  transports?: string[];
  created: string;
}
export interface User {
  picture?: string;
  id: string;
  name: string;
  email?: string;
  passwordHash?: string;
  passkeys: Passkey[];
  created: string;
}
interface Session { userId: string; created: string; expires: string }

const DIR = path.join(DATA_DIR, 'accounts');
const USERS = path.join(DIR, 'users.json');
const SESSIONS = path.join(DIR, 'sessions.json');
export const SESSION_DAYS = 30;

function load<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}
const users = new Map<string, User>(Object.entries(load<Record<string, User>>(USERS, {})));
const sessions = new Map<string, Session>(Object.entries(load<Record<string, Session>>(SESSIONS, {})));

let writing = Promise.resolve();
function persist() {
  writing = writing.then(async () => {
    mkdirSync(DIR, { recursive: true });
    for (const [file, map] of [[USERS, users], [SESSIONS, sessions]] as const) {
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
      await fs.rename(tmp, file);
    }
  }).catch((err) => console.error('[brainboard accounts]', err));
  return writing;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('base64url');
export const newUserId = () => crypto.randomBytes(9).toString('base64url');

export const cleanName = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
export const cleanEmail = (s: unknown) => String(s ?? '').trim().toLowerCase().slice(0, 200);
export const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/** What the browser is allowed to see about an account. */
export const publicUser = (u: User) => ({
  id: u.id, name: u.name, picture: u.picture ?? '', email: u.email ?? null, passkeys: u.passkeys.length, hasPassword: !!u.passwordHash,
});

export const getUser = (id: string) => users.get(id) ?? null;
export const userByEmail = (email: string) => [...users.values()].find((u) => u.email === email) ?? null;

export function userByPasskey(credId: string): { user: User; passkey: Passkey } | null {
  for (const user of users.values()) {
    const passkey = user.passkeys.find((p) => p.id === credId);
    if (passkey) return { user, passkey };
  }
  return null;
}

export async function createUser(fields: { id?: string; name: string; email?: string; password?: string; passkey?: Passkey; picture?: string }): Promise<User> {
  const u: User = {
    id: fields.id ?? newUserId(),
    name: cleanName(fields.name) || 'Someone',
    picture: fields.picture || undefined,
    email: fields.email || undefined,
    passwordHash: fields.password ? await hashPassword(fields.password) : undefined,
    passkeys: fields.passkey ? [fields.passkey] : [],
    created: new Date().toISOString(),
  };
  users.set(u.id, u);
  await persist();
  return u;
}

export async function updateUser(id: string, fn: (u: User) => void | Promise<void>) {
  const u = users.get(id);
  if (!u) return null;
  await fn(u);
  await persist();
  return u;
}

// ---------------------------------------------------------------- passwords (scrypt)

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

const DUMMY = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** Constant-ish time: hashes even when there is no such user. */
export async function checkPassword(user: User | null, pw: string): Promise<boolean> {
  const [, s, k] = (user?.passwordHash ?? DUMMY).split('$');
  const key = await scrypt(pw, Buffer.from(s, 'base64url'), 32, SCRYPT);
  const want = Buffer.from(k, 'base64url');
  return !!user?.passwordHash && want.length === key.length && crypto.timingSafeEqual(want, key);
}

// ---------------------------------------------------------------- sessions

export async function createSession(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  sessions.set(sha(token), {
    userId, created: new Date(now).toISOString(), expires: new Date(now + SESSION_DAYS * 86400_000).toISOString(),
  });
  await persist();
  return token;
}

export function sessionUser(token: string | null): User | null {
  if (!token) return null;
  const s = sessions.get(sha(token));
  if (!s) return null;
  if (Date.parse(s.expires) < Date.now()) {
    sessions.delete(sha(token));
    void persist();
    return null;
  }
  return users.get(s.userId) ?? null;
}

export async function endSession(token: string | null) {
  if (token && sessions.delete(sha(token))) await persist();
}

// ---------------------------------------------------------------- simple rate limiting for sign-in attempts

const hits = new Map<string, number[]>();
/** True when `key` has made more than `max` attempts in the last `windowMs`. */
export function limited(key: string, max = 12, windowMs = 10 * 60_000) {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > windowMs) hits.delete(k);
  return list.length > max;
}
