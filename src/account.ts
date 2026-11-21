// Accounts in the UI: the sign-in sheet (passkeys first, email as a fallback), the "not saved yet" warning,
// and the screen-name prompt that collaboration needs. Nobody has to sign in to use brainboard.
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { S } from './state';
import { hooks } from './render';
import { account, api, events, isOwner, saveProfile, session, setAccount, type Account } from './net';
import { icon } from './icons';
import { paintLogos } from './brand';
import { toast } from './ui';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------- is this board at risk?

/** Saved = kept in an account or on this machine. Unsaved = tied only to this browser's anonymous identity. */
let boardSaved = true;

/** The current board lives only in this browser and has something on it. */
export const atRisk = () => !account.user && !session.invite && isOwner() && !boardSaved && S.items.length > 0;

async function refreshSaved() {
  if (!session.boardId || session.invite) { boardSaved = true; return render(); }
  try { boardSaved = (await api.me(session.boardId)).saved !== false; } catch { boardSaved = true; }
  render();
}

function render() {
  const anon = !account.user && !session.invite;
  const save = $('save-btn');
  save.hidden = !anon;
  save.classList.toggle('pulse', atRisk());
  const label = $('account-label');
  if (label) label.textContent = account.user ? 'Sign out' : 'Sign in or create account';
}

// ---------------------------------------------------------------- sheets

let sheet: HTMLDivElement | null = null;
let onClose: (() => void) | null = null;

function openSheet(html: string, cls = ''): HTMLDivElement {
  closeSheet();
  sheet = document.createElement('div');
  sheet.className = 'auth-backdrop';
  sheet.innerHTML = `<div class="auth-card ${cls}" role="dialog" aria-modal="true">
    <i class="auth-aura" aria-hidden="true"></i>
    <button class="auth-x" data-close aria-label="Close">${icon('close', 16)}</button>
    ${html}
  </div>`;
  document.body.append(sheet);
  paintLogos(sheet);
  sheet.addEventListener('pointerdown', (e) => { if (e.target === sheet) closeSheet(); });
  sheet.addEventListener('click', (e) => { if ((e.target as Element).closest('[data-close]')) closeSheet(); });
  sheet.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep typing away from canvas shortcuts
    if (e.key === 'Escape') closeSheet();
  });
  requestAnimationFrame(() => sheet?.classList.add('in'));
  return sheet;
}

function closeSheet() {
  if (!sheet) return;
  const el = sheet;
  sheet = null;
  el.classList.remove('in');
  setTimeout(() => el.remove(), 180);
  const cb = onClose;
  onClose = null;
  cb?.();
}

// ---------------------------------------------------------------- sign in / create account

type Mode = 'save' | 'signup' | 'signin';

const passkeysOk = () => account.passkeys && typeof window.PublicKeyCredential === 'function';

const COPY: Record<Mode, { eyebrow: string; title: string; sub: string }> = {
  save: {
    eyebrow: 'Save your work',
    title: 'Keep this board',
    sub: 'Right now your boards only live in this browser. Create a free account to keep them and open them anywhere.',
  },
  signup: { eyebrow: 'brainboard', title: 'Create your account', sub: 'Keep every board safe and open it on any device.' },
  signin: { eyebrow: 'brainboard', title: 'Welcome back', sub: 'Sign in to open your boards. Anything you made here comes with you.' },
};

