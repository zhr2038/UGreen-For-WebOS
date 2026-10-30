import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { createPairing } from '../tools/pair-code.mjs';

test('bridge isolates NAS credentials, forwards ranges and scopes playback to the paired client', async t => {
  const calls = []; const chunks = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  const poster = await sharp({ create: { width: 2000, height: 3000, channels: 3, background: '#225577' } }).png().toBuffer();
  const v = { ug_video_info_id: 1, category_id: 'sample', media_lib_set_id: 1, name: '示例影片', type: 1, duration: 300, file_path: ['/allowed.mkv'], poster_path: 'https://example.test/poster.webp', backdrop_path: 'https://example.test/backdrop.webp' };
  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.searchParams.get('token'), 'private-nas-token');
    if (url.pathname.endsWith('/raw/get')) {
      assert.equal(url.searchParams.get('video_path'), '/allowed.mkv'); calls.push({ range: req.headers.range });
      res.writeHead(206, { 'Content-Type': 'video/x-matroska', 'Content-Range': 'bytes 10-19/36', 'Content-Length': 10, 'Accept-Ranges': 'bytes' }); return res.end(req.method === 'HEAD' ? undefined : chunks.subarray(10, 20));
    }
    if (url.pathname.endsWith('/getImaStream')) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(poster); }
    if (url.pathname === '/ugreen/v5/photo/picture/stream') {
      if (url.searchParams.get('id') === '24') {
        assert.equal(req.method, 'GET'); assert.equal(url.searchParams.get('size_type'), '0');
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 10-19/36', 'Content-Length': 10 }); return res.end(chunks.subarray(10, 20));
      }
      assert.equal(url.searchParams.get('id'), '23'); assert.equal(url.searchParams.get('size_type'), '3');
      res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(poster);
    }
    let data = {};
    if (url.pathname.endsWith('/getMovie')) data = { video_info: v, file_information: [{ path: '/allowed.mkv', duration: 300 }], play_status: { current_play_time: 15, recently_played_file_path: '/allowed.mkv' } };
    if (url.pathname.endsWith('/homepage')) data = { recently_played_arr: { video_arr: [v] }, recently_update_arr: { video_arr: [v] } };
    if (url.pathname.endsWith('/slider')) data = { random_list: [v] };
    if (url.pathname.endsWith('/media_list')) data = { media_lib_info_list: [] };
    if (url.pathname === '/ugreen/v5/photo/picture/timeline/list') { let raw = ''; for await (const b of req) raw += b; assert.equal(JSON.parse(raw).limit, 48); data = { list: [{ picture_id: 23, file_name: 'sample.jpg', file_path: '/private/sample.jpg', width: 2000, height: 3000, show_type: 0 }, { picture_id: 24, file_name: 'clip.mov', show_type: 1 }], total: 2 }; }
    if (url.pathname.endsWith('/recently_played/create')) { let raw = ''; for await (const b of req) raw += b; calls.push({ progress: JSON.parse(raw) }); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 200, data }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const state = await mkdtemp(join(tmpdir(), 'lg-cinema-test-'));
  await writeFile(join(state, 'nas.json'), JSON.stringify({ server: `http://127.0.0.1:${upstream.address().port}`, token: 'private-nas-token', clientId: 'test', name: 'Test NAS' }));
  const portProbe = http.createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening'); const port = portProbe.address().port; await new Promise(r => portProbe.close(r));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, STATE_DIR: state, HOST: '127.0.0.1', PORT: String(port) }, stdio: 'pipe' });
  let log = ''; child.stderr.on('data', d => log += d);
  t.after(async () => { child.kill(); await once(child, 'exit').catch(() => {}); await new Promise(r => upstream.close(r)); await rm(state, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let n = 0; n < 80; n++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 25)); }
  assert.equal(log, '');
  assert.equal((await fetch(base + '/api/home')).status, 401);
  const code = (await readFile(join(state, 'pair-code'), 'utf8')).trim();
  const pair = async (value = code) => { const r = await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: value }) }); assert.equal(r.status, 200); return (await r.json()).token; };
  const token = await pair(); const other = await pair(); const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const home = await (await fetch(base + '/api/home', { headers })).json();
  assert.equal(home.hero[0].name, '示例影片'); assert.ok(!JSON.stringify(home).includes('private-nas-token'));
  const art = await fetch(base + home.hero[0].poster + '?client=' + token);
  assert.equal(art.headers.get('content-type'), 'image/webp');
  const posterMetadata = await sharp(Buffer.from(await art.arrayBuffer())).metadata();
  assert.equal(posterMetadata.width, 480); assert.equal(posterMetadata.height, 720);
  const response = await fetch(base + '/api/play', { method: 'POST', headers, body: JSON.stringify({ id: 1, type: 1, library: 1, path: '/etc/passwd' }) });
  assert.equal(response.status, 200); const play = await response.json(); assert.equal(play.position, 15);
  const range = await fetch(base + play.stream + '?client=' + token, { headers: { Range: 'bytes=10-19' } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), 'bytes 10-19/36'); assert.equal(await range.text(), 'abcdefghij');
  assert.equal(calls.find(c => c.range)?.range, 'bytes=10-19');
  assert.equal((await fetch(base + play.stream + '?client=' + other)).status, 404);
  assert.equal((await fetch(base + '/api/progress', { method: 'POST', headers, body: JSON.stringify({ id: play.id, position: 500, duration: 300 }) })).status, 400);
  const progress = await fetch(base + '/api/progress', { method: 'POST', headers, body: JSON.stringify({ id: play.id, position: 45, duration: 300 }) });
  assert.equal(progress.status, 200); assert.equal(calls.find(c => c.progress)?.progress.recently_played.current_play_time, 45);
  assert.equal((await fetch(base + '/../../.local/bridge/nas.json')).status, 404);
  const badPair = async value => fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: value }) });
  assert.equal((await badPair('１２３４５６')).status, 401);
  const renewed = await createPairing(state);
  assert.equal((await badPair(code)).status, 401);
  await pair(renewed.code);
  assert.equal((await fetch(base + '/api/status', { headers })).status, 200, 'rotating the pairing code preserves existing TV tokens');
  assert.equal((await fetch(base + '/api/photos/list')).status, 401);
  const photos = await (await fetch(base + '/api/photos/list', { headers })).json();
  assert.equal(photos.items[0].name, 'sample.jpg'); assert.ok(!JSON.stringify(photos).includes('/private/'));
  const photo = await fetch(base + photos.items[0].view + '?client=' + token);
  const photoMetadata = await sharp(Buffer.from(await photo.arrayBuffer())).metadata();
  assert.equal(photoMetadata.height, 1080); assert.equal(photoMetadata.width, 720);
  assert.equal((await fetch(base + photos.items[0].view + '?client=' + other)).status, 404);
  assert.equal((await fetch(base + photos.items[0].view)).status, 401);
  for (const method of ['GET', 'HEAD']) {
    const clip = await fetch(base + photos.items[1].stream + '?client=' + token, { method, headers: { Range: 'bytes=10-19' } });
    assert.equal(clip.status, 206); assert.equal(clip.headers.get('content-type'), 'video/mp4');
    assert.equal(clip.headers.get('content-range'), 'bytes 10-19/36');
    assert.equal(await clip.text(), method === 'HEAD' ? '' : 'abcdefghij');
  }
  assert.equal((await fetch(base + photos.items[1].stream + '?client=' + other)).status, 404);
  assert.equal((await fetch(base + '/api/photos/list?offset=-1', { headers })).status, 400);
  assert.equal((await fetch(base + '/api/photos/list', { method: 'POST', headers, body: '{}' })).status, 405);
  const expired = await createPairing(state, Date.now() - 16 * 60 * 1000);
  assert.equal((await badPair(expired.code)).status, 401);
});
