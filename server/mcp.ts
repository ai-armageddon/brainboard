#!/usr/bin/env node
// brainboard MCP server (stdio). Lets AI agents read, see and edit your boards.
// Edits land in ~/.brainboard and show up live in any open brainboard tab.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createBoard, imageSize, listBoards, mimeForExt, putImage, renameBoard, resolveBoard, sniffMime, updateBoard, newId,
} from './store.ts';
import { COLOR_HELP, addItems, boardJson, deleteItems, describeBoard, updateItems, type AddSpec } from './agent.ts';
import { imageForModel, renderBoard } from './render.ts';
import type { ImageItem } from '../src/types.ts';

const server = new McpServer(
  { name: 'brainboard', title: 'Brainboard', version: '0.3.0' },
  {
    instructions: [
      "Brainboard is the user's infinite whiteboard: sticky notes, text, flow-chart shapes (bubble, box, pill, decision) joined by arrows, pasted images and pen drawings.",
      'Your edits appear live in the browser for the user and anyone they have invited.',
      '',
      'How to work with it:',
      '- list_boards, then read_board for an outline with item ids, text, positions and the flow of connections.',
      "- render_board shows a picture of the board, including drawings and images that the outline can't describe. Use show_ids to match what you see to item ids.",
      '- view_image opens a pasted image at full resolution.',
      '- add_items creates many items in one call. Give items a "ref" and connect them with edges ({type:"edge", from, to}). from/to can be refs, existing ids, or the exact text of an existing item. Leave out x/y and items are laid out automatically next to their parent, or to the right of existing content.',
      '- update_items and delete_items change existing things by id.',
      '- Coordinates are canvas units. x grows to the right and y grows down. A bubble is about 170×100 and a sticky note about 200×200.',
      "- Add next to the user's content rather than rearranging it. Only delete what the user asked you to remove.",
    ].join('\n'),
  },
);

const BOARD = z.string().optional().describe('Board id or name. Defaults to the most recently edited board.');

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });
const fail = (err: unknown): CallToolResult => ({ content: [{ type: 'text', text: `Error: ${(err as Error).message ?? String(err)}` }], isError: true });
const guard = <A>(fn: (a: A) => Promise<CallToolResult>) => async (a: A): Promise<CallToolResult> => {
  try { return await fn(a); } catch (err) { return fail(err); }
};

const ItemSpec = z.object({
  type: z.enum(['note', 'text', 'bubble', 'box', 'pill', 'decision', 'edge'])
    .describe('note = sticky note · text = free text · bubble/box/pill/decision = flow-chart shapes · edge = arrow between two items'),
  text: z.string().optional().describe('Content of a note, text or shape'),
  ref: z.string().optional().describe('Your temporary name for this item so edges in this same call can refer to it'),
  from: z.string().optional().describe('edge only: source item (a ref from this call, an item id, or the exact text of an existing item)'),
  to: z.string().optional().describe('edge only: target item (same forms as "from")'),
  label: z.string().optional().describe('edge only: text shown on the arrow'),
  color: z.string().optional().describe(`One of: ${COLOR_HELP}`),
  near: z.string().optional().describe('Place next to this item (ref, id or exact text) instead of automatic placement'),
  size: z.enum(['S', 'M', 'L', 'XL']).optional().describe('text only: font size (default M)'),
  x: z.number().optional().describe('Left edge. Give x and y together, or leave both out for auto-layout'),
  y: z.number().optional().describe('Top edge'),
  w: z.number().optional().describe('Width (optional)'),
  h: z.number().optional().describe('Height (optional)'),
});

server.registerTool('list_boards', {
  title: 'List boards',
  description: 'List all boards with their ids, names, item counts and last-edited time, most recent first.',
  annotations: { readOnlyHint: true },
}, guard(async () => {
  const boards = await listBoards();
  if (!boards.length) return ok('No boards yet. Create one with create_board.');
  return ok(boards.map((b) => `- "${b.name}" · id ${b.id} · ${b.itemCount} items · updated ${b.updated}`).join('\n'));
}));

server.registerTool('read_board', {
  title: 'Read board',
  description: 'Read a board as an outline: every note, text, shape, image and connection with its id and position, plus the flow of connections. Use format "json" for raw item data.',
  inputSchema: { board: BOARD, format: z.enum(['outline', 'json']).optional().describe('Default "outline"') },
  annotations: { readOnlyHint: true },
}, guard(async ({ board, format }) => {
  const b = await resolveBoard(board);
  return ok(format === 'json' ? JSON.stringify(boardJson(b), null, 1) : describeBoard(b));
}));

