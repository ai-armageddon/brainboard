// Placeholders for images that are still uploading. The pasted picture shows up right away, dimmed with a progress
// bar, exactly where it will land; it hands over to the real image once that has loaded from the server.
// Placeholders are local to this tab and never saved.
import { nodeElOf } from './render';
import { requestRender } from './state';
import type { Box } from './types';

const layer = document.getElementById('items')!;
let pending = 0;
/** Images still on their way up (the empty-board welcome stays hidden meanwhile). */
export const uploadsPending = () => pending > 0;

export interface Uploading {
  progress(fraction: number): void;
  /** The upload finished as item `id`: fade out once that image is on screen. */
  done(id: string): void;
  /** The upload failed: take the placeholder away. */
  fail(): void;
}

export function showUploading(previewUrl: string, box: Box): Uploading {
  const el = document.createElement('div');
  el.className = 'item image uploading';
  el.setAttribute('aria-label', 'Uploading image');
  el.style.transform = `translate(${box.x}px,${box.y}px)`;
  el.style.width = `${box.w}px`;
  el.style.height = `${box.h}px`;
  const img = document.createElement('img');
  img.src = previewUrl;
  img.alt = '';
  img.draggable = false;
  const label = document.createElement('div');
  label.className = 'upload-label';
  label.innerHTML = '<span class="upload-spin"></span><span>Uploading…</span>';
  const text = label.lastElementChild!;
  const bar = document.createElement('div');
  bar.className = 'upload-bar';
  bar.append(document.createElement('i'));
  el.append(img, label, bar);
  layer.append(el);
  pending++;
  requestRender();

  let gone = false;
  const remove = (fade: boolean) => {
    if (gone) return;
    gone = true;
    pending--;
    requestRender();
    const finish = () => { el.remove(); URL.revokeObjectURL(previewUrl); };
    if (!fade) return finish();
    el.classList.add('leaving');
    setTimeout(finish, 180);
  };

  return {
    progress(f) {
      bar.classList.add('known');
      const pct = Math.round(Math.min(1, Math.max(0, f)) * 100);
      bar.style.setProperty('--p', `${pct}%`);
      text.textContent = pct >= 100 ? 'Finishing…' : `Uploading ${pct}%`;
    },
    done(id) {
      bar.classList.add('known');
      bar.style.setProperty('--p', '100%');
      text.textContent = 'Finishing…';
      // Wait for the real image to be drawn, so there's never a blank moment. Give up after a while regardless.
      const started = performance.now();
      let listening = false;
      const check = () => {
        if (gone) return;
        const real = nodeElOf(id)?.querySelector('img');
        if (real?.complete && real.naturalWidth) return remove(true);
        if (performance.now() - started > 10_000) return remove(true);
        if (real && !listening) {
          listening = true;
          real.addEventListener('load', () => remove(true), { once: true });
          real.addEventListener('error', () => remove(true), { once: true });
        }
        requestAnimationFrame(check);
      };
      check();
    },
    fail() { remove(false); },
  };
}
