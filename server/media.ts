// Media: screenshots and recordings of boards, kept per person in <DATA_DIR>/media/ (index.json plus <id>.png or
// <id>.mp4 / <id>.webm, and <id>.thumb.png). Each item belongs to the browser or account that took it
// ("anon:<id>" / "user:<id>"), or to this machine (null).
import { promises as fs, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, TRASH_DIR, imageSize, isValidId, newId, type Board } from './store.ts';
import { Resvg } from '@resvg/resvg-js';
import { boardSvg, rasterize, type Theme } from './render.ts';
import type { Box } from '../src/types.ts';

export const MEDIA_DIR = path.join(DATA_DIR, 'media');
const INDEX = path.join(MEDIA_DIR, 'index.json');

/** Backdrops for framed shots: the board sits on these with rounded corners and a soft shadow. */
export const BACKDROPS = ['none', 'aurora', 'sunset', 'ocean', 'mist', 'night'] as const;
export type Backdrop = (typeof BACKDROPS)[number];

/** Recordings arrive from the browser's recorder: MP4 where it can make one, WebM otherwise. */
export const VIDEO_TYPES = { mp4: 'video/mp4', webm: 'video/webm' } as const;
export type VideoExt = keyof typeof VIDEO_TYPES;

export interface MediaItem {
  id: string;
  kind: 'screenshot' | 'recording';
  /** recordings: the file type, and the length in seconds */
  ext?: VideoExt;
  duration?: number;
  name: string;
  owner: string | null;
  board: { id: string; name: string } | null;
  w: number;
  h: number;
  bytes: number;
  backdrop: Backdrop;
  theme: Theme;
  created: string;
}

export interface ShotOpts {
  frame: Box;
  /** output pixels per board unit */
  scale: number;
  theme: Theme;
  /** the canvas dots, spaced as they look at this zoom */
  grid?: { zoom: number };
  backdrop: Backdrop;
}

const MAX_SIDE = 7680;
const MAX_PIXELS = 40e6;
const THUMB_W = 560;

// ---------------------------------------------------------------- rendering

const n = (v: number) => Math.round(v * 100) / 100;

/** Gradient stops and two soft glows per backdrop. */
const LOOKS: Record<Exclude<Backdrop, 'none'>, { stops: string[]; glows: [string, string]; hair: string }> = {
  aurora: { stops: ['#6aa8ff', '#9d8cf5', '#e98bd0', '#ff9a8b'], glows: ['#c9e2ff', '#ffd1e8'], hair: 'rgba(255,255,255,0.35)' },
  sunset: { stops: ['#ffb36b', '#ff7a7a', '#ff5f9e', '#a970f0'], glows: ['#ffe0b8', '#ffc0e0'], hair: 'rgba(255,255,255,0.35)' },
  ocean: { stops: ['#1fc8db', '#2a9df4', '#4f6bff', '#3b2f9e'], glows: ['#b6f3ff', '#8fa6ff'], hair: 'rgba(255,255,255,0.3)' },
  mist: { stops: ['#f7f7f8', '#ececef', '#e2e3e8', '#f3f1f6'], glows: ['#ffffff', '#e4e8f4'], hair: 'rgba(0,0,0,0.08)' },
  night: { stops: ['#1a1a22', '#121218', '#0c0c10', '#17121f'], glows: ['#3a2f66', '#1f3a5a'], hair: 'rgba(255,255,255,0.1)' },
};

/**
 * The soft shadow under a framed shot. A big blur at full size is slow (seconds), so it's drawn at 1/8 size and
 * stretched: a blur looks the same either way.
 */
function shadow(OW: number, OH: number, pad: number, r: number): Buffer {
  const k = 8, w = Math.ceil(OW / k), h = Math.ceil(OH / k);
  const box = `x="${n(pad / k)}" y="${n(pad / k)}" width="${n((OW - pad * 2) / k)}" height="${n((OH - pad * 2) / k)}" rx="${n(r / k)}"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<filter id="a" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${n(pad * 0.32 / k)}"/></filter>` +
    `<filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${n(Math.max(pad * 0.05 / k, 0.6))}"/></filter>` +
    `<rect ${box} fill="#0b0820" fill-opacity="0.34" filter="url(#a)" transform="translate(0 ${n(pad * 0.28 / k)})"/>` +
    `<rect ${box} fill="#000" fill-opacity="0.16" filter="url(#b)" transform="translate(0 ${n(pad * 0.04 / k)})"/>` +
    '</svg>';
  return new Resvg(svg).render().asPng();
}

