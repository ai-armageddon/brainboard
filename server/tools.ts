// The MCP tools, shared by the local stdio server (server/mcp.ts: every board on this machine) and the hosted
// endpoint (server/remote-mcp.ts: only the boards a personal access key may see).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { imageSize, newId, putImage, sniffMime, NotFoundError, type Board, type BoardMeta } from './store.ts';
import { COLOR_HELP, addItems, boardJson, deleteItems, describeBoard, isEdge, isNode, kindName, shortLabel, updateItems, type AddSpec } from './agent.ts';
import { imageForModel, renderBoard } from './render.ts';
import { intersects } from '../src/geometry.ts';
import type { ImageItem, Item } from '../src/types.ts';
import type { Role } from '../src/protocol.ts';
import type { Screen } from './realtime.ts';

export type Rect = { x: number; y: number; w: number; h: number };

/** What a caller may do. Every board lookup goes through here, so scoping happens in one place. */
export interface BoardAccess {
  /** boards this caller can open, most recently edited first */
  list(): Promise<(BoardMeta & { role: Role; from?: string | null })[]>;
  /** read a board by id or name (default: see `defaultHelp`) */
  open(ref?: string): Promise<Board>;
  /** change a board; `fn` gets the live board and, if the user is looking at it, where new things should go */
  edit(ref: string | undefined, fn: (b: Board, anchor?: { x: number; y: number }) => void, opts?: { ownerOnly?: boolean }): Promise<Board>;
  create(name: string): Promise<Board>;
  link(boardId: string): string;
  /** what "no board given" means, for tool descriptions */
  defaultHelp: string;
  /** the user's open tabs (hosted / app-backed only) */
  screens?(): Promise<Screen[]>;
  /** add_image: read a local file (only for the local stdio server) */
  readFile?(p: string): Promise<{ buf: Buffer; mime: string | null }>;
  fetchImage(url: string): Promise<{ buf: Buffer; mime: string | null }>;
}

export function instructions(a: BoardAccess) {
  return [
    "Brainboard is the user's infinite whiteboard: sticky notes, text, flow-chart shapes (bubble, box, pill, decision) joined by arrows, pasted images and pen drawings.",
    'Your edits appear live in the browser for the user and anyone they have invited.',
    '',
    'How to work with it:',
    ...(a.screens ? [
      '- current_context first: which board the user has open, the area on their screen, what they have selected or are editing, and who else is there. When they say "this", "here" or "what I\'m looking at", that is what they mean.',
    ] : []),
    '- list_boards, then read_board for an outline with item ids, text, positions and the flow of connections.',
    "- render_board shows a picture of the board, including drawings and images that the outline can't describe. Use show_ids to match what you see to item ids.",
    '- view_image opens a pasted image at full resolution.',
    '- add_items creates many items in one call. Give items a "ref" and connect them with edges ({type:"edge", from, to}). from/to can be refs, existing ids, or the exact text of an existing item. Leave out x/y and items are laid out automatically: next to their parent, ' +
      (a.screens ? "or in the area the user is looking at (beside existing content if they don't have the board open)." : 'or to the right of existing content.'),
    '- update_items and delete_items change existing things by id.',
    '- Coordinates are canvas units. x grows to the right and y grows down. A bubble is about 170×100 and a sticky note about 200×200.',
    "- Add next to the user's content rather than rearranging it. Only delete what the user asked you to remove.",
  ].join('\n');
}

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });
const fail = (err: unknown): CallToolResult => ({ content: [{ type: 'text', text: `Error: ${(err as Error).message ?? String(err)}` }], isError: true });
const guard = <A>(fn: (a: A) => Promise<CallToolResult>) => async (a: A): Promise<CallToolResult> => {
  try { return await fn(a); } catch (err) { return fail(err); }
};