server.registerTool('render_board', {
  title: 'Render board',
  description: 'Get a PNG picture of the board (or only some items) exactly as laid out: shapes, notes, arrows, images and pen drawings.',
  inputSchema: {
    board: BOARD,
    item_ids: z.array(z.string()).optional().describe('Only render these items (and arrows between them)'),
    show_ids: z.boolean().optional().describe('Overlay item ids so you can refer to what you see'),
    max_size: z.number().optional().describe('Longest side in pixels (default 1600, max 4096)'),
  },
  annotations: { readOnlyHint: true },
}, guard(async ({ board, item_ids, show_ids, max_size }) => {
  const b = await resolveBoard(board);
  const out = await renderBoard(b, { ids: item_ids, showIds: show_ids, maxSize: max_size });
  if (!out) return ok(`"${b.name}" has nothing to draw${item_ids?.length ? ' for those ids' : ''}.`);
  const { box } = out;
  return {
    content: [
      { type: 'image' as const, data: out.png.toString('base64'), mimeType: 'image/png' },
      { type: 'text' as const, text: `"${b.name}": canvas area x ${Math.round(box.x)}…${Math.round(box.x + box.w)}, y ${Math.round(box.y)}…${Math.round(box.y + box.h)}.` },
    ],
  };
}));

server.registerTool('view_image', {
  title: 'View image',
  description: 'Look at an image that was pasted onto a board.',
  inputSchema: { board: BOARD, image_id: z.string().describe('Item id of the image (from read_board)') },
  annotations: { readOnlyHint: true },
}, guard(async ({ board, image_id }) => {
  const b = await resolveBoard(board);
  const it = b.items.find((i) => i.id === image_id);
  if (!it || it.type !== 'image') throw new Error(`No image with id "${image_id}" on "${b.name}".`);
  const img = await imageForModel(it.blob);
  if (!img) throw new Error('The image file is missing.');
  return { content: [{ type: 'image' as const, data: img.data.toString('base64'), mimeType: img.mime }] };
}));

server.registerTool('add_items', {
  title: 'Add items',
  description: 'Add notes, text, flow-chart shapes and arrows in one call. Shapes without x/y are laid out automatically: next to the item they connect from, or beside existing content. Returns the new ids.',
  inputSchema: {
    board: BOARD,
    items: z.array(ItemSpec).min(1).describe('Items to add. Edges may refer to items created earlier in this list by their ref.'),
    direction: z.enum(['right', 'down']).optional().describe('Which way auto-laid-out flows grow (default right)'),
  },
}, guard(async ({ board, items, direction }) => {
  const target = await resolveBoard(board);
  let added: ReturnType<typeof addItems> = [];
  await updateBoard(target.id, (b) => { added = addItems(b, items as AddSpec[], direction); });
  return ok(`Added ${added.length} item${added.length === 1 ? '' : 's'} to "${target.name}":\n` +
    added.map((a) => `- ${a.ref ? `${a.ref} → ` : ''}[${a.id}] ${a.summary}`).join('\n'));
}));

server.registerTool('update_items', {
  title: 'Update items',
  description: 'Change existing items by id: text, arrow labels, color, shape kind, image corners, position (absolute x/y or relative dx/dy) or size. All updates apply together or none do.',
  inputSchema: {
    board: BOARD,
    updates: z.array(z.object({
      id: z.string(),
      text: z.string().optional().describe('New text (notes, text, shapes) or label (arrows)'),
      label: z.string().optional().describe('New arrow label'),
      color: z.string().optional().describe(`One of: ${COLOR_HELP}`),
      shape: z.enum(['bubble', 'box', 'pill', 'decision']).optional(),
      x: z.number().optional(), y: z.number().optional(),
      dx: z.number().optional().describe('Move right by this much (negative = left)'),
      dy: z.number().optional().describe('Move down by this much (negative = up)'),
      w: z.number().optional(), h: z.number().optional(),
      corners: z.enum(['square', 'soft', 'round', 'full']).optional().describe('Image corners from square to fully rounded'),
    })).min(1),
  },
}, guard(async ({ board, updates }) => {
  const target = await resolveBoard(board);
  let done: string[] = [];
  await updateBoard(target.id, (b) => { done = updateItems(b, updates); });
  return ok(`Updated on "${target.name}":\n${done.map((d) => `- ${d}`).join('\n')}`);
}));

