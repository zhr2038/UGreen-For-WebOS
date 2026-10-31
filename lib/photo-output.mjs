// LG documents a 1920×1080 graphics plane and a separate UHD video plane.
// Delivering the original photo must not be reported as proof of UHD output.
export const PHOTO_GRAPHICS_LIMIT = Object.freeze({ width: 1920, height: 1080 });

export function photoMime(extension) {
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif' })[String(extension || '').toLowerCase()] || 'application/octet-stream';
}

export function photoOutputInfo(photo) {
  const format = String(photo.format || '').toLowerCase();
  return {
    originalWidth: Math.max(0, Number(photo.width) || 0), originalHeight: Math.max(0, Number(photo.height) || 0),
    mime: photoMime(format),
    // These common web image formats are only a decode hint. The client still
    // handles load errors and never silently substitutes a preview for original.
    browserOriginalCandidate: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(format),
    graphicsLimit: PHOTO_GRAPHICS_LIMIT,
    nativeUhdConfirmed: false,
  };
}

// Candidate adapter for LG's published ConnectSDK media.viewer/open contract.
// A caller must separately obtain TV pairing/permission and validate its actual
// image viewer and resolution. This pure builder never launches another app.
export function nativePhotoRequest(url, photo = {}) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password || !/^\/photo-original\/[a-f0-9]{40}$/.test(target.pathname) || !target.searchParams.get('client')) throw new Error('原生照片查看只接受本机已授权的原图链接');
  const mimeType = photoMime(photo.format);
  if (!mimeType.startsWith('image/')) throw new Error('此原图格式尚未确认可由电视原生查看器处理');
  return { uri: 'ssap://media.viewer/open', payload: { target: target.href, title: String(photo.name || '照片').slice(0, 256), description: '', mimeType, iconSrc: '' } };
}
