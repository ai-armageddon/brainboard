// Per-board sharing: invite links (with roles) and live-session settings.
import { promises as fs, mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, isValidId } from './store.ts';
import { DEFAULT_SETTINGS, type BoardSettings } from '../src/protocol.ts';

export type InviteRole = 'editor' | 'viewer';
export interface Invite {
  token: string;
  role: InviteRole;
  label: string;
  /** who the link is for, if the owner said; prefilled on the join screen */
  name?: string;
  /** the inviter's screen name, shown on the join screen */
  from?: string;
  /** who last used the link and when they were last here (for the owner's People list) */
  seen?: { name: string; at: string };
  created: string;
}
export interface Sharing {
  /** "user:<id>" or "anon:<id>"; missing for boards that belong to this machine (older boards, MCP-made boards) */
  owner?: string;
  invites: Invite[];
  settings: BoardSettings;
}

const DIR = path.join(DATA_DIR, 'sharing');
const cache = new Map<string, Sharing>();

const file = (boardId: string) => {
  if (!isValidId(boardId)) throw new Error('Invalid board id');
  return path.join(DIR, `${boardId}.json`);
};

export async function getSharing(boardId: string): Promise<Sharing> {
  const hit = cache.get(boardId);
  if (hit) return hit;
  let s: Sharing = { invites: [], settings: { ...DEFAULT_SETTINGS } };
  try {
    const raw = JSON.parse(await fs.readFile(file(boardId), 'utf8')) as Partial<Sharing>;
    s = { owner: raw.owner, invites: raw.invites ?? [], settings: { ...DEFAULT_SETTINGS, ...raw.settings } };
  } catch { /* none yet */ }
  cache.set(boardId, s);
  return s;
}

async function save(boardId: string, s: Sharing) {
  mkdirSync(DIR, { recursive: true });
  cache.set(boardId, s);
  const tmp = `${file(boardId)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2));
  await fs.rename(tmp, file(boardId));
}

export async function getOwner(boardId: string): Promise<string | null> {
  return (await getSharing(boardId)).owner ?? null;
}

export async function setOwner(boardId: string, owner: string) {
  const s = await getSharing(boardId);
  s.owner = owner;
  await save(boardId, s);
}

/** Move every board owned by `from` to `to` (an anonymous browser signing in). Returns how many moved. */
export async function transferOwnership(from: string, to: string): Promise<number> {
  let files: string[] = [];
  try { files = await fs.readdir(DIR); } catch { return 0; }
  let n = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    if ((await getOwner(id)) === from) { await setOwner(id, to); n++; }
  }
  return n;
}

const cleanPerson = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

export async function createInvite(boardId: string, role: InviteRole, label: string, from = ''): Promise<Invite> {
  const s = await getSharing(boardId);
  const name = cleanPerson(label);
  const inv: Invite = {
    token: crypto.randomBytes(18).toString('base64url'),
    role,
    label: label.trim().slice(0, 60) || (role === 'editor' ? 'Can edit' : 'Can view'),
    ...(name ? { name } : {}),
    ...(cleanPerson(from) ? { from: cleanPerson(from) } : {}),
    created: new Date().toISOString(),
  };
  s.invites.push(inv);
  await save(boardId, s);
  return inv;
}

export async function updateInvite(boardId: string, token: string, patch: { role?: InviteRole; label?: string }) {
  const s = await getSharing(boardId);
  const inv = s.invites.find((i) => i.token === token);
  if (!inv) return null;
  if (patch.role === 'editor' || patch.role === 'viewer') inv.role = patch.role;
  if (typeof patch.label === 'string') {
    inv.label = patch.label.trim().slice(0, 60) || inv.label;
    if (cleanPerson(patch.label)) inv.name = cleanPerson(patch.label);
  }
  await save(boardId, s);
  return inv;
}

export async function revokeInvite(boardId: string, token: string) {
  const s = await getSharing(boardId);
  s.invites = s.invites.filter((i) => i.token !== token);
  await save(boardId, s);
}

/** Remember who used a link and when, so the owner can tell their links apart. */
export async function noteInviteUse(boardId: string, token: string, name: string) {
  const s = await getSharing(boardId);
  const inv = s.invites.find((i) => i.token === token);
  if (!inv) return;
  inv.seen = { name: cleanPerson(name) || inv.seen?.name || inv.name || 'Guest', at: new Date().toISOString() };
  await save(boardId, s);
}

export async function setSettings(boardId: string, patch: Partial<BoardSettings>): Promise<BoardSettings> {
  const s = await getSharing(boardId);
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof BoardSettings)[]) {
    if (typeof patch[k] === 'boolean') s.settings[k] = patch[k]!;
  }
  await save(boardId, s);
  return s.settings;
}

export async function findInvite(boardId: string, token: string): Promise<Invite | null> {
  return (await getSharing(boardId)).invites.find((i) => i.token === token) ?? null;
}

export async function inviteRole(boardId: string, token: string): Promise<InviteRole | null> {
  const s = await getSharing(boardId);
  return s.invites.find((i) => i.token === token)?.role ?? null;
}

/** Any board this invite token belongs to (used to authorise image reads). */
export async function tokenBoards(token: string): Promise<{ boardId: string; role: InviteRole }[]> {
  const out: { boardId: string; role: InviteRole }[] = [];
  let files: string[] = [];
  try { files = await fs.readdir(DIR); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    const role = await inviteRole(id, token);
    if (role) out.push({ boardId: id, role });
  }
  return out;
}
