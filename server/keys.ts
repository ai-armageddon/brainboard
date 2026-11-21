// Personal access keys for connecting AI chat apps (ChatGPT, Claude, Codex…) to your boards over MCP.
// A key acts as the browser or account that made it: it sees only that person's boards and boards shared with them.
// Only a hash of each key is stored. Layout: <DATA_DIR>/accounts/mcp-keys.json
import { promises as fs, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './store.ts';

export interface AccessKey {
  id: string;
  hash: string;
  /** "user:<id>" or "anon:<id>"; null for a key made on this machine without a browser identity */
  owner: string | null;
  /** made from this machine (local mode): also sees boards with no owner */
  local: boolean;
  name: string;
  /** first characters, so people can tell keys apart */
  hint: string;
  /** OAuth grants are restricted to one board and one MCP resource. */
  grant?: { boardId: string; clientId: string; resource: string; expires: number; refreshHash: string; refreshUntil: number };
  created: string;
  used: string | null;
}

const DIR = path.join(DATA_DIR, 'accounts');
const FILE = path.join(DIR, 'mcp-keys.json');
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('base64url');

const keys: AccessKey[] = (() => {
  try { return JSON.parse(readFileSync(FILE, 'utf8')) as AccessKey[]; } catch { return []; }
})();

let writing = Promise.resolve();
function persist() {
  writing = writing.then(async () => {
    mkdirSync(DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(keys, null, 1), { mode: 0o600 });
    await fs.rename(tmp, FILE);
  }).catch((err) => console.error('[brainboard keys]', err));
  return writing;
}

export const KEY_RE = /^bb_[A-Za-z0-9_-]{32,64}$/;
const mine = (k: AccessKey, owner: string | null, local: boolean) => (owner ? k.owner === owner : local && k.local && !k.owner);

export const publicKey = (k: AccessKey) => ({ id: k.id, name: k.name, hint: k.hint, created: k.created, used: k.used, boardId: k.grant?.boardId, expired: k.grant ? k.grant.refreshUntil <= Date.now() : undefined });

export function listKeys(owner: string | null, local: boolean) {
  return keys.filter((k) => mine(k, owner, local));
}

/** Returns the secret once; it can't be shown again. */
export async function createKey(owner: string | null, local: boolean, name: string, grant?: AccessKey['grant']): Promise<{ key: AccessKey; secret: string }> {
  if (listKeys(owner, local).length >= 20) throw new Error('You already have 20 keys. Delete one first.');
  const secret = `bb_${crypto.randomBytes(24).toString('base64url')}`;
  const key: AccessKey = {
    id: crypto.randomBytes(6).toString('hex'),
    hash: sha(secret),
    owner,
    local,
    name: String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'AI connection',
    hint: secret.slice(0, 7),
    created: new Date().toISOString(),
    used: null, grant,
  };
  keys.push(key);
  await persist();
  return { key, secret };
}

export async function deleteKey(owner: string | null, local: boolean, id: string): Promise<boolean> {
  const i = keys.findIndex((k) => k.id === id && mine(k, owner, local));
  if (i < 0) return false;
  keys.splice(i, 1);
  await persist();
  return true;
}

export function findKey(secret: string): AccessKey | null {
  if (!KEY_RE.test(secret)) return null;
  const h = Buffer.from(sha(secret));
  return keys.find((k) => {
    const x = Buffer.from(k.hash);
    return (!k.grant || k.grant.expires > Date.now()) && x.length === h.length && crypto.timingSafeEqual(x, h);
  }) ?? null;
}

let lastSave = 0;
export function touchKey(k: AccessKey) {
  k.used = new Date().toISOString();
  if (Date.now() - lastSave > 60_000) { lastSave = Date.now(); void persist(); }
}

/** An anonymous browser signed in: its keys follow it into the account. */
export async function transferKeys(from: string, to: string) {
  let n = 0;
  for (const k of keys) if (k.owner === from) { k.owner = to; n++; }
  if (n) await persist();
}

export async function issueBoardGrant(owner: string, local: boolean, provider: string, clientId: string, resource: string, boardId: string) {
  const refresh = crypto.randomBytes(32).toString('base64url');
  const { secret } = await createKey(owner, local, provider, { boardId, clientId, resource, expires: Date.now() + 3600_000,
    refreshHash: sha(refresh), refreshUntil: Date.now() + 30 * 86400_000 });
  return { token_type: 'Bearer', access_token: secret, refresh_token: refresh, expires_in: 3600, scope: 'board' };
}

export async function refreshBoardGrant(clientId: string, resource: string, refresh: string) {
  const hash = sha(refresh);
  const key = keys.find(k => k.grant?.refreshHash === hash);
  const grant = key?.grant;
  if (!key || !grant || grant.clientId !== clientId || grant.resource !== resource || grant.refreshUntil <= Date.now()) return null;
  const next = crypto.randomBytes(32).toString('base64url');
  const access = `bb_${crypto.randomBytes(24).toString('base64url')}`;
  key.hash = sha(access);
  grant.refreshHash = sha(next);
  grant.expires = Date.now() + 3600_000;
  await persist();
  return { token_type: 'Bearer', access_token: access, refresh_token: next, expires_in: 3600, scope: 'board' };
}

export async function chooseGrantBoard(owner: string | null, local: boolean, id: string, boardId: string) {
  const key = listKeys(owner, local).find(k => k.id === id);
  if (!key?.grant) return false;
  key.grant.boardId = boardId;
  await persist();
  return true;
}
