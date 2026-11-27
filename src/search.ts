// The palette invokes the same controls as the toolbar and menu so their normal behavior applies.
import { navigateToBoard } from './boards';
import { closeHome } from './home';
import { icon } from './icons';
import { api, canEdit, session } from './net';
import { closePopovers } from './ui';

interface Result { name: string; detail: string; symbol: string; run: () => void }

function commands(query: string): Result[] {
  const words = query.toLowerCase().split(/\s+/);
  const results: Result[] = [];
  const buttons = document.querySelectorAll<HTMLButtonElement>('#toolbar button, #menu [data-action], #menu [data-release-notes]');
  for (const button of buttons) {
    if (button.disabled || button.dataset.action === 'search' || button.closest('[hidden]:not(#menu)')) continue;
    if (session.invite && button.closest('.owner-only')) continue;
    if (!canEdit() && button.classList.contains('edit-tool')) continue;
    if (getComputedStyle(button).display === 'none') continue;
    const label = button.cloneNode(true) as HTMLElement;
    label.querySelectorAll('kbd, .muted, [data-version]').forEach(el => el.remove());
    const name = button.getAttribute('aria-label') || label.textContent!.trim();
    const keywords = [name, button.dataset.tool, button.dataset.action, button.dataset.tip].join(' ').toLowerCase();
    if (!words.every(word => keywords.includes(word))) continue;
    const tool = !!button.closest('#toolbar');
    results.push({ name, detail: tool ? 'Tool' : 'Menu', symbol: button.dataset.icon || 'chevronRight', run: () => button.click() });
  }
  return results;
}

export function initSearch() {
  const dialog = document.querySelector<HTMLDialogElement>('#board-search')!;
  const input = dialog.querySelector('input')!;
  const list = dialog.querySelector<HTMLElement>('[role=listbox]')!;
  const status = dialog.querySelector<HTMLElement>('[role=status]')!;
  let rows: Result[] = [];
  let selected = 0;
  let timer = 0;
  let request: AbortController | undefined;

  function select(index: number, scroll = false) {
    selected = index;
    for (const [i, el] of Array.from(list.children).entries()) el.setAttribute('aria-selected', String(i === index));
    const option = list.children[index];
    if (!option) { input.removeAttribute('aria-activedescendant'); return; }
    input.setAttribute('aria-activedescendant', option.id);
    if (scroll) option.scrollIntoView({ block: 'nearest' });
  }

  function render(next: Result[], message: string) {
    rows = next;
    list.replaceChildren(...rows.map((row, i) => {
      const option = document.createElement('div');
      option.id = `search-option-${i}`;
      option.setAttribute('role', 'option');
      option.dataset.index = String(i);
      option.innerHTML = `${icon(row.symbol, 17)}<span><strong></strong><small></small></span>`;
      option.querySelector('strong')!.textContent = row.name;
      option.querySelector('small')!.textContent = row.detail;
      return option;
    }));
    status.textContent = message;
    status.hidden = !message;
    select(Math.min(selected, Math.max(0, rows.length - 1)));
  }

  function cancelRequest() {
    clearTimeout(timer);
    request?.abort();
  }

  function update() {
    cancelRequest();
    selected = 0;
    list.scrollTop = 0;
    const query = input.value.trim();
    const actions = commands(query);
    render(actions, query ? 'Searching boards…' : '');
    if (!query) return;
    const controller = new AbortController();
    request = controller;
    timer = window.setTimeout(async () => {
      try {
        const hits = await api.searchBoards(query, controller.signal);
        if (!dialog.open || controller.signal.aborted) return;
        const boards = hits.map((hit): Result => ({
          name: hit.name, detail: hit.excerpt || (hit.token ? 'Shared board' : 'Board'),
          symbol: hit.token ? 'users' : 'views', run: () => navigateToBoard(hit.id, hit.name, hit.token),
        }));
        render([...actions, ...boards], actions.length || boards.length ? '' : 'No matches');
      } catch {
        if (!controller.signal.aborted && dialog.open) render(actions, 'Board search is unavailable.');
      }
    }, 160);
  }

  function open() {
    if (dialog.open) { input.focus(); return true; }
    if (!session.boardId && !session.draft) return false;
    if (document.querySelector('dialog[open], .auth-backdrop, body.shooting, #overlay:not([hidden]), #share:not([hidden]), #shortcuts:not([hidden])')) return false;
    closeHome();
    closePopovers();
    input.value = '';
    dialog.showModal();
    input.focus();
    update();
    return true;
  }

  function activate(index: number) {
    const row = rows[index];
    if (!row) return;
    dialog.close();
    row.run();
  }

  document.querySelector('#menu [data-action="search"]')!.addEventListener('click', open);
  window.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'k') return;
    if (open()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  dialog.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.isComposing || event.target !== input) return;
    if (event.key === 'Enter') { event.preventDefault(); activate(selected); }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && rows.length) {
      event.preventDefault();
      select((selected + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length, true);
    }
  });
  dialog.addEventListener('close', cancelRequest);
  dialog.querySelector('button')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
  list.addEventListener('click', e => {
    const option = (e.target as Element).closest<HTMLElement>('[data-index]');
    if (option) activate(Number(option.dataset.index));
  });
  input.addEventListener('input', update);
}