function framed(inner: string, frame: Box, W: number, H: number, look: Backdrop) {
  const L = LOOKS[look as Exclude<Backdrop, 'none'>];
  const short = Math.min(W, H);
  const pad = Math.round(Math.min(Math.max(short * 0.085, 36), 200));
  const r = Math.round(Math.min(Math.max(short * 0.013, 8), 24));
  const OW = W + pad * 2, OH = H + pad * 2;
  const stops = L.stops.map((c, i) => `<stop offset="${n(i / (L.stops.length - 1))}" stop-color="${c}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OW}" height="${OH}" viewBox="0 0 ${OW} ${OH}">` +
    '<defs>' +
    `<linearGradient id="shot-bg" x1="0" y1="0" x2="1" y2="1">${stops}</linearGradient>` +
    `<radialGradient id="shot-g1" cx="0.18" cy="0.12" r="0.7"><stop offset="0" stop-color="${L.glows[0]}" stop-opacity="0.75"/><stop offset="1" stop-color="${L.glows[0]}" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="shot-g2" cx="0.9" cy="0.95" r="0.65"><stop offset="0" stop-color="${L.glows[1]}" stop-opacity="0.6"/><stop offset="1" stop-color="${L.glows[1]}" stop-opacity="0"/></radialGradient>` +
    `<clipPath id="shot-clip"><rect x="${pad}" y="${pad}" width="${W}" height="${H}" rx="${r}"/></clipPath>` +
    '</defs>' +
    `<rect width="${OW}" height="${OH}" fill="url(#shot-bg)"/>` +
    `<rect width="${OW}" height="${OH}" fill="url(#shot-g1)"/>` +
    `<rect width="${OW}" height="${OH}" fill="url(#shot-g2)"/>` +
    `<image x="0" y="0" width="${OW}" height="${OH}" preserveAspectRatio="none" href="data:image/png;base64,${shadow(OW, OH, pad, r).toString('base64')}"/>` +
    `<g clip-path="url(#shot-clip)"><svg x="${pad}" y="${pad}" width="${W}" height="${H}" viewBox="${n(frame.x)} ${n(frame.y)} ${n(frame.w)} ${n(frame.h)}" preserveAspectRatio="none">${inner}</svg></g>` +
    `<rect x="${n(pad + 0.5)}" y="${n(pad + 0.5)}" width="${W - 1}" height="${H - 1}" rx="${r}" fill="none" stroke="${L.hair}"/>` +
    '</svg>';
  return { svg, w: OW, h: OH };
}

/** Render one area of a board to PNG, plus a small thumbnail. */
export async function renderShot(b: Board, o: ShotOpts, withThumbnail = true): Promise<{ png: Buffer; thumb: Buffer; w: number; h: number }> {
  const r = await boardSvg(b, { theme: o.theme, frame: o.frame, grid: o.grid, background: true });
  if (!r) throw new Error('Nothing to capture');
  let scale = Math.min(Math.max(o.scale, 0.05), 8);
  scale = Math.min(scale, MAX_SIDE / Math.max(o.frame.w, o.frame.h), Math.sqrt(MAX_PIXELS / (o.frame.w * o.frame.h)));
  const W = Math.max(1, Math.round(o.frame.w * scale)), H = Math.max(1, Math.round(o.frame.h * scale));
  let svg = r.svg, w = W, h = H;
  if (o.backdrop !== 'none') {
    const inner = r.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    ({ svg, w, h } = framed(inner, o.frame, W, H, o.backdrop));
  }
  const png = rasterize(svg, w).asPng();
  const thumb = withThumbnail && w > THUMB_W ? rasterize(svg, THUMB_W).asPng() : png;
  return { png, thumb, w, h };
}

// ---------------------------------------------------------------- the index

let items: MediaItem[] | null = null;
let writing: Promise<unknown> = Promise.resolve();

async function load(): Promise<MediaItem[]> {
  if (items) return items;
  mkdirSync(MEDIA_DIR, { recursive: true });
  try {
    const data = JSON.parse(await fs.readFile(INDEX, 'utf8')) as { items?: MediaItem[] };
    items = Array.isArray(data.items) ? data.items.filter((i) => i && isValidId(i.id)) : [];
  } catch {
    items = [];
  }
  return items;
}

/** Serialise index writes so two quick shots can't lose each other. */
function persist() {
  const next = writing.then(async () => {
    const tmp = `${INDEX}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ items }));
    await fs.rename(tmp, INDEX);
  });
  writing = next.catch(() => {});
  return next;
}

/** What the browser sees of an item: not whose key owns it. */
export const publicMedia = ({ owner: _owner, ...rest }: MediaItem) => rest;

export const mediaFile = (id: string, thumb = false, ext: 'png' | VideoExt = 'png') => {
  if (!isValidId(id)) throw new Error('Invalid media id');
  return path.join(MEDIA_DIR, thumb ? `${id}.thumb.png` : `${id}.${ext}`);
};
/** Where an item's own file is: the PNG of a screenshot, or the video of a recording. */
export const itemFile = (it: MediaItem) => mediaFile(it.id, false, it.kind === 'recording' ? it.ext ?? 'webm' : 'png');

export const cleanMediaName = (s: unknown) => String(s ?? '').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

export async function addShot(meta: Omit<MediaItem, 'id' | 'created' | 'bytes' | 'kind'>, png: Buffer, thumb: Buffer): Promise<MediaItem> {
  const list = await load();
  const id = newId();
  await fs.writeFile(mediaFile(id), png);
  await fs.writeFile(mediaFile(id, true), thumb);
  const item: MediaItem = { id, kind: 'screenshot', created: new Date().toISOString(), bytes: png.length, ...meta, name: cleanMediaName(meta.name) || 'Screenshot' };
  list.unshift(item);
  await persist();
  return item;
}

export class MediaUploadError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const isPng = (b: Buffer) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a;
/** Does the file start the way its type says? MP4 has "ftyp" in its first box; WebM opens with the EBML mark. */
const looksLike = (ext: VideoExt, head: Buffer) => head.length >= 12 &&
  (ext === 'mp4' ? head.toString('latin1', 4, 8) === 'ftyp' : head.readUInt32BE(0) === 0x1a45dfa3);

/** Stream the exact capture to disk, publishing it only after the complete file passes validation. */
export async function addCapture(
  meta: Omit<MediaItem, 'id' | 'created' | 'bytes'>, body: AsyncIterable<Buffer>, limit: number,
): Promise<MediaItem> {
  const list = await load();
  const id = newId();
  const ext = meta.kind === 'screenshot' ? 'png' : meta.ext ?? 'webm';
  const file = mediaFile(id, false, ext);
  const tmp = `${file}.part`;
  const out = await fs.open(tmp, 'w');
  const header = Buffer.alloc(ext === 'png' ? 24 : 12);
  let bytes = 0;
  try {
    for await (const chunk of body) {
      if (bytes + chunk.length > limit) throw new MediaUploadError(413, 'Capture is too large for Media. Save it locally instead.');
      if (bytes < header.length) {
        const copied = chunk.copy(header, bytes);
        if (bytes + copied === header.length) {
          if (ext === 'png') {
            const dims = isPng(header) && header.toString('ascii', 12, 16) === 'IHDR' && imageSize(header);
            if (!dims || !dims.w || !dims.h || Math.max(dims.w, dims.h) > MAX_SIDE + 400) {
              throw new MediaUploadError(415, 'Invalid screenshot PNG');
            }
            meta.w = dims.w;
            meta.h = dims.h;
          } else if (!looksLike(ext, header)) throw new MediaUploadError(415, 'Invalid recording format');
        }
      }
      bytes += chunk.length;
      await out.writeFile(chunk);
    }
    if (bytes < header.length) throw new MediaUploadError(400, 'The capture was incomplete');
    await out.close();
    await fs.rename(tmp, file);
  } catch (e) {
    await out.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
  const item: MediaItem = {
    ...meta, id, created: new Date().toISOString(), bytes,
    name: cleanMediaName(meta.name) || (ext === 'png' ? 'Screenshot' : 'Recording'),
  };
  list.unshift(item);
  try {
    await persist();
  } catch (err) {
    const index = list.indexOf(item);
    if (index >= 0) list.splice(index, 1);
    await fs.unlink(file).catch(() => {});
    throw err;
  }
  return item;
}

/** A small PNG preview for a capture uploaded from the browser. */
export async function setPoster(id: string, png: Buffer) {
  if (!isPng(png)) throw new MediaUploadError(415, 'The preview must be a PNG');
  await fs.writeFile(mediaFile(id, true), png);
}

/** How much room one person's recordings take. */
export async function recordingBytes(owner: string | null) {
  return (await load()).reduce((sum, i) => sum + (i.kind === 'recording' && i.owner === owner ? i.bytes : 0), 0);
}

export async function listMedia(visible: (owner: string | null) => boolean): Promise<MediaItem[]> {
  return (await load()).filter((i) => visible(i.owner));
}

export async function getMedia(id: string): Promise<MediaItem | null> {
  return (await load()).find((i) => i.id === id) ?? null;
}

export async function renameMedia(id: string, name: string): Promise<MediaItem | null> {
  const it = await getMedia(id);
  const clean = cleanMediaName(name);
  if (!it || !clean) return it;
  it.name = clean;
  await persist();
  return it;
}

/** Deleted shots and recordings go to the trash folder, like boards. */
export async function trashMedia(id: string) {
  const list = await load();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [it] = list.splice(i, 1);
  await persist();
  const dir = path.join(TRASH_DIR, 'media');
  mkdirSync(dir, { recursive: true });
  const file = itemFile(it);
  await fs.rename(file, path.join(dir, `${id}-${Date.now()}${path.extname(file)}`)).catch(() => {});
  await fs.unlink(mediaFile(id, true)).catch(() => {});
}

/** On sign-in, the browser's shots move into the account along with its boards. */
export async function transferMedia(from: string, to: string) {
  const list = await load();
  let n = 0;
  for (const it of list) if (it.owner === from) { it.owner = to; n++; }
  if (n) await persist();
  return n;
}
