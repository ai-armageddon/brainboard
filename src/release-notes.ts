import { version } from '../package.json';
import { releases, releaseChanges } from './releases';

import { startTour } from './tour';

export function initReleaseNotes() {
  const dialog = document.querySelector<HTMLDialogElement>('#release-notes')!;
  const latest = releases[0];
  dialog.querySelector('h3')!.textContent = latest.title;
  dialog.querySelector('[data-release-details]')!.append(releaseChanges(latest.changes));
  const link = dialog.querySelector<HTMLAnchorElement>('a')!;
  link.href = import.meta.env.VITE_CHANGELOG_URL?.trim() || '/changelog/';
  for (const label of document.querySelectorAll('[data-version]')) label.textContent = `v${version}`;
  let opener: HTMLButtonElement | undefined;
  dialog.addEventListener('close', () => {
    if (opener?.closest('#menu')) document.getElementById('menu-btn')?.focus();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-release-notes]')) {
    button.setAttribute('aria-label', `What's new in Brainboard v${version}`);
    button.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Tab') e.stopPropagation();
    });
    button.addEventListener('click', () => {
      opener = button;
      dialog.showModal();
    });
  }
  document.getElementById('release-tour')!.addEventListener('click', () => {
    dialog.addEventListener('close', () => startTour('latest'), { once: true });
    dialog.close();
  });
  // Keep board keyboard and clipboard shortcuts out of the open dialog.
  for (const type of ['keydown', 'copy', 'cut', 'paste']) dialog.addEventListener(type, (e) => e.stopPropagation());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      const box = dialog.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) dialog.close();
    }
  });
}
