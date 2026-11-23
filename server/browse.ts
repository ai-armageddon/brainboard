// The shared browser's page loader: GET /api/browse?b=<board>&k=<key>&n=<load>&u=<address>
//
// It fetches one web page and hands it back ready to sit in a sandboxed frame on the board: a <base> so the
// page's own images, styles and scripts load straight from the site (only the HTML passes through here), and
// the small script from browse-page.ts that keeps everyone's copy in step. That is the whole "browser": there
// is no headless Chrome and no cookie jar, so it suits reading and looking things up together, not signing in.
//
// Safety:
//   - Only people on a board with the browser open can use it (the key lives as long as that session).
//   - Pages are answered with `Content-Security-Policy: sandbox`, so whatever they contain runs with no origin:
//     no access to Brainboard's cookies, storage or API, however the response is opened.
//   - It refuses addresses on this machine or a private network, and re-checks after every redirect.
//   - Set BRAINBOARD_BROWSER=0 to switch the feature off entirely.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import { isValidId } from './store.ts';
import { limited } from './accounts.ts';
import { clientIp } from './auth.ts';
import { PAGE_SCRIPT } from './browse-page.ts';

export const BROWSE_ENABLED = process.env.BRAINBOARD_BROWSER !== '0';
/**
 * Where plain words typed in the address bar go; %s is the search. It has to be a results page that arrives as
 * ordinary HTML and doesn't turn server-side visitors away. (DuckDuckGo's does: it asks them to prove they're human.)
 */
const SEARCH_URL = process.env.BRAINBOARD_SEARCH_URL || 'https://search.brave.com/search?q=%s';
/** For browsing a dev server on this machine or network together. Off by default: it lets guests reach them too. */
const ALLOW_PRIVATE = process.env.BRAINBOARD_BROWSE_PRIVATE === '1';

const MAX_URL = 2000;
const MAX_HTML = 6 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const FALLBACK_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// ------------------------------------------------------------------ addresses

function httpUrl(text: string): URL | null {
  try {
    const u = new URL(text);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
}

/** Is this the search engine's results page? */
function isSearch(u: URL) {
  const s = httpUrl(SEARCH_URL.replace('%s', 'x'));
  return !!s && u.origin === s.origin && u.pathname === s.pathname;
}

/** Some search engines link results through a redirect page that only works with their own script; go straight to the result. */
function unwrap(u: URL): URL {
  if (/(^|\.)duckduckgo\.com$/.test(u.hostname) && u.pathname === '/l/') return httpUrl(u.searchParams.get('uddg') ?? '') ?? u;
  if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname === '/ck/a') {
    const packed = /^a1(.+)$/.exec(u.searchParams.get('u') ?? '')?.[1];
    return (packed && httpUrl(Buffer.from(packed, 'base64url').toString('utf8'))) || u;
  }
  return u;
}

/** What someone typed in the address bar (or a link a page asked for) as an address to load; null if it can't be one. */
export function resolveAddress(input: unknown): string | null {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text || text.length > MAX_URL) return null;
  let u: URL | null = null;
  if (/^https?:\/\//i.test(text)) u = httpUrl(text);
  else if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) return null; // some other scheme (javascript:, file:, …)
  else if (!/\s/.test(text) && /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#].*)?$/i.test(text)) u = httpUrl(`https://${text}`);
  u ??= httpUrl(SEARCH_URL.replace('%s', encodeURIComponent(text)));
  if (!u) return null;
  const href = unwrap(u).href;
  return href.length <= MAX_URL ? href : null;
}

// ------------------------------------------------------------------ sessions

const keys = new Map<string, string>();
interface Page { status: number; html: string }
const pages = new Map<string, { at: number; page: Promise<Page> }>();

/** The key that lets a board's people load pages while its browser is open. */
export function browseKey(boardId: string): string {
  let k = keys.get(boardId);
  if (!k) keys.set(boardId, k = crypto.randomBytes(18).toString('base64url'));
  return k;
}
/** The board's browser closed: the key stops working. */
export function endBrowse(boardId: string) {
  keys.delete(boardId);
  for (const k of pages.keys()) if (k.startsWith(`${boardId}|`)) pages.delete(k);
}

// ------------------------------------------------------------------ fetching

const PRIVATE = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]] as const) {
  PRIVATE.addSubnet(addr, bits, 'ipv6');
}

