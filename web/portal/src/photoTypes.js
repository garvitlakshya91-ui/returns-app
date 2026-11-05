// Must match PHOTO_TYPES in app/routes/api/portal.js: the server refuses
// anything else, so the picker should not offer it in the first place.
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

const TYPE_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };

// Some browsers report no type for HEIC files; fall back to the extension.
export function photoFileType(file) {
  if (file.type) return file.type.toLowerCase();
  const ext = (file.name || '').split('.').pop()?.toLowerCase();
  return TYPE_BY_EXT[ext] || '';
}
