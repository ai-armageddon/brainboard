// Export dialog: pick a format and options, preview it, then choose where to save it.
// "Save as…" uses the browser's file picker (Chrome, Edge, Opera); elsewhere the file goes to Downloads.
import { S } from './state';
import { session } from './net';
import { isNode } from './actions';
import { icon } from './icons';
import { toast } from './ui';

type Format = 'png' | 'pdf' | 'svg' | 'md' | 'json';
interface Fmt { id: Format; label: string; tag: string; desc: string; ext: string; mime: string; accept: string }
const FORMATS: Fmt[] = [
  { id: 'png', label: 'Image', tag: 'PNG', desc: 'For slides, docs and chat', ext: 'png', mime: 'image/png', accept: '.png' },
  { id: 'pdf', label: 'PDF', tag: 'PDF', desc: 'To print or send', ext: 'pdf', mime: 'application/pdf', accept: '.pdf' },
  { id: 'svg', label: 'Vector', tag: 'SVG', desc: 'Sharp at any size', ext: 'svg', mime: 'image/svg+xml', accept: '.svg' },
  { id: 'md', label: 'Outline', tag: 'MD', desc: 'Text and flow as Markdown', ext: 'md', mime: 'text/markdown', accept: '.md' },
  { id: 'json', label: 'Brainboard file', tag: 'JSON', desc: 'A full copy you can import', ext: 'brainboard.json', mime: 'application/json', accept: '.json' },
];

interface State { format: Format; scope: 'all' | 'sel'; theme: 'light' | 'dark'; bg: boolean; scale: 1 | 2 | 3; name: string }
const PREFS = 'bb-export';
function loadState(): State {
  const dark = document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  let saved: Partial<State> = {};
  try { saved = JSON.parse(localStorage.getItem(PREFS) ?? '{}'); } catch { /* ignore */ }
  return {
    format: saved.format ?? 'png', scope: 'all', theme: saved.theme ?? (dark ? 'dark' : 'light'),
    bg: saved.bg ?? true, scale: saved.scale ?? 2, name: cleanName(session.boardName),
  };
}
const cleanName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '').trim() || 'brainboard';

