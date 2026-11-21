// Connect AI: personal links that let ChatGPT, Claude, Codex and other MCP apps read your boards, add to them and
// see what you're looking at. Each link acts as you (this browser, or your account once signed in); delete it to
// cut that app off.
import { account, api, events, session } from './net';
import { ensureBoard } from './boards';
import { openAuth } from './account';
import { closePopovers, toast } from './ui';
import { icon } from './icons';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Key { id: string; name: string; hint: string; created: string; used: string | null; boardId?: string; expired?: boolean }

type Provider = 'ChatGPT' | 'Claude';
interface BoardChoice { id: string; name: string; role: 'owner' | 'editor' | 'viewer' }
let boards: BoardChoice[] = [];
let selected = '';
let provider: Provider = 'ChatGPT';
let approval = '';
let loadError = '';
let loading = true;
let keys: Key[] = [];
const destinations = {
  ChatGPT: { setup: 'https://chatgpt.com/plugins', chat: 'https://chatgpt.com/', listing: import.meta.env.VITE_CHATGPT_PLUGIN_URL as string | undefined },
  Claude: { setup: 'https://claude.ai/customize/connectors', chat: 'https://claude.ai/new', listing: import.meta.env.VITE_CLAUDE_CONNECTOR_URL as string | undefined },
};
let base = location.origin;
/** the link just made: shown once, since only a hash is kept */
let fresh: { url: string; name: string } | null = null;
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

const reachable = () => base.startsWith('https://') && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);

function manualSetup() {
  const where = 'Personal links grant access to every board available to your Brainboard account or browser.';
  return `<details class="ai-manual" ${fresh ? 'open' : ''}><summary>Manual setup for Codex and other apps</summary>
${fresh ? `
      <section class="ai-fresh">
        <h3>${esc(fresh.name)}: your link</h3>
        <p class="small muted">Keep this private link. Anyone with it can use your board permissions.</p>
        <div class="ai-url"><input class="mono" readonly value="${esc(fresh.url)}" aria-label="Connection link" /><button class="primary" data-copy="${esc(fresh.url)}">${icon('copy', 16)} Copy</button></div>
        <p class="small">For Codex, copy this terminal command.</p>
        <pre class="ai-code"><code>codex mcp add brainboard --url ${esc(fresh.url)}</code><button class="cbtn" data-copy="codex mcp add brainboard --url ${esc(fresh.url)}" aria-label="Copy Codex command">${icon('copy',16)}</button></pre>
        <button class="link-btn" data-act="done">Done</button>
      </section>` : `
      <section>
        <h3>New connection</h3>
        <form class="ai-new">
          <input class="home-search" name="name" maxlength="40" placeholder="Name it, e.g. Codex" aria-label="Connection name" />
          <button class="primary" type="submit">Create link</button>
        </form>
        <p class="small muted">${where}</p>
      </section>`}</details>`;
}

function boardOptions(id: string) {
  return boards.map(b => `<option value="${esc(b.id)}" ${id === b.id ? 'selected' : ''}>${esc(b.name)}${b.role === 'viewer' ? ' (view only)' : ''}</option>`).join('');
}

function picker() {
  return boards.length
    ? `<label class="field">Board<select data-board aria-label="Board">${boardOptions(selected)}</select></label>`
    : '<button type="button" class="link-btn" data-act="new-board">Create a board</button>';
}

