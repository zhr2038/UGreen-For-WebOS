import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import sharp from 'sharp';
const project = resolve(import.meta.dirname, '..'), session = 'artwork-proof-' + process.pid;
await mkdir(join(project, '.local'), { recursive: true }); await mkdir(join(project, 'output/playwright'), { recursive: true });
const [red, blue, wide, small] = await Promise.all([
  sharp({ create: { width: 2000, height: 3000, channels: 3, background: '#d01020' } }).jpeg({ quality: 90 }).toBuffer(),
  sharp({ create: { width: 900, height: 1600, channels: 3, background: '#1020d0' } }).jpeg({ quality: 90 }).toBuffer(),
  sharp({ create: { width: 3840, height: 2160, channels: 4, background: '#20a060' } }).png().toBuffer(),
  sharp({ create: { width: 160, height: 90, channels: 3, background: '#8844aa' } }).png().toBuffer(),
]);
let requests = {}, activeRequests = 0, maximumRequests = 0;
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (path === '/stats') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ requests, maximumRequests })); return; }
  if (path === '/reset-stats') { requests = {}; maximumRequests = activeRequests; res.end('{}'); return; }
  if (path === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#090a0d;color:white}.slot{position:relative;width:241px;height:357px}img{width:100%;height:100%;object-fit:cover}#grid{display:flex;gap:10px}.small{width:120px;height:180px}</style><main id="scene"></main><script src="/artwork.js"></script>'); return; }
  if (path === '/artwork.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(join(project, 'app/artwork.js'))); return; }
  const image = path.includes('blue') ? blue : path.includes('wide') ? wide : path.includes('small') ? small : red;
  requests[path] = (requests[path] || 0) + 1; activeRequests++; maximumRequests = Math.max(maximumRequests, activeRequests);
  let ended = false; res.once('close', () => { if (!ended) { ended = true; activeRequests--; } });
  res.setHeader('Content-Type', path.includes('wide') || path.includes('small') ? 'image/png' : 'image/jpeg'); res.setHeader('Content-Length', image.length); res.setHeader('Cache-Control', 'no-store');
  setTimeout(() => { if (!res.destroyed) res.end(image); }, path.includes('slow') ? 450 : 25);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;

async function artworkSuite(page) {
  const base = '__ART_BASE__', results = [];
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  await page.setViewportSize({ width: 1280, height: 900 });
  async function boot(config = {}) { await page.goto(base); await page.evaluate(config => { window.loader = createArtworkLoader(config); window.revoked = 0; const old = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = url => { window.revoked++; old(url); }; }, config); }
  async function image(kind, source, id = 'art', top = 0) { await page.evaluate(({kind,source,id,top}) => { const slot = document.createElement('div'); slot.className = 'slot'; if(top) {slot.style.position='absolute';slot.style.top=top+'px';} const img = document.createElement('img'); img.id=id;img.dataset.artKind=kind;img.dataset.artSource=location.origin+source;slot.appendChild(img);document.querySelector('#scene').appendChild(slot);loader.observe(document.querySelector('#scene')); }, {kind,source,id,top}); }
  const ready = id => page.waitForFunction(id => document.getElementById(id)?.dataset.artState === 'ready', id, {timeout:15000});
  async function test(name, fn) { try { await fn(); results.push({name,ok:true}); } catch (e) { results.push({name,ok:false,error:e.message}); } }

  await test('真实 2000x3000 JPEG 经 Worker 缩为 480x720，而页面从未使用原 URL', async () => {
    await boot(); await image('poster','/poster-red.jpg?client=test-capability-only'); await ready('art');
    const value = await page.$eval('#art', img => ({width:img.naturalWidth,height:img.naturalHeight,sourceWidth:img.dataset.sourceWidth,sourceHeight:img.dataset.sourceHeight,src:img.getAttribute('src'),processor:img.dataset.artProcessor}));
    assert(value.width===480&&value.height===720&&value.sourceWidth==='2000'&&value.sourceHeight==='3000','JPEG dimensions were not actually reduced'); assert(value.src.startsWith('blob:'),'Original URL reached IMG'); assert(value.processor==='worker','Worker path was not exercised');
    assert(await page.evaluate(()=>Object.keys(localStorage).length===0),'Capability URL was persisted');
  });
  await test('真实 4K PNG 的 cover/backdrop 分别满足界限且保持比例，小图不放大', async () => {
    await boot(); await image('cover','/wide.png','cover'); await image('backdrop','/wide.png','backdrop'); await image('poster','/small.png','small'); await ready('cover');await ready('backdrop');await ready('small');
    const dims=await page.evaluate(()=>['cover','backdrop','small'].map(id=>{const i=document.getElementById(id);return[i.naturalWidth,i.naturalHeight];}));
    assert(JSON.stringify(dims)===JSON.stringify([[720,405],[1920,1080],[160,90]]),'PNG ratio/limits/no-upscale failed');
  });
  await test('Worker 不可用时仍用异步 bitmap/小 canvas，关闭实际 bitmap', async () => {
    await boot({worker:false});await page.evaluate(()=>{window.closedBitmaps=0;const old=createImageBitmap;window.createImageBitmap=async (...args)=>{const b=await old(...args);const close=b.close.bind(b);b.close=()=>{window.closedBitmaps++;close();};return b;};});
    await image('poster','/fallback-red.jpg');await ready('art');const value=await page.$eval('#art',i=>({width:i.naturalWidth,height:i.naturalHeight,processor:i.dataset.artProcessor}));assert(value.processor==='main'&&value.width===480&&value.height===720,'Fallback gave original bitmap');assert(await page.evaluate(()=>closedBitmaps>0),'Bitmap was not closed');
  });
  await test('首次加载有可见状态；远离视口不取图，离屏撤销 URL 并释放 IMG', async () => {
    await boot();await image('poster','/slow-visible-red.jpg','first');await page.waitForSelector('.artwork-status');assert(await page.locator('.artwork-status').textContent()==='加载中…','Loading is invisible');await ready('first');await image('poster','/offscreen-blue.jpg','far',2600);await page.waitForTimeout(100);
    let stat=await page.evaluate(async()=>await(await fetch('/stats')).json());assert(!stat.requests['/offscreen-blue.jpg'],'Far image was requested');
    await page.evaluate(()=>{document.body.style.height='3200px';scrollTo(0,2300);});await ready('far');await page.waitForFunction(()=>!document.querySelector('#first').getAttribute('src'));assert(await page.evaluate(()=>revoked>0),'Offscreen URL was not revoked');
  });
  await test('忽略 abort 的迟到真实 JPEG 不会覆盖同一 IMG 的新蓝色源', async () => {
    await boot();await page.evaluate(()=>{loader.destroy();const native=fetch.bind(window);loader=createArtworkLoader({fetch:(url,options)=>native(url,{...options,signal:String(url).includes('slow-red')?undefined:options.signal})});});await image('poster','/slow-red.jpg');await page.waitForFunction(()=>loader.stats().active===1);
    await page.evaluate(()=>{const i=document.querySelector('#art');i.dataset.artSource=location.origin+'/blue.jpg';loader.sync([i]);loader.prioritize(i);});await ready('art');
    const value=await page.$eval('#art',i=>{const c=document.createElement('canvas');c.width=c.height=1;c.getContext('2d').drawImage(i,0,0,1,1);return{w:i.naturalWidth,h:i.naturalHeight,source:i.dataset.sourceWidth,color:Array.from(c.getContext('2d').getImageData(0,0,1,1).data)};});assert(value.w===405&&value.h===720&&value.source==='900'&&value.color[2]>value.color[0]*2,'Late red source contaminated blue image');
  });
  await test('真实压缩 Blob 的 LRU 有界，串行请求，clearAll 后缓存与 URL 均清空', async () => {
    await boot({worker:false,cacheBytes:6000});await page.evaluate(async()=>{await fetch('/reset-stats');const grid=document.createElement('div');grid.id='grid';document.querySelector('#scene').appendChild(grid);for(let n=0;n<7;n++){const slot=document.createElement('div');slot.className='slot small';slot.innerHTML='<img id="p'+n+'" data-art-kind="poster" data-art-source="'+location.origin+'/cache-'+n+'.jpg">';grid.appendChild(slot);}loader.observe(grid);});
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('#grid img')).every(i=>i.dataset.artState==='ready'),null,{timeout:15000});
    const value=await page.evaluate(async()=>({stats:loader.stats(),server:await(await fetch('/stats')).json()}));assert(value.stats.cacheBytes>0&&value.stats.cacheBytes<=6000&&value.stats.cacheEntries<7,'Compressed LRU is unbounded');assert(value.server.maximumRequests<=1,'Image requests were parallel');assert(value.stats.decodedTargetPixels===7*480*720,'Displayed images retain original dimensions');
    await page.evaluate(()=>loader.clearAll());assert(await page.evaluate(()=>loader.stats().cacheBytes===0&&loader.stats().activeUrls===0&&loader.stats().records===0),'clearAll did not release view/cache');
  });
  await test('换 NAS 代次后迟到任务不回填，原始照片绕开 artwork 管道', async () => {
    await boot();await page.evaluate(()=>{loader.destroy();const native=fetch.bind(window);loader=createArtworkLoader({fetch:(url,options)=>native(url,{...options,signal:undefined})});});await image('poster','/slow-clear-red.jpg');await page.waitForFunction(()=>loader.stats().active===1);await page.evaluate(()=>loader.clearAll());await page.waitForTimeout(600);assert(await page.evaluate(()=>!document.querySelector('#art').getAttribute('src')&&loader.stats().cacheBytes===0),'Old epoch refilled cleared view');
    await page.evaluate(()=>{const p=document.createElement('img');p.id='photo';p.dataset.artKind='photo';p.dataset.artSource=location.origin+'/wide.png';p.src=location.origin+'/wide.png';document.querySelector('#scene').appendChild(p);loader.observe(document.querySelector('#scene'));});await page.waitForFunction(()=>document.querySelector('#photo').naturalWidth===3840);assert(await page.$eval('#photo',i=>!i.getAttribute('src').startsWith('blob:')),'Original photo was downscaled');
  });
  await test('没有 bitmap 能力也不会退回将原图赋给页面 IMG', async () => {
    await boot({worker:false});await page.evaluate(()=>window.createImageBitmap=undefined);await image('poster','/no-bitmap-red.jpg');await page.waitForFunction(()=>document.querySelector('#art').dataset.artState==='error');assert(await page.$eval('#art',i=>!i.getAttribute('src')),'Unsafe original-image fallback occurred');await page.evaluate(()=>loader.destroy());
  });
  const report={passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length,cases:results};if(report.failed)throw new Error(JSON.stringify(report));return report;
}

const runtime = join(project, '.local/artwork-proof-runtime.js'); await writeFile(runtime, artworkSuite.toString().replace(/^async function artworkSuite\(page\)/,'async page =>').replace('__ART_BASE__',base));
let log='';async function cli(args){const p=spawn(process.execPath,[join(project,'node_modules/@playwright/cli/playwright-cli.js'),'-s='+session,...args],{cwd:project,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);const[status]=await once(p,'exit');log+=output;return{status,output};}
try{const opened=await cli(['open','about:blank','--browser=chrome']);if(opened.status)throw new Error(opened.output);const result=await cli(['run-code','--filename='+runtime]);const start=result.output.indexOf('### Result'),end=result.output.indexOf('### Ran Playwright code',start);console.log(start>=0?result.output.slice(start,end<0?undefined:end).trim():result.output);process.exitCode=result.status;}
finally{await cli(['close']);await new Promise(r=>server.close(r));await writeFile(join(project,'output/playwright/artwork-proof.log'),log);}