server.registerTool('delete_items', {
  title: 'Delete items',
  description: 'Delete items by id. Arrows attached to deleted items are removed too. Only delete what the user asked to remove.',
  inputSchema: { board: BOARD, item_ids: z.array(z.string()).min(1) },
  annotations: { destructiveHint: true },
}, guard(async ({ board, item_ids }) => {
  const target = await resolveBoard(board);
  let r = { removed: 0, edges: 0 };
  await updateBoard(target.id, (b) => { r = deleteItems(b, item_ids); });
  return ok(`Deleted ${r.removed} item${r.removed === 1 ? '' : 's'}${r.edges ? ` and ${r.edges} attached arrow${r.edges === 1 ? '' : 's'}` : ''} from "${target.name}". The user can undo this in the app.`);
}));

server.registerTool('add_image', {
  title: 'Add image',
  description: 'Put an image on a board from a local file path, a URL, or base64 data.',
  inputSchema: {
    board: BOARD,
    path: z.string().optional().describe('Local file path (~ allowed)'),
    url: z.string().optional().describe('http(s) URL to download'),
    data_base64: z.string().optional(),
    mime_type: z.string().optional().describe('For data_base64, e.g. image/png'),
    x: z.number().optional(), y: z.number().optional(),
    width: z.number().optional().describe('Display width on the canvas (default: up to 520)'),
    near: z.string().optional().describe('Place next to this item id instead of beside existing content'),
  },
}, guard(async (a) => {
  let buf: Buffer;
  let mime: string | null = null;
  if (a.path) {
    const p = path.resolve(a.path.replace(/^~(?=$|\/)/, os.homedir()));
    buf = await fs.readFile(p);
    mime = mimeForExt(path.extname(p));
  } else if (a.url) {
    const res = await fetch(a.url);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    mime = res.headers.get('content-type')?.split(';')[0] ?? null;
  } else if (a.data_base64) {
    buf = Buffer.from(a.data_base64, 'base64');
    mime = a.mime_type ?? null;
  } else throw new Error('Give one of path, url or data_base64.');
  mime = sniffMime(buf) ?? mime;
  if (!mime) throw new Error('That does not look like an image.');
  const blob = await putImage(buf, mime);
  const dims = imageSize(buf) ?? { w: 800, h: 600 };
  const w = a.width ?? Math.min(520, dims.w);
  const h = (w * dims.h) / dims.w;

  const target = await resolveBoard(a.board);
  let summary = '';
  await updateBoard(target.id, (b) => {
    // Reuse the auto-layout by placing a stand-in note of the same size, then swapping in the image.
    const hasPos = typeof a.x === 'number' && typeof a.y === 'number';
    const [placed] = addItems(b, [{ type: 'note', text: '', w, h, x: a.x, y: a.y, near: hasPos ? undefined : a.near }]);
    const i = b.items.findIndex((it) => it.id === placed.id);
    const stub = b.items[i];
    const img: ImageItem = { id: newId(), type: 'image', blob, x: stub.type === 'edge' ? 0 : stub.x, y: stub.type === 'edge' ? 0 : stub.y, w, h };
    b.items[i] = img;
    summary = `[${img.id}] image ${Math.round(w)}×${Math.round(h)} at (${Math.round(img.x)}, ${Math.round(img.y)})`;
  });
  return ok(`Added to "${target.name}": ${summary}`);
}));

server.registerTool('create_board', {
  title: 'Create board',
  description: 'Create a new board, optionally filled with items in the same format as add_items.',
  inputSchema: {
    name: z.string(),
    items: z.array(ItemSpec).optional(),
    direction: z.enum(['right', 'down']).optional(),
  },
}, guard(async ({ name, items, direction }) => {
  const b = await createBoard(name);
  let added: ReturnType<typeof addItems> = [];
  if (items?.length) await updateBoard(b.id, (bb) => { added = addItems(bb, items as AddSpec[], direction); });
  return ok(`Created "${b.name}" (id ${b.id})${added.length ? ` with ${added.length} items:\n${added.map((x) => `- ${x.ref ? `${x.ref} → ` : ''}[${x.id}] ${x.summary}`).join('\n')}` : '.'}\nIt is open at http://localhost:5317/#${b.id} while the app is running.`);
}));

server.registerTool('rename_board', {
  title: 'Rename board',
  description: 'Rename a board.',
  inputSchema: { board: z.string().describe('Board id or current name'), name: z.string() },
}, guard(async ({ board, name }) => {
  const b = await resolveBoard(board);
  const m = await renameBoard(b.id, name);
  return ok(`Renamed "${b.name}" to "${m.name}".`);
}));

await server.connect(new StdioServerTransport());
console.error('brainboard MCP server ready');
