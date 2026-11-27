// File-backed board storage shared by the web server and the MCP server.
// Layout:  <DATA_DIR>/boards/<id>.json   <DATA_DIR>/images/<id>.<ext>   <DATA_DIR>/trash/
import { promises as fs, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Item } from '../src/types.ts';
import type { BoardView } from '../src/protocol.ts';

export const DATA_DIR = process.env.BRAINBOARD_DIR
  ? path.resolve(process.env.BRAINBOARD_DIR.replace(/^~(?=$|\/)/, os.homedir()))
  : path.join(os.homedir(), '.brainboard');
export const BOARDS_DIR = path.join(DATA_DIR, 'boards');
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
export const TRASH_DIR = path.join(DATA_DIR, 'trash');

export function ensureDirs() {
  for (const d of [BOARDS_DIR, IMAGES_DIR, TRASH_DIR]) mkdirSync(d, { recursive: true });
}

export interface Board {
  id: string;
  name: string;
  rev: number;
  created: string;
  updated: string;
  items: Item[];
  /** named areas people can jump between */
  views?: BoardView[];
}
export interface BoardMeta {
  id: string;
  name: string;
  rev: number;
  created: string;
  updated: string;
  itemCount: number;
}

export class NotFoundError extends Error {}

export const newId = () => crypto.randomBytes(8).toString('hex').slice(0, 11);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isValidId = (id: string) => ID_RE.test(id);

function boardPath(id: string) {
  if (!isValidId(id)) throw new NotFoundError(`Invalid board id "${id}"`);
  return path.join(BOARDS_DIR, `${id}.json`);
}

async function writeAtomic(file: string, data: string | Buffer) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

export async function readBoard(id: string): Promise<Board | null> {
  try {
    return JSON.parse(await fs.readFile(boardPath(id), 'utf8')) as Board;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof NotFoundError) return null;
    throw err;
  }
}

export async function mustReadBoard(id: string): Promise<Board> {
  const b = await readBoard(id);
  if (!b) throw new NotFoundError(`No board with id "${id}"`);
  return b;
}

export async function writeBoard(b: Board) {
  b.updated = new Date().toISOString();
  await writeAtomic(boardPath(b.id), JSON.stringify(b));
}

export const metaOf = (b: Board): BoardMeta => ({
  id: b.id, name: b.name, rev: b.rev, created: b.created, updated: b.updated, itemCount: b.items.length,
});

export async function listBoardIds() {
  ensureDirs();
  return (await fs.readdir(BOARDS_DIR)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).filter(isValidId);
}

export async function listBoards(): Promise<BoardMeta[]> {
  const out: BoardMeta[] = [];
  for (const id of await listBoardIds()) {
    const b = await readBoard(id).catch(() => null);
    if (b) out.push(metaOf(b));
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated));
}

export async function createBoard(name: string, items: Item[] = []): Promise<Board> {
  ensureDirs();
  const now = new Date().toISOString();
  const b: Board = { id: newId(), name: name.trim() || 'Untitled board', rev: 1, created: now, updated: now, items };
  await writeBoard(b);
  return b;
}

/** Read-modify-write a board, bumping its revision. */
export async function updateBoard(id: string, fn: (b: Board) => void | Promise<void>): Promise<Board> {
  const b = await mustReadBoard(id);
  await fn(b);
  b.rev++;
  await writeBoard(b);
  return b;
}

/** Optimistic save from the web app: only succeeds if nobody else wrote since `baseRev`. */
export async function saveItems(id: string, items: Item[], baseRev: number): Promise<{ ok: boolean; board: Board }> {
  const b = await mustReadBoard(id);
  if (b.rev !== baseRev) return { ok: false, board: b };
  b.items = items;
  b.rev++;
  await writeBoard(b);
  return { ok: true, board: b };
}

export async function renameBoard(id: string, name: string) {
  return updateBoard(id, (b) => { b.name = name.trim() || b.name; });
}