function render() {
  const el = $('connect').querySelector('.connect-body')!;
  $('connect-title').textContent = approval ? 'Authorize Brainboard' : 'Connect AI';
  if (loading || loadError) {
    el.innerHTML = loading ? '<p role="status">Loading connections…</p>' :
      `<p role="alert">${esc(loadError)}</p><button class="link-btn" data-act="retry">Try again</button>`;
    return;
  }
  if (approval) {
    const board = boards.find(b => b.id === selected);
    el.innerHTML = `<h3>Connect ${provider} to a board</h3>
      ${picker()}<p class="small">${board ? `${provider} will be able to ${board.role === 'viewer' ? 'read' : 'read and edit'} this board when you use the connector.` : 'Choose a board to continue.'}</p>
      ${account.user ? `<p class="small muted">Signed in as ${esc(account.user.name)}</p>` : '<button class="link-btn" data-act="signin">Sign in to find my boards</button>'}
      <div class="ai-actions"><button class="primary" data-act="allow" ${board ? '' : 'disabled'}>Connect board</button>
      <button class="link-btn" data-act="deny">Cancel</button></div>`;
    return;
  }
  const grants = keys.filter(k => k.boardId && !k.expired && k.name === provider);
  const grant = grants.find(k => k.boardId === selected) ?? grants[grants.length - 1];
  const linked = grant && grant.boardId === selected;
  const dest = destinations[provider];
  const endpoint = base + '/mcp/connect';
  el.innerHTML = `<div class="ai-tabs" role="group" aria-label="AI provider">${(['ChatGPT', 'Claude'] as const).map(p =>
    `<button class="seg ${p === provider ? 'on' : ''}" data-provider="${p}" aria-pressed="${p === provider}">${p}</button>`).join('')}</div>
    ${picker()}
    ${linked ? `<label class="field">Prompt for ${provider}<textarea class="ai-prompt" rows="3" maxlength="8000" placeholder="Turn the notes on this board into a flowchart."></textarea></label>
      <a class="primary ai-open" data-launch href="${dest.chat}" target="_blank" rel="noopener noreferrer">Open ${provider}</a>
      <p class="small muted">Your prompt is copied when you open the chat. Select Brainboard, paste it and send.</p>` :
    grant ? `<button class="primary" data-act="switch" data-key="${esc(grant.id)}" ${selected ? '' : 'disabled'}>Use this board with ${provider}</button>` :
    !reachable() ? '<p class="ai-warn">ChatGPT and Claude need a publicly reachable HTTPS board. Use the hosted Brainboard for these chats, or connect a local app below.</p>' :
    dest.listing ? `<a class="primary ai-open" data-setup href="${esc(dest.listing)}" target="_blank" rel="noopener noreferrer">Connect with ${provider}</a>` :
    `<a class="primary ai-open" data-setup href="${dest.setup}" target="_blank" rel="noopener noreferrer">Continue in ${provider}</a>
      <p class="small">Add Brainboard once in ${provider}, then approve your board. We’ll copy the connector address when you continue.</p>
      <details><summary>First-time setup</summary>
      <p class="small">${provider === 'ChatGPT' ? 'In Plugins, choose Add custom MCP server. Paste the address, name it Brainboard and select OAuth with automatic registration.' : 'Add a custom web connector named Brainboard. Paste the address, then choose Sign in now and Register automatically.'}</p>
      <div class="ai-url"><input readonly aria-label="Public connector address" value="${esc(endpoint)}"><button class="link-btn" data-copy="${esc(endpoint)}">Copy address</button></div></details>`}
    <details ${confirmDel ? 'open' : ''}><summary>Manage connections (${keys.length})</summary><div class="members">${keys.map(k =>
      `<div class="member ai-key" data-id="${esc(k.id)}"><div class="member-main"><b>${esc(k.name)}</b><span class="sub muted">${k.boardId ? esc(boards.find(b=>b.id===k.boardId)?.name ?? 'Board unavailable') : 'All accessible boards'} · ${k.expired ? 'expired' : k.used ? 'used '+ago(k.used) : 'unused'}</span></div>
      <button class="link-btn danger" data-act="del">${confirmDel === k.id ? 'Confirm disconnect' : 'Disconnect'}</button></div>`).join('') || '<p class="small muted">No connections yet.</p>'}</div></details>
    ${manualSetup()}`;
}

