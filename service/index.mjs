import Service from 'webos-service';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createBridge } from '../lib/bridge.mjs';
import { DirectConnection } from '../lib/direct.mjs';
import { NativeThumbnails } from '../lib/native-images.mjs';
import { AdaptiveNas } from '../lib/adaptive-nas.mjs';
import { createTvState } from '../lib/tv-state.mjs';
import {isCompanionCaller} from '../lib/service-caller.mjs';
import {createServiceNativeFactory} from '../lib/native-service.mjs';
import { createPrivateState } from '../lib/private-state.mjs';
import { audioHelperConfig } from '../lib/movie-audio-helper.mjs';

const serviceDir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
const service = new Service('top.hrhome.nascinema.service');
const storage = createTvState({ legacyDir: join(serviceDir, '.state') });
const dir = storage.dir;
const audioFile = 'movie-audio-helper.json';
const audioStorage = createPrivateState({ dir, trustedDir: dir, files: [audioFile], maxBytes: 8192 });
const config = {};
const subscribers = new Set();
let starting, transportOwner, bridgeOwner, controlOwner, audioHelper, idleResetTimer = null, shuttingDown = false;
async function start() {
  if (!starting) starting = (async () => {
    // Validate the real service UID's writable private data volume before
    // copying anything from an older package. Migration verifies every copy
    // and fsyncs it before removing the corresponding legacy state file.
    await storage.checkWritable();
    try { await storage.migrate(); }
    catch (error) {
      // Malformed/unreadable legacy .state from a previous package should not
      // lock out fresh logins on an otherwise clean private state volume.
      if (!['TV_STATE_INVALID_LEGACY', 'ENOENT', 'EACCES'].includes(error?.code) && !String(error?.code || '').startsWith('PRIVATE_STATE_')) throw error;
    }
    try {
      const record = await audioStorage.readVersioned(audioFile);
      if (record) audioHelper = audioHelperConfig(JSON.parse(record.value));
    } catch { /* Optional local audio helper. */ }
    const control = new DirectConnection({ dir, config }); controlOwner = control; await control.load();
    const nativeFactory=createServiceNativeFactory({service,stateDir:dir,assetDir:join(serviceDir,'native-assets')});
    const transport = new AdaptiveNas(config,{nativeFactory});transportOwner=transport;
    const token = randomBytes(32).toString('hex');
    const bridge = await createBridge({ dir, config, control, thumbnails: new NativeThumbnails(), host: '127.0.0.1', port: 0, clientToken: token, nasClient: transport, getAudioHelper: () => audioHelper });
    bridgeOwner = bridge;
    transport.select().catch(() => {});
    control.onChange = () => { bridge.reset(); transport.reset(); transport.select().catch(() => {}); };
    return { server: 'http://127.0.0.1:' + bridge.server.address().port, token, runtimeVersion: '0.5.6', ...control.status() };
  })().catch(error => { starting = null; throw error; });
  return starting;
}
function cancelSubscriber(message) {
  subscribers.delete(message?.uniqueToken || message);
  if (subscribers.size > 0) return;
  controlOwner?.cancel?.();
  if (transportOwner?.visibilityScope) {
    try {
      transportOwner.setVisibility({ visible: false, scope: transportOwner.visibilityScope() });
    } catch {}
  }
  clearTimeout(idleResetTimer);
  idleResetTimer = setTimeout(() => {
    idleResetTimer = null;
    if (subscribers.size === 0) bridgeOwner?.reset?.().catch(() => {});
  }, 5000);
  idleResetTimer.unref?.();
}
// The app holds this subscription while open. Cancelling it lets webOS apply
// its normal idle lifecycle instead of leaving a permanent background daemon.
service.register('start', message => {
  if (!isCompanionCaller(message)) return message.respond({ returnValue: false, errorText: 'Only the companion app may start this service' });
  clearTimeout(idleResetTimer); idleResetTimer = null;
  if (message.isSubscription) subscribers.add(message.uniqueToken || message);
  start().then(result => message.respond({ returnValue: true, subscribed: Boolean(message.isSubscription), ...result })).catch(() => message.respond({ returnValue: false, errorText: '电视连接服务启动失败' }));
}, cancelSubscriber);
service.register('configureMovieAudio', message => {
  if (!isCompanionCaller(message)) return message.respond({ returnValue: false, errorText: 'Only the companion app may configure audio' });
  Promise.resolve().then(async () => {
    const value = audioHelperConfig(message.payload);
    await start();
    await audioStorage.write(audioFile, JSON.stringify(value));
    audioHelper = value;
    message.respond({ returnValue: true });
  }).catch(() => message.respond({ returnValue: false, errorText: '兼容音轨设置未保存' }));
});

process.on('exit',()=>transportOwner?.close());
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(idleResetTimer);
  controlOwner?.cancel?.();
  Promise.race([
    Promise.allSettled([bridgeOwner?.reset?.(), Promise.resolve(transportOwner?.close?.())]),
    new Promise(resolve => setTimeout(resolve, 1500)),
  ]).finally(() => process.exit(0));
});