export function openAuth(mode: Mode = 'signin') {
  const signup = mode !== 'signin';
  const c = COPY[mode];
  const pk = passkeysOk();
  const name = session.profile.name;
  const el = openSheet(`
    <div class="auth-head">
      <span class="logo big"></span>
      <div class="auth-eyebrow">${c.eyebrow}</div>
      <h2>${c.title}</h2>
      <p>${c.sub}</p>
    </div>
    <form class="auth-form" novalidate>
      ${signup ? `<label class="auth-field"><span>Screen name</span><input name="name" maxlength="40" autocomplete="nickname" placeholder="How collaborators see you" value="${esc(name)}" required /></label>` : ''}
      ${pk ? `<button type="button" class="auth-passkey" data-act="passkey">${icon('passkey', 19)}<span>${signup ? 'Create account with a passkey' : 'Sign in with a passkey'}</span></button>` : ''}
      ${pk ? `<button type="button" class="auth-or" data-act="email" aria-expanded="false"><span>or use email</span></button>` : ''}
      <div class="auth-email ${pk ? '' : 'open'}"><div class="auth-email-inner">
        <label class="auth-field"><span>Email</span><input name="email" type="email" autocomplete="email" placeholder="you@example.com" /></label>
        <label class="auth-field"><span>Password</span><input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="${signup ? 'At least 8 characters' : ''}" minlength="${signup ? 8 : 1}" /></label>
        <button type="submit" class="auth-submit">${icon('mail', 17)}<span>${signup ? 'Create account' : 'Sign in'}</span></button>
      </div></div>
      <p class="auth-error" role="alert"></p>
    </form>
    <p class="auth-switch">${signup
      ? 'Already have an account? <button type="button" data-act="signin">Sign in</button>'
      : 'New to brainboard? <button type="button" data-act="signup">Create an account</button>'}</p>
    ${pk ? '<p class="auth-fine">Passkeys use Face ID, Touch ID or your device PIN. Nothing to remember, nothing to leak.</p>' : ''}`, `mode-${mode}`);

  const form = el.querySelector<HTMLFormElement>('form')!;
  const err = el.querySelector<HTMLElement>('.auth-error')!;
  const field = (n: string) => form.elements.namedItem(n) as HTMLInputElement | null;
  const fail = (msg: string) => { err.textContent = msg; err.classList.add('show'); };
  const busy = (on: boolean) => form.querySelectorAll('button').forEach((b) => { b.disabled = on; });

  const done = (res: { user: Account; claimed: number }, verb: string) => {
    setAccount(res.user);
    boardSaved = true;
    closeSheet();
    toast(res.claimed ? `${verb} · ${res.claimed} board${res.claimed === 1 ? '' : 's'} saved to your account` : `${verb} as ${res.user.name}`);
    render();
  };

  el.addEventListener('click', async (e) => {
    const act = (e.target as Element).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'signin' || act === 'signup') return openAuth(act);
    if (act === 'email') {
      const box = el.querySelector('.auth-email')!;
      box.classList.toggle('open');
      el.querySelector('[data-act="email"]')!.setAttribute('aria-expanded', String(box.classList.contains('open')));
      if (box.classList.contains('open')) field('email')?.focus();
      return;
    }
    if (act !== 'passkey') return;
    err.classList.remove('show');
    const nm = field('name')?.value.trim() ?? '';
    if (signup && !nm) { field('name')?.focus(); return fail('Choose a screen name first.'); }
    busy(true);
    try {
      if (signup) {
        const { flow, options } = await api.auth<{ flow: string; options: never }>('passkey/register/options', { name: nm });
        const response = await startRegistration({ optionsJSON: options });
        done(await api.auth('passkey/register/verify', { flow, response }), 'Welcome');
      } else {
        const { flow, options } = await api.auth<{ flow: string; options: never }>('passkey/login/options');
        const response = await startAuthentication({ optionsJSON: options });
        done(await api.auth('passkey/login/verify', { flow, response }), 'Signed in');
      }
    } catch (e2) {
      const er = e2 as Error;
      if (er.name === 'NotAllowedError' || er.name === 'AbortError') fail('The passkey request was cancelled. Try again, or use email.');
      else if (er.name === 'InvalidStateError') fail('This device already has a brainboard passkey. Sign in instead.');
      else fail(er.message);
    } finally {
      busy(false);
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.remove('show');
    const email = field('email')!.value.trim();
    const password = field('password')!.value;
    const nm = field('name')?.value.trim() ?? '';
    if (signup && !nm) { field('name')?.focus(); return fail('Choose a screen name first.'); }
    if (!email) { field('email')!.focus(); return fail('Enter your email.'); }
    if (!password) { field('password')!.focus(); return fail('Enter a password.'); }
    busy(true);
    try {
      if (signup) done(await api.auth('signup', { name: nm, email, password }), 'Welcome');
      else done(await api.auth('login', { email, password }), 'Signed in');
    } catch (e2) {
      fail((e2 as Error).message);
    } finally {
      busy(false);
    }
  });

  (field('name') && !field('name')!.value ? field('name') : el.querySelector<HTMLElement>(pk ? '.auth-passkey' : 'input[name="email"]'))?.focus();
}

export async function signOut() {
  try { await api.auth('logout'); } catch { /* ignore */ }
  location.reload();
}

