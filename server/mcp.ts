#!/usr/bin/env node
// brainboard MCP server (stdio). Lets AI agents on this computer read, see and edit every board in ~/.brainboard.
// Edits show up live in any open brainboard tab. (To connect a chat app such as ChatGPT or Claude over the
// internet, use the hosted endpoint instead: see server/remote-mcp.ts and "Connect AI" in the app.)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBoard, listBoards, mimeForExt, resolveBoard, updateBoard } from './store.ts';
import { instructions, registerBoardTools, type BoardAccess } from './tools.ts';

const access: BoardAccess = {
  list: async () => (await listBoards()).map((b) => ({ ...b, role: 'owner' as const })),
  open: (ref) => resolveBoard(ref),
  edit: async (ref, fn) => updateBoard((await resolveBoard(ref)).id, (b) => fn(b)),
  create: (name) => createBoard(name),
  link: (id) => `http://localhost:5317/#${id} (while the app is running)`,
  defaultHelp: 'Defaults to the most recently edited board.',
  readFile: async (p) => {
    const file = path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
    return { buf: await fs.readFile(file), mime: mimeForExt(path.extname(file)) };
  },
  fetchImage: async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    return { buf: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type')?.split(';')[0] ?? null };
  },
};

const server = new McpServer({ name: 'brainboard', title: 'Brainboard', version: '0.3.0' }, { instructions: instructions(access) });
registerBoardTools(server, access);

await server.connect(new StdioServerTransport());
console.error('brainboard MCP server ready');