function isPrivate(address: string, family: number): boolean {
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return PRIVATE.check(mapped[1], 'ipv4');
    if (/^::ffff:/i.test(address)) return true; // any other spelling of a mapped address
    return PRIVATE.check(address, 'ipv6');
  }
  return PRIVATE.check(address, 'ipv4');
}

class BrowseError extends Error {}

/** Resolve the host ourselves and connect to exactly that address, so a name can't point somewhere private. */
async function publicAddress(hostname: string): Promise<{ address: string; family: number }> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const family = net.isIP(host);
  const found = family ? [{ address: host, family }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!found.length) throw new BrowseError('That site can’t be found. Check the address and try again.');
  if (!ALLOW_PRIVATE && found.some((a) => isPrivate(a.address, a.family))) {
    throw new BrowseError('That address is on a private network, which the shared browser doesn’t open.');
  }
  return found[0];
}

function request(u: URL, headers: Record<string, string>, signal: AbortSignal, to: { address: string; family: number }) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const lookup = ((_host: string, opts: { all?: boolean }, cb: (err: null, address: unknown, family?: number) => void) => {
      if (opts.all) cb(null, [to]);
      else cb(null, to.address, to.family);
    }) as unknown as net.LookupFunction;
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'GET', headers, signal, lookup }, resolve);
    req.on('error', reject);
    req.end();
  });
}

function body(res: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const enc = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
    const unpack = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip() : enc === 'br' ? zlib.createBrotliDecompress()
      : enc === 'deflate' ? zlib.createInflate() : null;
    const stream: Readable = unpack ? res.pipe(unpack) : res;
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { res.destroy(); reject(new BrowseError('That page is too large to open here.')); return; }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    res.on('error', reject);
  });
}

function decode(buf: Buffer, contentType: string): string {
  const named = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1]
    ?? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1'))?.[1];
  try { return new TextDecoder(named || 'utf-8').decode(buf); } catch { return new TextDecoder().decode(buf); }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** JSON that is safe inside a <script>. */
const inline = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, '');

function helper(url: string, hash = '') {
  return `<script>(${PAGE_SCRIPT})(${inline({ url, hash })});document.currentScript&&document.currentScript.remove();</script>`;
}

