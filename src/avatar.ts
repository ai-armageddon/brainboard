import { JPEG_PREFIX, PICTURE_BYTES, PICTURE_PRESETS, PICTURE_SIZE, validPicture } from './profile-picture';

export function avatarFace(name: string, picture = '') {
  const preset = PICTURE_PRESETS.find(p => p.id === picture);
  if (preset) return `<span class="preset-face" aria-hidden="true">${preset.face}</span>`;
  if (picture.startsWith(JPEG_PREFIX) && validPicture(picture)) return `<img class="profile-photo" src="${picture}" alt="" draggable="false">`;
  const initials = name.trim().split(/\s+/).slice(0, 2).map(w => Array.from(w)[0] ?? '').join('').toUpperCase() || '?';
  return initials.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

export function picturePicker(picture: string) {
  const options = [{ id: '', label: 'Initials' }, ...PICTURE_PRESETS];
  return `<fieldset class="picture-picker"><legend>Profile picture</legend>
    <div class="picture-preview"><span class="avatar" data-preview></span>
    <button type="button" class="link-btn" data-upload>Upload photo</button>
    <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" hidden></div>
    <div class="picture-options">${options.map(p => `<label title="${p.label}">
      <input type="radio" name="picture" value="${p.id}" aria-label="${p.label}" ${picture === p.id ? 'checked' : ''}>
      <span>${p.id ? avatarFace('', p.id) : 'Aa'}</span></label>`).join('')}</div>
    <small role="status"></small></fieldset>`;
}

async function compressPhoto(file: File) {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(file.type)) {
    throw new Error('Choose a JPEG, PNG, WebP, GIF or AVIF image.');
  }
  if (file.size > 32 * 1024 * 1024) throw new Error('Choose an image smaller than 32 MiB.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => { throw new Error('Couldn’t read this image. Try another photo.'); });
    const crop = Math.min(img.naturalWidth, img.naturalHeight);
    const size = Math.min(PICTURE_SIZE, crop);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.naturalWidth - crop) / 2, (img.naturalHeight - crop) / 2, crop, crop, 0, 0, size, size);
    for (const quality of [0.84, 0.7, 0.55, 0.4, 0.25]) {
      const photo = canvas.toDataURL('image/jpeg', quality);
      if (validPicture(photo) && atob(photo.slice(JPEG_PREFIX.length)).length <= PICTURE_BYTES) return photo;
    }
    throw new Error('Couldn’t make this photo small enough. Try another image.');
  } finally { URL.revokeObjectURL(url); }
}

export function bindPicturePicker(form: HTMLFormElement, initial: string, fallbackName: string, fallbackColor: string) {
  let picture = initial;
  let revision = 0;
  const name = form.elements.namedItem('name') as HTMLInputElement;
  const file = form.querySelector<HTMLInputElement>('input[type=file]')!;
  const preview = form.querySelector<HTMLElement>('[data-preview]')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const status = form.querySelector<HTMLElement>('[role=status]')!;
  const refresh = () => {
    preview.innerHTML = avatarFace(name.value || fallbackName, picture);
    preview.style.setProperty('--c', form.querySelector<HTMLInputElement>('[name=color]:checked')?.value || fallbackColor);
  };
  refresh();
  form.addEventListener('input', e => {
    const input = e.target as HTMLInputElement;
    if (input.name === 'picture') {
      revision++;
      submit.disabled = false;
      status.textContent = '';
      picture = input.value;
    }
    if (input.name) refresh();
  });
  form.querySelector('[data-upload]')!.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const image = file.files?.[0];
    if (!image) return;
    file.value = '';
    const current = ++revision;
    submit.disabled = true;
    status.textContent = 'Preparing photo…';
    try {
      const photo = await compressPhoto(image);
      if (revision !== current) return;
      picture = photo;
      const checked = form.querySelector<HTMLInputElement>('[name=picture]:checked');
      if (checked) checked.checked = false;
      status.textContent = '';
      refresh();
    } catch (err) {
      if (revision === current) status.textContent = (err as Error).message;
    } finally { if (revision === current) submit.disabled = false; }
  });
  return () => picture;
}
