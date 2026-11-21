import { JPEG_PREFIX, PICTURE_BYTES, PICTURE_SIZE, validPicture } from '../src/profile-picture.ts';
import { imageSize } from './store.ts';

export function acceptsPicture(value: unknown): value is string {
  if (!validPicture(value)) return false;
  if (!value.startsWith(JPEG_PREFIX)) return true;
  const bytes = Buffer.from(value.slice(JPEG_PREFIX.length), 'base64');
  if (bytes.length > PICTURE_BYTES || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false;
  const size = imageSize(bytes);
  return !!size && size.w > 0 && size.w <= PICTURE_SIZE && size.h === size.w;
}
