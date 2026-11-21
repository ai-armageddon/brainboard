// Connect AI: personal links that let ChatGPT, Claude, Codex and other MCP apps read your boards, add to them and
// see what you're looking at. Each link acts as you (this browser, or your account once signed in); delete it to
// cut that app off.
import { account } from './net';
import { closePopovers, toast } from './ui';
import { icon } from './icons';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Key { id: string; name: string; hint: string; created: string; used: string | null }

let keys: Key[] = [];
let base = location.origin;
/** the link just made: shown once, since only a hash is kept */
let fresh: { url: string; name: string } | null = null;
let app: 'chatgpt' | 'claude' | 'codex' | 'other' = 'chatgpt';
let confirmDel: string | null = null;

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

function ago(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const reachable = () => !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);

function steps(url: string) {
  const code = (raw: string) => `<pre class="ai-code"><code>${esc(raw)}</code><button class="cbtn" data-copy="${esc(raw)}" aria-label="Copy">${icon('copy', 16)}</button></pre>`;
  const tabs = ([['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['codex', 'Codex'], ['other', 'Other apps']] as const)
    .map(([k, l]) => `<button class="seg ${app === k ? 'on' : ''}" data-app="${k}" aria-pressed="${app === k}">${l}</button>`).join('');
  const body = {
    chatgpt: `<ol>
        <li>In ChatGPT open <b>Settings → Apps</b> (called Apps &amp; Connectors on some accounts). Under <b>Advanced settings</b>, turn on <b>Developer mode</b> if you see it.</li>
        <li>Choose <b>Create</b> (or <b>Add → Create MCP app</b>). Name it Brainboard, paste the link as the <b>MCP server URL</b> and pick <b>No authentication</b>.</li>
        <li>In a chat, turn Brainboard on from the <b>+</b> menu and ask away: <i>“turn this into a flowchart on my board”</i>.</li>
      </ol>
      <p class="muted small">Needs a paid ChatGPT plan. Workspace accounts may need an admin to allow custom apps.</p>`,
    claude: `<ol>
        <li>In Claude (web or desktop) open <b>Settings → Connectors → Add custom connector</b>.</li>
        <li>Name it Brainboard and paste the link as the URL. No other settings needed.</li>
        <li>Turn it on for a chat from the tools menu and ask: <i>“what am I looking at on my board?”</i></li>
      </ol>
      <p class="muted small">Claude Code: </p>${code(`claude mcp add --transport http brainboard ${url}`)}`,
    codex: `<p class="small">Add this to <code>~/.codex/config.toml</code>, then restart Codex:</p>
      ${code(`[mcp_servers.brainboard]\nurl = "${url}"`)}`,
    other: `<p class="small">Any app that supports MCP over HTTP (“Streamable HTTP”) can use the link as its server URL. Apps that ask for a header instead can use the base address with the key as a bearer token:</p>
      ${code(`${base}/mcp\nAuthorization: Bearer ${url.slice(url.lastIndexOf('/') + 1)}`)}`,
  }[app];
  return `<div class="seg-row ai-tabs">${tabs}</div><div class="ai-steps">${body}</div>`;
}

function render() {
  const el = $('connect').querySelector('.connect-body')!;
  const where = account.user
    ? `Links act as your account, <b>${esc(account.user.name)}</b>: they can open your boards and the ones shared with you, nothing else.`
    : 'Links act as this browser: they can open the boards you made here and the ones shared with you, nothing else. Sign in and they move to your account.';
  el.innerHTML = `
    <p class="small ai-lede">Let ChatGPT, Claude, Codex or any MCP app read your boards, add notes, shapes and flowcharts, and see what you’re looking at and what you’ve selected. Edits show up live.</p>
    ${reachable() ? '' : '<p class="small ai-warn">You’re on this computer’s copy of Brainboard, so these links only work from here (Codex, Claude Code). ChatGPT and claude.ai need the links from brainboard.ink.</p>'}
    ${fresh ? `
      <section class="ai-fresh">
        <h3>${esc(fresh.name)}: your link</h3>
        <p class="small muted">Copy it now: it won’t be shown again. Anyone with it can edit your boards, so keep it private.</p>
        <div class="ai-url"><input class="mono" readonly value="${esc(fresh.url)}" aria-label="Connection link" /><button class="primary" data-copy="${esc(fresh.url)}">${icon('copy', 16)} Copy</button></div>
        ${steps(fresh.url)}
        <button class="link-btn" data-act="done">Done</button>
      </section>` : `
      <section>
        <h3>New connection</h3>
        <form class="ai-new">
          <input class="home-search" name="name" maxlength="40" placeholder="Name it, e.g. ChatGPT" aria-label="Connection name" />
          <button class="primary" type="submit">Create link</button>
        </form>
        <p class="small muted">${where}</p>
      </section>`}
    <section>
      <h3>Connections <span class="count">${keys.length}</span></h3>
      <div class="members">${keys.length ? keys.map((k) => `
        <div class="member ai-key" data-id="${esc(k.id)}">
          <span class="ai-ic">${icon('passkey', 17)}</span>
          <div class="member-main"><div>${esc(k.name)}</div><div class="sub muted">${esc(k.hint)}… · made ${ago(k.created)} · ${k.used ? `used ${ago(k.used)}` : 'not used yet'}</div></div>
          <button class="link-btn danger" data-act="del">${confirmDel === k.id ? 'Click again to delete' : 'Delete'}</button>
        </div>`).join('') : '<p class="small muted">None yet.</p>'}
      </div>
    </section>`;
  el.querySelector<HTMLInputElement>('.ai-new input')?.focus();
}

async function load() {
  try {
    const r = await call<{ base: string; keys: Key[] }>('GET', '/api/mcp-keys');
    keys = r.keys;
    base = r.base;
  } catch { /* keep what we have */ }
  render();
}

export function openConnect() {
  closePopovers();
  fresh = null;
  confirmDel = null;
  $('connect').hidden = false;
  render();
  void load();
}

function closeConnect() {
  $('connect').hidden = true;
  fresh = null;
}

export function initConnect() {
  const el = $('connect');
  el.addEventListener('click', async (e) => {
    const t = e.target as Element;
    if (t === el || t.closest('.close')) return closeConnect();
    const cp = t.closest<HTMLElement>('[data-copy]');
    if (cp) {
      try { await navigator.clipboard.writeText(cp.dataset.copy!); toast('Copied'); } catch { toast(cp.dataset.copy!); }
      return;
    }
    const tab = t.closest<HTMLElement>('[data-app]');
    if (tab) { app = tab.dataset.app as typeof app; return render(); }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'done') { fresh = null; return render(); }
    if (act === 'del') {
      const id = t.closest<HTMLElement>('[data-id]')!.dataset.id!;
      if (confirmDel !== id) { confirmDel = id; return render(); }
      confirmDel = null;
      try {
        await call('DELETE', `/api/mcp-keys/${encodeURIComponent(id)}`);
        keys = keys.filter((k) => k.id !== id);
        toast('Connection deleted. That app can’t reach your boards any more.');
      } catch (err) { toast((err as Error).message); }
      return render();
    }
  });
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim();
    const btn = form.querySelector('button')!;
    btn.disabled = true;
    try {
      const r = await call<{ key: Key; url: string }>('POST', '/api/mcp-keys', { name });
      keys = [...keys, r.key];
      fresh = { url: r.url, name: r.key.name };
      const n = r.key.name.toLowerCase();
      app = n.includes('claude') ? 'claude' : n.includes('codex') ? 'codex' : n.includes('gpt') ? 'chatgpt' : app;
      render();
    } catch (err) {
      toast((err as Error).message);
      btn.disabled = false;
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.hidden) { e.preventDefault(); closeConnect(); }
  });
}