/** A page of our own: an error, or a stand-in for something that isn't a web page. */
function plain(url: string, title: string, inner: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">${helper(url)}<title>${esc(title)}</title>
<style>html{height:100%}body{margin:0;min-height:100%;display:grid;place-items:center;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:Canvas;color:CanvasText}
main{max-width:460px;padding:32px;text-align:center}h1{font-size:19px;margin:0 0 8px}p{margin:0;opacity:.7;overflow-wrap:anywhere}
img{max-width:100vw;max-height:100vh;display:block}pre{align-self:start;justify-self:start;margin:0;padding:16px;font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}</style>
</head><body>${inner}</body></html>`;
}
const message = (url: string, title: string, detail: string) => plain(url, title, `<main><h1>${esc(title)}</h1><p>${esc(detail)}</p></main>`);

/** Prepare a site's HTML for the frame. */
function prepare(html: string, url: URL): string {
  let base = url.href;
  html = html
    // Their content policy was written for their own address; here it would only block the page's own files.
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, (tag) => {
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      try {
        const theirs = href ? httpUrl(new URL(href[1] ?? href[2] ?? href[3] ?? '', url).href) : null;
        if (theirs) base = theirs.href;
      } catch { /* a base we can't read: keep the page's own address */ }
      return '';
    })
    // Same-site files become cross-site ones in the frame: these two attributes would then stop them loading.
    .replace(/<(?:script|link)\b[^>]*>/gi, (tag) => tag.replace(/\s(?:integrity|crossorigin)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, ''));
  const head = `<base href="${esc(base)}"><meta name="referrer" content="no-referrer">${helper(url.href, url.hash.slice(1))}`;
  const at = /<head\b[^>]*>/i.exec(html) ?? /<html\b[^>]*>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);
  const i = at ? at.index + at[0].length : 0;
  return html.slice(0, i) + head + html.slice(i);
}

async function load(address: string, from: IncomingMessage): Promise<Page> {
  let url = httpUrl(address);
  if (!url) return { status: 400, html: message(address, 'That address doesn’t look right', address) };
  const searching = isSearch(url);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const headers = {
    'user-agent': String(from.headers['user-agent'] || FALLBACK_AGENT),
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': String(from.headers['accept-language'] || 'en-US,en;q=0.9'),
    'accept-encoding': 'gzip, deflate, br',
  };
  try {
    for (let hop = 0; hop < 6; hop++) {
      const res = await request(url, headers, signal, await publicAddress(url.hostname));
      const status = res.statusCode ?? 502;
      const next = [301, 302, 303, 307, 308].includes(status) ? res.headers.location : undefined;
      if (next) {
        res.resume();
        const to = httpUrl(new URL(next, url).href);
        if (!to) throw new BrowseError('That page sent the browser somewhere it can’t go.');
        if (!to.hash) to.hash = url.hash;
        url = unwrap(to);
        continue;
      }
      if (searching && [202, 403, 429, 503].includes(status)) {
        // Search engines turn away visitors they take for robots, and a request from a server looks like one.
        res.destroy();
        return { status: 502, html: message(url.href, 'The search didn’t go through', 'The search engine turned this request away, which it sometimes does to servers. Type a site’s address instead, or try again in a minute.') };
      }
      const type = String(res.headers['content-type'] ?? '').toLowerCase();
      const name = url.pathname.split('/').pop() || url.hostname;
      if (type.startsWith('image/')) {
        res.destroy();
        return { status: 200, html: plain(url.href, name, `<img src="${esc(url.href)}" alt="">`) };
      }
      if (/^(text\/html|application\/xhtml\+xml)/.test(type) || !type) {
        return { status: status >= 400 ? status : 200, html: prepare(decode(await body(res, MAX_HTML), type), url) };
      }
      if (/^text\/|^application\/(json|xml|javascript|[\w.+-]+\+(json|xml))/.test(type)) {
        return { status: 200, html: plain(url.href, name, `<pre>${esc(decode(await body(res, 1024 * 1024), type))}</pre>`) };
      }
      res.destroy();
      return { status: 200, html: message(url.href, 'This isn’t a web page', `${name} is a file (${type.split(';')[0]}) that the shared browser can’t show.`) };
    }
    throw new BrowseError('That page redirected too many times.');
  } catch (err) {
    const e = err as Error & { code?: string };
    const detail = e instanceof BrowseError ? e.message
      : e.name === 'TimeoutError' || e.name === 'AbortError' ? 'The site took too long to answer.'
      : `The site couldn’t be reached${e.code ? ` (${e.code})` : ''}.`;
    return { status: 502, html: message(url.href, 'This page didn’t open', detail) };
  }
}

// ------------------------------------------------------------------ the endpoint

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  // No origin, wherever and however this response is opened. The frame on the board adds the same limits.
  'content-security-policy': 'sandbox allow-scripts allow-forms',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
};

function refuse(res: ServerResponse, status: number, why: string) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(why);
}

export async function handleBrowse(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!BROWSE_ENABLED) return refuse(res, 404, 'The shared browser is switched off on this server.');
  const board = url.searchParams.get('b') ?? '';
  const key = url.searchParams.get('k') ?? '';
  const known = isValidId(board) ? keys.get(board) : undefined;
  const a = Buffer.from(key), b = Buffer.from(known ?? '');
  if (!known || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return refuse(res, 403, 'This browser session has ended.');
  // Pages are only ever shown inside the board's frame, never as a page of ours in its own right.
  const dest = req.headers['sec-fetch-dest'];
  if (dest && dest !== 'iframe') return refuse(res, 403, 'Open this from the browser on a board.');
  const address = url.searchParams.get('u') ?? '';
  if (address.length > MAX_URL) return refuse(res, 414, 'That address is too long.');

  // Everyone on the board asks for the same load: fetch the site once and give them all the same copy.
  const id = `${board}|${url.searchParams.get('n') ?? ''}|${address}`;
  const now = Date.now();
  for (const [k, v] of pages) if (now - v.at > 60_000 || pages.size > 40) pages.delete(k);
  let entry = pages.get(id);
  if (!entry) {
    if (limited(`browse:${board}`, 90, 60_000) || limited(`browse-ip:${clientIp(req)}`, 240, 60_000)) {
      return refuse(res, 429, 'Too many pages at once. Give it a moment.');
    }
    pages.set(id, entry = { at: now, page: load(address, req) });
  }
  const page = await entry.page;
  res.writeHead(page.status, PAGE_HEADERS).end(page.html);
}
