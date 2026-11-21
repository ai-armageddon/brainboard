// Production server: the built app (dist/) + API + realtime socket.
//   npm start           → only this computer (http://localhost:5317)
//   npm run share       → also reachable from your local network, for invited guests
//   hosted              → BRAINBOARD_PUBLIC_URL=https://brainboard.ink PORT=8080 node server/main.ts (behind HTTPS)
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handleApi, network } from './api.ts';
import { attachRealtime } from './realtime.ts';
import { ownerSecret } from './auth.ts';
import { HOSTED, PUBLIC_URL } from './config.ts';
import { DATA_DIR, gcImages } from './store.ts';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.env.PORT ?? 5317);
const SHARE = process.argv.includes('--share') || process.env.BRAINBOARD_SHARE === '1';
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  if (await handleApi(req, res)) return;
  const url = new URL(req.url ?? '/', 'http://localhost');
  let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  try {
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    file = path.join(DIST, 'index.html');
  }
  try {
    const body = await fs.readFile(file);
    const hashed = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not built yet: run `npm run build` first.');
  }
});

attachRealtime(server);
network.lan = SHARE;

const HOST = process.env.HOST ?? (HOSTED || SHARE ? '0.0.0.0' : '127.0.0.1');

server.listen(PORT, HOST, () => {
  console.log(`\n  brainboard  →  ${PUBLIC_URL ?? `http://localhost:${PORT}`}`);
  if (HOSTED) console.log(`  listening    →  ${HOST}:${PORT} (serve it over HTTPS at ${PUBLIC_URL})`);
  console.log(`  data         →  ${DATA_DIR}`);
  if (SHARE && !HOSTED) {
    const ips = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal);
    for (const a of ips) console.log(`  network      →  http://${a!.address}:${PORT}   (invite links work here)`);
    console.log(`\n  Owner link for your other devices (keep private):`);
    console.log(`  http://${ips[0]?.address ?? 'localhost'}:${PORT}/?owner=${ownerSecret()}`);
  }
  console.log('');
  void gcImages();
});