/** Find a board by id, exact name, or unambiguous partial name, among the ones given. */
export function pickBoard<T extends BoardMeta>(boards: T[], ref: string): T {
  const r = ref.trim().toLowerCase();
  const hit =
    boards.find((b) => b.id === ref.trim()) ??
    boards.find((b) => b.name.toLowerCase() === r) ??
    (() => {
      const partial = boards.filter((b) => b.name.toLowerCase().includes(r));
      return partial.length === 1 ? partial[0] : undefined;
    })();
  if (!hit) {
    throw new NotFoundError(boards.length
      ? `No board matches "${ref}". Boards: ${boards.slice(0, 30).map((b) => `"${b.name}" (${b.id})`).join(', ')}`
      : 'There are no boards yet. Create one with create_board.');
  }
  return hit;
}

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

const MAX_IMAGE = 20 * 1024 * 1024;
const r = Math.round;
const ago = (ms: number) => (ms < 60_000 ? `${Math.max(1, r(ms / 1000))}s ago` : ms < 3600_000 ? `${r(ms / 60_000)} min ago` : `${r(ms / 3600_000)} h ago`);
const rectText = (v: Rect) => `x ${r(v.x)}…${r(v.x + v.w)}, y ${r(v.y)}…${r(v.y + v.h)}`;
const centre = (v: Rect) => ({ x: v.x + v.w / 2, y: v.y + v.h / 2 });
const inside = (p: { x: number; y: number }, v: Rect) => p.x >= v.x && p.x <= v.x + v.w && p.y >= v.y && p.y <= v.y + v.h;

/** The saved view the screen is in: the smallest one containing its centre. */
function viewName(b: Board, v: Rect): string | null {
  const c = centre(v);
  const hits = (b.views ?? []).filter((x) => inside(c, x)).sort((a, z) => a.w * a.h - z.w * z.h);
  return hits[0]?.name ?? null;
}

/** Items whose box overlaps the screen. */
const onScreen = (b: Board, v: Rect) => b.items.filter(isNode).filter((n) => intersects(v, n));

function describeScreen(s: Screen, link: string): string {
  const b = s.board;
  const byId = new Map<string, Item>(b.items.map((i) => [i.id, i]));
  const L: string[] = [];
  L.push(`## "${b.name}" (board id ${b.id}) · ${s.role === 'owner' ? 'their board' : `shared with them, they can ${s.role === 'viewer' ? 'only view' : 'edit'}`} · last active ${ago(s.idle)}`);
  L.push(`Link: ${link}`);
  if (s.view) {
    const vn = viewName(b, s.view);
    L.push(`Looking at: ${rectText(s.view)} (canvas units)${vn ? `, in the saved view "${vn}"` : ''}`);
  }
  if (s.cursor) L.push(`Pointer at (${r(s.cursor.x)}, ${r(s.cursor.y)})`);
  if (s.editing) L.push(`Typing in: [${s.editing}] ${kindName(byId.get(s.editing) ?? ({ type: 'text' } as Item))} ${shortLabel(byId.get(s.editing))}`);
  const sel = s.sel.map((id) => byId.get(id)).filter((i): i is Item => !!i);
  if (sel.length) {
    L.push(`Selected (${sel.length}):`);
    for (const it of sel.slice(0, 40)) L.push(`- [${it.id}] ${kindName(it)} ${shortLabel(it)}`);
    if (sel.length > 40) L.push(`- …and ${sel.length - 40} more`);
  } else L.push('Nothing selected.');
  if (s.presenter) L.push(`${s.presenter} is presenting, so the user is probably following their screen.`);
  if (s.presenting) L.push('The user is presenting: everyone else follows their screen.');
  if (s.others.length) {
    L.push(`Also here: ${s.others.map((o) => {
      const where = o.view && s.view ? (intersects(o.view, s.view) ? 'looking at the same area' : 'looking elsewhere') : '';
      return `${o.name} (${o.role}${where ? `, ${where}` : ''})`;
    }).join(', ')}`);
  } else L.push('Nobody else is on this board.');
  if (s.view) {
    const vis = onScreen(b, s.view);
    const ids = new Set(vis.map((n) => n.id));
    L.push('', `On screen (${vis.length} item${vis.length === 1 ? '' : 's'}):`);
    if (!vis.length) L.push('(empty area: a good place to add things)');
    for (const n of vis.slice(0, 80)) L.push(`- [${n.id}] ${kindName(n)} ${shortLabel(n)} at (${r(n.x)}, ${r(n.y)}) ${r(n.w)}×${r(n.h)}`);
    if (vis.length > 80) L.push(`- …and ${vis.length - 80} more (read_board has everything)`);
    const edges = b.items.filter(isEdge).filter((e) => ids.has(e.from) && ids.has(e.to));
    if (edges.length) {
      L.push('Connections on screen:');
      for (const e of edges.slice(0, 60)) L.push(`- ${shortLabel(byId.get(e.from))} → ${shortLabel(byId.get(e.to))}${e.label ? ` (${JSON.stringify(e.label)})` : ''}`);
    }
  }
  return L.join('\n');
}

