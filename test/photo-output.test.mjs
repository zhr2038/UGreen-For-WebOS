import test from 'node:test';
import assert from 'node:assert/strict';
import { PHOTO_GRAPHICS_LIMIT, photoOutputInfo, nativePhotoRequest } from '../lib/photo-output.mjs';

test('original file dimensions are kept distinct from the web graphics output limit', () => {
  const output = photoOutputInfo({ format: 'heic', width: 4032, height: 3024 });
  assert.equal(output.originalWidth, 4032); assert.equal(output.mime, 'image/heic'); assert.equal(output.nativeUhdConfirmed, false);
  assert.deepEqual(output.graphicsLimit, { width: 1920, height: 1080 }); assert.equal(output.browserOriginalCandidate, false);
  assert.equal(photoOutputInfo({ format: 'jpg' }).browserOriginalCandidate, true);
  assert.ok(Object.isFrozen(PHOTO_GRAPHICS_LIMIT));
});

test('native viewer preparation only accepts this TV service original capabilities and performs no launch', () => {
  const target = 'http://127.0.0.1:1234/photo-original/' + 'a'.repeat(40) + '?client=local-capability';
  const request = nativePhotoRequest(target, { name: '示例照片', format: 'jpg' });
  assert.equal(request.uri, 'ssap://media.viewer/open'); assert.equal(request.payload.target, target); assert.equal(request.payload.mimeType, 'image/jpeg');
  for (const url of ['https://example.test/photo.jpg', target.replace('127.0.0.1', '192.168.1.1'), target.replace('photo-original', 'media'), target.split('?')[0]]) assert.throws(() => nativePhotoRequest(url, { format: 'jpg' }));
  assert.throws(() => nativePhotoRequest(target, { format: 'cr2' }));
});