/** Boards are never hard-deleted: they move to the trash folder. */
export async function trashBoard(id: string) {
  ensureDirs();
  await fs.rename(boardPath(id), path.join(TRASH_DIR, `${id}-${Date.now()}.json`));
}

/** Find a board by id, exact name, or unambiguous partial name. */
export async function resolveBoard(ref: string | undefined): Promise<Board> {
  const boards = await listBoards();
  if (!boards.length) throw new NotFoundError('There are no boards yet. Create one with create_board.');
  if (!ref) return mustReadBoard(boards[0].id); // most recently updated
  const r = ref.trim().toLowerCase();
  const hit =
    boards.find((b) => b.id === ref) ??
    boards.find((b) => b.name.toLowerCase() === r) ??
    (() => {
      const partial = boards.filter((b) => b.name.toLowerCase().includes(r));
      return partial.length === 1 ? partial[0] : undefined;
    })();
  if (!hit) {
    throw new NotFoundError(
      `No board matches "${ref}". Boards: ${boards.map((b) => `"${b.name}" (${b.id})`).join(', ')}`,
    );
  }
  return mustReadBoard(hit.id);
}

// ------------------------------------------------------------------ images

export const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp',
};
const EXT_MIME = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]));
EXT_MIME.jpeg = 'image/jpeg';

export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 2).toString('latin1') === 'BM') return 'image/bmp';
  if (buf.subarray(4, 12).toString('latin1').startsWith('ftypavi')) return 'image/avif';
  const head = buf.subarray(0, 512).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

export const mimeForExt = (ext: string) => EXT_MIME[ext.toLowerCase().replace(/^\./, '')] ?? null;

export async function putImage(buf: Buffer, mime: string | null, id = newId()): Promise<string> {
  ensureDirs();
  if (!isValidId(id)) throw new Error('Invalid image id');
  const type = (mime && MIME_EXT[mime] ? mime : null) ?? sniffMime(buf);
  if (!type) throw new Error('Unsupported image type');
  await writeAtomic(path.join(IMAGES_DIR, `${id}.${MIME_EXT[type]}`), buf);
  return id;
}

export async function findImage(id: string): Promise<{ file: string; mime: string } | null> {
  if (!isValidId(id)) return null;
  for (const [mime, ext] of Object.entries(MIME_EXT)) {
    const file = path.join(IMAGES_DIR, `${id}.${ext}`);
    try {
      await fs.access(file);
      return { file, mime };
    } catch { /* try next */ }
  }
  return null;
}

export async function readImage(id: string): Promise<{ buf: Buffer; mime: string } | null> {
  const f = await findImage(id);
  return f ? { buf: await fs.readFile(f.file), mime: f.mime } : null;
}

/** Width/height from image headers (PNG, JPEG, GIF, WebP). */
export function imageSize(buf: Buffer): { w: number; h: number } | null {
  const mime = sniffMime(buf);
  try {
    if (mime === 'image/png') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (mime === 'image/gif') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (mime === 'image/webp') {
      const kind = buf.subarray(12, 16).toString('latin1');
      if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
      }
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch { /* fall through */ }
  return null;
}

/** Remove image files no board references (boards in the trash keep theirs). */
export async function gcImages() {
  ensureDirs();
  const used = new Set<string>();
  for (const dir of [BOARDS_DIR, TRASH_DIR]) {
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const b = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as Board;
        for (const it of b.items) if (it.type === 'image') used.add(it.blob);
      } catch { /* ignore */ }
    }
  }
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  for (const f of await fs.readdir(IMAGES_DIR)) {
    const id = f.replace(/\.[^.]+$/, '');
    if (used.has(id)) continue;
    const file = path.join(IMAGES_DIR, f);
    // keep recent uploads: undo history in an open tab may still point at them
    const st = await fs.stat(file).catch(() => null);
    if (st && st.mtimeMs < dayAgo) await fs.unlink(file).catch(() => {});
  }
}