/** Add another passkey to the signed-in account (e.g. on a second device). */
export async function addPasskey() {
  if (!account.user || !passkeysOk()) return;
  try {
    const { flow, options } = await api.auth<{ flow: string; options: never }>('passkey/register/options', {});
    const response = await startRegistration({ optionsJSON: options });
    const res = await api.auth('passkey/register/verify', { flow, response });
    setAccount(res.user);
    toast('Passkey added');
  } catch (e) {
    const er = e as Error;
    toast(er.name === 'NotAllowedError' ? 'Passkey cancelled' : er.name === 'InvalidStateError' ? 'This device already has a passkey for your account' : er.message);
  }
}

// ---------------------------------------------------------------- "not saved yet" warning

let nudged = false;
try { nudged = sessionStorage.getItem('bb-nudged') === '1'; } catch { /* ignore */ }

export function openSaveWarning() {
  nudged = true;
  try { sessionStorage.setItem('bb-nudged', '1'); } catch { /* ignore */ }
  const n = S.items.length;
  const el = openSheet(`
    <div class="warn-icon">${icon('save', 22)}</div>
    <div class="auth-eyebrow">Not saved yet</div>
    <h2>Don’t lose “${esc(session.boardName || 'this board')}”</h2>
    <p class="warn-body">${n === 1 ? 'Its one item only lives' : `Its ${n} items only live`} in this browser. Clear your browsing data or switch devices and it’s gone. Saving takes a few seconds.</p>
    <div class="warn-actions">
      <button class="auth-passkey" data-act="save">${icon('save', 18)}<span>Save board</span></button>
      <button class="warn-later" data-close>Keep working</button>
    </div>`, 'warn');
  el.querySelector('[data-act="save"]')!.addEventListener('click', () => openAuth('save'));
}

/** ⌘S and :w */
export function saveCommand() {
  if (atRisk() || (!account.user && !session.invite && isOwner() && !boardSaved)) return openAuth('save');
  if (account.user) toast(`Saved to ${account.user.name}’s account · changes save as you go`);
  else toast('Saved · changes save as you go');
}

// ---------------------------------------------------------------- screen name (needed to collaborate)

export function ensureScreenName(why = 'collaborate'): Promise<boolean> {
  if (account.user || session.profile.name) return Promise.resolve(true);
  return new Promise((resolve) => {
    let ok = false;
    const el = openSheet(`
      <div class="auth-head">
        <div class="auth-eyebrow">Before you ${why}</div>
        <h2>Pick a screen name</h2>
        <p>It’s how people see your cursor and edits. No account needed.</p>
      </div>
      <form class="auth-form">
        <label class="auth-field"><span>Screen name</span><input name="name" maxlength="40" autocomplete="nickname" placeholder="e.g. Sam" required /></label>
        <button type="submit" class="auth-passkey"><span>Continue</span></button>
        <p class="auth-switch">Want to keep your boards too? <button type="button" data-act="signup">Create an account</button></p>
      </form>`, 'name');
    onClose = () => resolve(ok);
    const form = el.querySelector('form')!;
    const input = form.querySelector('input')!;
    input.focus();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return input.focus();
      saveProfile(v, session.profile.color);
      ok = true;
      closeSheet();
    });
    el.querySelector('[data-act="signup"]')!.addEventListener('click', () => { onClose = null; resolve(false); openAuth('signup'); });
  });
}

// ---------------------------------------------------------------- wiring

export function initAccount() {
  $('save-btn').insertAdjacentHTML('afterbegin', icon('save', 17));
  $('save-btn').addEventListener('click', () => openAuth('save'));

  events.addEventListener('account', render);
  events.addEventListener('welcome', () => void refreshSaved());
  events.addEventListener('role', render);

  // ⌘S / Ctrl+S
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!sheet) saveCommand();
    }
  }, true);

  // About to leave (pointer heads for the tab bar or window controls) with an unsaved board.
  document.addEventListener('mouseout', (e) => {
    if (e.relatedTarget || e.clientY > 8 || nudged || sheet || !atRisk()) return;
    openSaveWarning();
  });

  // Keep the Save button's attention cue in step with the board's contents.
  let last = false;
  const prev = hooks.afterRender;
  hooks.afterRender = () => {
    prev();
    const r = atRisk();
    if (r !== last) { last = r; render(); }
  };
  render();
}
