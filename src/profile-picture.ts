// Profile pictures travel with the profile. Presets only need a short ID.
export const PICTURE_PRESETS = [
  { id: 'fox', label: 'Fox', face: '🦊' }, { id: 'frog', label: 'Frog', face: '🐸' },
  { id: 'koala', label: 'Koala', face: '🐨' }, { id: 'panda', label: 'Panda', face: '🐼' },
  { id: 'penguin', label: 'Penguin', face: '🐧' }, { id: 'octopus', label: 'Octopus', face: '🐙' },
];
export const PICTURE_SIZE = 128;
export const PICTURE_BYTES = 8 * 1024;
export const JPEG_PREFIX = 'data:image/jpeg;base64,';

export function validPicture(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!value || PICTURE_PRESETS.some(p => p.id === value)) return true;
  return value.length <= JPEG_PREFIX.length + 4 * Math.ceil(PICTURE_BYTES / 3)
    && /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(value);
}