type Picker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
const picker = (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;

let sheet: HTMLDivElement | null = null;

export function openExport() {
  if (!session.boardId || sheet) return;
  const st = loadState();
  const selIds = S.items.filter((i) => isNode(i) && S.selected.has(i.id)).map((i) => i.id);
  if (selIds.length) st.scope = 'sel';

  sheet = document.createElement('div');
  sheet.className = 'auth-backdrop';
  sheet.innerHTML = `<div class="auth-card export-card" role="dialog" aria-modal="true" aria-labelledby="export-title">
    <button class="auth-x" data-close aria-label="Close">${icon('close', 16)}</button>
    <div class="auth-eyebrow">Export</div>
    <h2 id="export-title">${esc(session.boardName || 'Board')}</h2>
    <div class="export-body">
      <div class="export-preview" aria-live="polite"><div class="export-stage"></div></div>
      <div class="export-side">
        <div class="export-formats" role="radiogroup" aria-label="Format">
          ${FORMATS.map((f) => `<button class="xfmt" role="radio" data-format="${f.id}"><b>${f.tag}</b><span>${f.label}</span><em>${f.desc}</em></button>`).join('')}
        </div>
        <div class="export-opts"></div>
        <label class="auth-field"><span>File name</span><span class="xname"><input name="name" spellcheck="false" /><i></i></span></label>
        <button class="auth-passkey xsave">${icon('save', 18)}<span>${picker ? 'Save as…' : 'Download'}</span></button>
        <p class="xfine">${picker ? 'You choose the folder and name in the next step.' : 'Your browser saves to Downloads. To choose a folder each time, turn on “Ask where to save each file” in its settings.'}</p>
      </div>
    </div>
  </div>`;
  document.body.append(sheet);
  requestAnimationFrame(() => sheet?.classList.add('in'));

  const $ = <T extends Element>(sel: string) => sheet!.querySelector<T>(sel)!;
  const nameInput = $<HTMLInputElement>('input[name="name"]');
  nameInput.value = st.name;

  const fmt = () => FORMATS.find((f) => f.id === st.format)!;
  const persist = () => {
    try { localStorage.setItem(PREFS, JSON.stringify({ format: st.format, theme: st.theme, bg: st.bg, scale: st.scale })); } catch { /* ignore */ }
  };
  const url = (format: Format, extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({ format, theme: st.theme, bg: st.bg ? '1' : '0', scale: String(st.scale), ...extra });
    if (st.scope === 'sel' && selIds.length) q.set('ids', selIds.join(','));
    if (session.invite) q.set('invite', session.invite);
    return `/api/boards/${encodeURIComponent(session.boardId!)}/export?${q}`;
  };

  const seg = <K extends keyof State>(key: K, label: string, opts: [State[K], string][]) =>
    `<div class="xopt"><span>${label}</span><div class="xseg" role="radiogroup" aria-label="${label}">${opts.map(([v, t]) =>
      `<button role="radio" data-key="${String(key)}" data-val="${String(v)}" aria-checked="${st[key] === v}">${t}</button>`).join('')}</div></div>`;

  let previewTimer = 0;
  function render() {
    const f = fmt();
    sheet!.querySelectorAll<HTMLElement>('.xfmt').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.format === st.format)));
    const visual = st.format === 'png' || st.format === 'pdf' || st.format === 'svg';
    $('.export-opts').innerHTML =
      (selIds.length ? seg('scope', 'Include', [['all', 'Whole board'], ['sel', `Selection · ${selIds.length}`]]) : '') +
      (visual ? seg('theme', 'Theme', [['light', 'Light'], ['dark', 'Dark']]) : '') +
      (st.format === 'png' || st.format === 'svg' ? seg('bg', 'Background', [[true, 'Solid'], [false, 'Transparent']]) : '') +
      (st.format === 'png' ? seg('scale', 'Size', [[1, '1×'], [2, '2×'], [3, '3×']]) : '');
    $('.xname i').textContent = `.${f.ext}`;
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(preview, 120);
  }

  let previewSeq = 0;
  async function preview() {
    const stage = $<HTMLElement>('.export-stage');
    const seq = ++previewSeq;
    stage.classList.add('loading');
    stage.classList.toggle('checker', !st.bg && (st.format === 'png' || st.format === 'svg'));
    try {
      if (st.format === 'md' || st.format === 'json') {
        const res = await fetch(url(st.format));
        if (seq !== previewSeq) return;
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Nothing to export');
        if (st.format === 'md') {
          stage.innerHTML = `<pre class="xmd">${esc((await res.text()).slice(0, 4000))}</pre>`;
        } else {
          const data = JSON.parse(await res.text()) as { items: unknown[]; blobs: Record<string, string> };
          const size = Number(res.headers.get('content-length')) || 0;
          stage.innerHTML = `<div class="xjson">${icon('save', 28)}<b>${data.items.length} items · ${Object.keys(data.blobs).length} images</b><span>Everything on the board${size ? `, ${(size / 1048576).toFixed(1)} MB` : ''}. Open it again with <em>Import board…</em> in the menu.</span></div>`;
        }
      } else {
        const img = new Image();
        img.alt = 'Preview';
        img.src = url('png', { max: '900', bg: st.format === 'pdf' ? '1' : st.bg ? '1' : '0' });
        await img.decode();
        if (seq !== previewSeq) return;
        stage.replaceChildren(img);
      }
    } catch (e) {
      if (seq !== previewSeq) return;
      stage.innerHTML = `<p class="xempty">${esc((e as Error).message?.includes('decode') ? 'Nothing to export yet' : (e as Error).message || 'Nothing to export yet')}</p>`;
    } finally {
      if (seq === previewSeq) stage.classList.remove('loading');
    }
  }

  async function save() {
    const f = fmt();
    const filename = `${cleanName(nameInput.value)}.${f.ext}`;
    let handle: FileSystemFileHandle | null = null;
    if (picker) {
      try {
        handle = await picker({ suggestedName: filename, types: [{ description: f.label === f.tag ? f.label : `${f.label} (${f.tag})`, accept: { [f.mime]: [f.accept] } }] });
      } catch (e) {
        if ((e as Error).name === 'AbortError') return; // closed the picker
        handle = null;
      }
    }
    const btn = $<HTMLButtonElement>('.xsave');
    btn.disabled = true;
    btn.querySelector('span')!.textContent = 'Exporting…';
    try {
      const res = await fetch(url(st.format));
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Export failed (${res.status})`);
      const blob = await res.blob();
      if (handle) {
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        toast(`Saved “${handle.name}”`);
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toast(`Downloaded “${filename}”`);
      }
      persist();
      close();
    } catch (e) {
      toast((e as Error).message);
      btn.disabled = false;
      btn.querySelector('span')!.textContent = picker ? 'Save as…' : 'Download';
    }
  }

  function close() {
    if (!sheet) return;
    const el = sheet;
    sheet = null;
    el.classList.remove('in');
    setTimeout(() => el.remove(), 180);
  }

  sheet.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (t.closest('[data-close]')) return close();
    const f = t.closest<HTMLElement>('[data-format]');
    if (f) { st.format = f.dataset.format as Format; return render(); }
    const o = t.closest<HTMLElement>('[data-key]');
    if (o) {
      const k = o.dataset.key as keyof State, v = o.dataset.val!;
      (st as unknown as Record<string, unknown>)[k] = k === 'scale' ? Number(v) : k === 'bg' ? v === 'true' : v;
      return render();
    }
    if (t.closest('.xsave')) void save();
  });
  sheet.addEventListener('pointerdown', (e) => { if (e.target === sheet) close(); });
  sheet.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && !(e.target as Element).closest('button')) { e.preventDefault(); void save(); }
  });
  render();
  $<HTMLElement>(`.xfmt[data-format="${st.format}"]`).focus();
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