let generation = 0;
async function load() {
  const version = ++generation;
  try {
    const [r, consent] = await Promise.all([
      call<{ base: string; keys: Key[]; boards: BoardChoice[] }>('GET', '/api/mcp-keys'),
      approval ? call<{ provider: Provider }>('GET', '/api/ai-consent/' + encodeURIComponent(approval)) : null,
    ]);
    if (version !== generation) return;
    keys = r.keys;
    boards = r.boards;
    base = r.base;
    if (consent) provider = consent.provider;
    let preferred = selected || session.boardId;
    if (approval && !selected) try { preferred = localStorage.getItem('bb-ai-board-' + provider); } catch { /* optional */ }
    selected = boards.find(b => b.id === preferred)?.id ?? boards[0]?.id ?? '';
    loadError = '';
  } catch (err) { if (version !== generation) return; loadError = (err as Error).message; }
  loading = false;
  render();
}

export function openConnect(request = '') {
  approval = request;
  try { provider = localStorage.getItem('bb-ai-provider') === 'Claude' ? 'Claude' : 'ChatGPT'; } catch { /* optional */ }
  selected = session.boardId ?? '';
  loading = true;
  loadError = '';
  closePopovers();
  fresh = null;
  confirmDel = null;
  $('connect').hidden = false;
  $('connect').querySelector<HTMLButtonElement>('.close')?.focus();
  render();
  void load();
}

function closeConnect() {
  if (approval) {
    void decide(false).catch(() => location.replace('/'));
    return;
  }
  ++generation;
  $('connect').hidden = true;
  fresh = null;
}

async function decide(allow: boolean) {
  const result = await call<{ redirect: string }>('POST', '/api/ai-consent/' + encodeURIComponent(approval), { allow, boardId: selected });
  location.replace(result.redirect);
}

export function initConnect() {
  const el = $('connect');
  $('ask-ai').addEventListener('click', () => openConnect());
  el.addEventListener('change', (e) => {
    const select = e.target;
    if (select instanceof HTMLSelectElement && select.matches('[data-board]')) { selected = select.value; render(); }
  });
  el.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') closeConnect(); });
  events.addEventListener('account', () => { if (!el.hidden) void load(); });
  window.addEventListener('focus', () => {
    if (!el.hidden && !approval && !fresh && !el.querySelector('.ai-prompt, details[open]')) void load();
  });
  el.addEventListener('click', async (e) => {
    const t = e.target as Element;
    if (t === el || t.closest('.close')) return closeConnect();
    const prov = t.closest<HTMLElement>('[data-provider]')?.dataset.provider;
    if (prov === 'ChatGPT' || prov === 'Claude') {
      provider = prov;
      try { localStorage.setItem('bb-ai-provider', provider); } catch { /* optional */ }
      confirmDel = null;
      return render();
    }
    if (t.closest('[data-setup]')) {
      try { localStorage.setItem('bb-ai-board-' + provider, selected); } catch { /* optional */ }
      if (!destinations[provider].listing) {
        try { await navigator.clipboard.writeText(base + '/mcp/connect'); toast('Connector address copied'); }
        catch { toast('Use Copy address before adding Brainboard.'); }
      }
      return;
    }
    if (t.closest('[data-launch]')) {
      const prompt = el.querySelector<HTMLTextAreaElement>('.ai-prompt')?.value.trim();
      if (prompt) {
        try { await navigator.clipboard.writeText(prompt); toast('Prompt copied'); }
        catch { toast('Copy your prompt here, then paste it into the chat.'); }
      }
      return;
    }
    const cp = t.closest<HTMLElement>('[data-copy]');
    if (cp) {
      try { await navigator.clipboard.writeText(cp.dataset.copy!); toast('Copied'); } catch { toast('Select the address and copy it manually.'); }
      return;
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'retry') return void load();
    if (act === 'signin') return openAuth('signin');
    if (act === 'allow' || act === 'deny' || act === 'new-board' || act === 'switch') {
      const btn = t.closest('button')!;
      btn.disabled = true;
      try {
        if (act === 'allow' || act === 'deny') return await decide(act === 'allow');
        if (act === 'new-board') {
          selected = session.draft && !approval ? (await ensureBoard()) ?? '' : (await api.createBoard('Untitled board')).id;
        }
        else await call('PATCH', '/api/mcp-keys/' + encodeURIComponent(btn.dataset.key!), { boardId: selected });
        await load();
      } catch (err) { btn.disabled = false; toast((err as Error).message); }
      return;
    }
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