export function registerBoardTools(server: McpServer, a: BoardAccess) {
  const BOARD = z.string().optional().describe(`Board id or name. ${a.defaultHelp}`);

  if (a.screens) {
    server.registerTool('current_context', {
      title: 'What the user is doing',
      description: 'See what the user is doing in Brainboard right now: which boards they have open, the area on their screen (with the items in it), what they have selected or are typing in, which saved view they are in, and who else is on the board. Call this first, and whenever they say "this", "here", "these" or "what I\'m looking at".',
      inputSchema: {
        include_picture: z.boolean().optional().describe('Also return a picture of what is on their screen'),
      },
      annotations: { readOnlyHint: true },
    }, guard(async ({ include_picture }) => {
      const screens = await a.screens!();
      if (!screens.length) {
        const recent = (await a.list()).slice(0, 5);
        return ok([
          "The user doesn't have Brainboard open right now (or isn't signed in to the same account in that browser).",
          recent.length ? `Their most recently edited boards:\n${recent.map((b) => `- "${b.name}" · id ${b.id} · ${b.itemCount} items · ${b.role}`).join('\n')}` : 'They have no boards yet.',
          'Tools that take a board use the most recently edited one when none is given.',
        ].join('\n\n'));
      }
      // One entry per board; the most recent tab wins.
      const seen = new Set<string>();
      const uniq = screens.filter((s) => !seen.has(s.boardId) && seen.add(s.boardId));
      const text = `The user has ${uniq.length} board${uniq.length === 1 ? '' : 's'} open (most recently active first). Tools that take a board default to the first one.\n\n` +
        uniq.map((s) => describeScreen(s, a.link(s.boardId))).join('\n\n');
      const content: CallToolResult['content'] = [{ type: 'text', text }];
      const top = uniq[0];
      if (include_picture && top.view) {
        const ids = onScreen(top.board, top.view).map((n) => n.id);
        const out = ids.length ? await renderBoard(top.board, { ids, maxSize: 1400 }) : null;
        if (out) content.push({ type: 'image', data: out.png.toString('base64'), mimeType: 'image/png' });
      }
      return { content };
    }));
  }

  server.registerTool('list_boards', {
    title: 'List boards',
    description: 'List the boards you can open, with ids, names, item counts, last-edited time and your access, most recent first.',
    annotations: { readOnlyHint: true },
  }, guard(async () => {
    const boards = await a.list();
    if (!boards.length) return ok('No boards yet. Create one with create_board.');
    return ok(boards.map((b) => `- "${b.name}" · id ${b.id} · ${b.itemCount} items · updated ${b.updated}${b.role === 'owner' ? '' : ` · shared with you${b.from ? ` by ${b.from}` : ''} (${b.role === 'viewer' ? 'view only' : 'can edit'})`}`).join('\n'));
  }));

  server.registerTool('read_board', {
    title: 'Read board',
    description: 'Read a board as an outline: every note, text, shape, image and connection with its id and position, plus the flow of connections. Use format "json" for raw item data.',
    inputSchema: { board: BOARD, format: z.enum(['outline', 'json']).optional().describe('Default "outline"') },
    annotations: { readOnlyHint: true },
  }, guard(async ({ board, format }) => {
    const b = await a.open(board);
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
    const b = await a.open(board);
    const out = await renderBoard(b, { ids: item_ids, showIds: show_ids, maxSize: max_size });
    if (!out) return ok(`"${b.name}" has nothing to draw${item_ids?.length ? ' for those ids' : ''}.`);
    const { box } = out;
    return {
      content: [
        { type: 'image' as const, data: out.png.toString('base64'), mimeType: 'image/png' },
        { type: 'text' as const, text: `"${b.name}": canvas area x ${r(box.x)}…${r(box.x + box.w)}, y ${r(box.y)}…${r(box.y + box.h)}.` },
      ],
    };
  }));

  server.registerTool('view_image', {
    title: 'View image',
    description: 'Look at an image that was pasted onto a board.',
    inputSchema: { board: BOARD, image_id: z.string().describe('Item id of the image (from read_board)') },
    annotations: { readOnlyHint: true },
  }, guard(async ({ board, image_id }) => {
    const b = await a.open(board);
    const it = b.items.find((i) => i.id === image_id);
    if (!it || it.type !== 'image') throw new Error(`No image with id "${image_id}" on "${b.name}".`);
    const img = await imageForModel(it.blob);
    if (!img) throw new Error('The image file is missing.');
    return { content: [{ type: 'image' as const, data: img.data.toString('base64'), mimeType: img.mime }] };
  }));

  server.registerTool('add_items', {
    title: 'Add items',
    description: `Add notes, text, flow-chart shapes and arrows in one call. Shapes without x/y are laid out automatically: next to the item they connect from, ${a.screens ? 'or in the area the user is looking at' : 'or beside existing content'}. Returns the new ids.`,
    inputSchema: {
      board: BOARD,
      items: z.array(ItemSpec).min(1).describe('Items to add. Edges may refer to items created earlier in this list by their ref.'),
      direction: z.enum(['right', 'down']).optional().describe('Which way auto-laid-out flows grow (default right)'),
    },
  }, guard(async ({ board, items, direction }) => {
    let added: ReturnType<typeof addItems> = [];
    const b = await a.edit(board, (bb, anchor) => { added = addItems(bb, items as AddSpec[], direction, anchor); });
    return ok(`Added ${added.length} item${added.length === 1 ? '' : 's'} to "${b.name}":\n` +
      added.map((x) => `- ${x.ref ? `${x.ref} → ` : ''}[${x.id}] ${x.summary}`).join('\n'));
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
        corners: z.enum(['square', 'soft', 'round', 'full']).optional().describe('Image corners: square, soft (slightly rounded), round, or full (pill / circle)'),
      })).min(1),
    },
  }, guard(async ({ board, updates }) => {
    let done: string[] = [];
    const b = await a.edit(board, (bb) => { done = updateItems(bb, updates); });
    return ok(`Updated on "${b.name}":\n${done.map((d) => `- ${d}`).join('\n')}`);
  }));

  server.registerTool('delete_items', {
    title: 'Delete items',
    description: 'Delete items by id. Arrows attached to deleted items are removed too. Only delete what the user asked to remove.',
    inputSchema: { board: BOARD, item_ids: z.array(z.string()).min(1) },
    annotations: { destructiveHint: true },
  }, guard(async ({ board, item_ids }) => {
    let res = { removed: 0, edges: 0 };
    const b = await a.edit(board, (bb) => { res = deleteItems(bb, item_ids); });
    return ok(`Deleted ${res.removed} item${res.removed === 1 ? '' : 's'}${res.edges ? ` and ${res.edges} attached arrow${res.edges === 1 ? '' : 's'}` : ''} from "${b.name}". The user can undo this in the app.`);
  }));

  server.registerTool('add_image', {
    title: 'Add image',
    description: `Put an image on a board from ${a.readFile ? 'a local file path, ' : ''}a URL or base64 data.`,
    inputSchema: {
      board: BOARD,
      ...(a.readFile ? { path: z.string().optional().describe('Local file path (~ allowed)') } : {}),
      url: z.string().optional().describe('http(s) URL to download'),
      data_base64: z.string().optional(),
      mime_type: z.string().optional().describe('For data_base64, e.g. image/png'),
      x: z.number().optional(), y: z.number().optional(),
      width: z.number().optional().describe('Display width on the canvas (default: up to 520)'),
      near: z.string().optional().describe('Place next to this item id instead of automatic placement'),
    },
  }, guard(async (args: { board?: string; path?: string; url?: string; data_base64?: string; mime_type?: string; x?: number; y?: number; width?: number; near?: string }) => {
    let got: { buf: Buffer; mime: string | null };
    if (args.path && a.readFile) got = await a.readFile(args.path);
    else if (args.url) got = await a.fetchImage(args.url);
    else if (args.data_base64) got = { buf: Buffer.from(args.data_base64, 'base64'), mime: args.mime_type ?? null };
    else throw new Error(`Give one of ${a.readFile ? 'path, ' : ''}url or data_base64.`);
    if (got.buf.length > MAX_IMAGE) throw new Error('That image is over 20 MB.');
    const mime = sniffMime(got.buf) ?? got.mime;
    if (!mime?.startsWith('image/')) throw new Error('That does not look like an image.');
    const blob = await putImage(got.buf, mime);
    const dims = imageSize(got.buf) ?? { w: 800, h: 600 };
    const w = args.width ?? Math.min(520, dims.w);
    const h = (w * dims.h) / dims.w;

    let summary = '';
    const b = await a.edit(args.board, (bb, anchor) => {
      // Reuse the auto-layout by placing a stand-in note of the same size, then swapping in the image.
      const hasPos = typeof args.x === 'number' && typeof args.y === 'number';
      const [placed] = addItems(bb, [{ type: 'note', text: '', w, h, x: args.x, y: args.y, near: hasPos ? undefined : args.near }], 'right', anchor);
      const i = bb.items.findIndex((it) => it.id === placed.id);
      const stub = bb.items[i];
      const img: ImageItem = { id: newId(), type: 'image', blob, x: stub.type === 'edge' ? 0 : stub.x, y: stub.type === 'edge' ? 0 : stub.y, w, h };
      bb.items[i] = img;
      summary = `[${img.id}] image ${r(w)}×${r(h)} at (${r(img.x)}, ${r(img.y)})`;
    });
    return ok(`Added to "${b.name}": ${summary}`);
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
    const b = await a.create(name.slice(0, 80));
    let added: ReturnType<typeof addItems> = [];
    if (items?.length) await a.edit(b.id, (bb) => { added = addItems(bb, items as AddSpec[], direction); });
    return ok(`Created "${b.name}" (id ${b.id})${added.length ? ` with ${added.length} items:\n${added.map((x) => `- ${x.ref ? `${x.ref} → ` : ''}[${x.id}] ${x.summary}`).join('\n')}` : '.'}\nOpen it at ${a.link(b.id)}`);
  }));

  server.registerTool('rename_board', {
    title: 'Rename board',
    description: 'Rename a board.',
    inputSchema: { board: z.string().describe('Board id or current name'), name: z.string() },
  }, guard(async ({ board, name }) => {
    let was = '';
    const b = await a.edit(board, (bb) => { was = bb.name; bb.name = name.replace(/\s+/g, ' ').trim().slice(0, 80) || bb.name; }, { ownerOnly: true });
    return ok(`Renamed "${was}" to "${b.name}".`);
  }));
}
