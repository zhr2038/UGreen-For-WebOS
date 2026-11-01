import Service from 'webos-service';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createBridge } from '../lib/bridge.mjs';
import { DirectConnection } from '../lib/direct.mjs';
import { NativeThumbnails } from '../lib/native-images.mjs';
import { AdaptiveNas } from '../lib/adaptive-nas.mjs';
import { createTvState } from '../lib/tv-state.mjs';
import {isCompanionCaller} from '../lib/service-caller.mjs';
import {createServiceNativeFactory} from '../lib/native-service.mjs';

const service = new Service('top.hrhome.nascinema.service');
const storage = createTvState({ legacyDir: join(__dirname, '.state') });
const dir = storage.dir;
const config = {};
let starting,transportOwner;
async function start() {
  if (!starting) starting = (async () => {
    // Validate the real service UID's writable private data volume before
    // copying anything from an older package. Migration verifies every copy
    // and fsyncs it before removing the corresponding legacy state file.
    await storage.checkWritable();
    await storage.migrate();
    const control = new DirectConnection({ dir, config }); await control.load();
    const nativeFactory=createServiceNativeFactory({service,stateDir:dir,assetDir:join(__dirname,'native-assets')});
    const transport = new AdaptiveNas(config,{nativeFactory});transportOwner=transport;
    const token = randomBytes(32).toString('hex');
    const bridge = await createBridge({ dir, config, control, thumbnails: new NativeThumbnails(), host: '127.0.0.1', port: 0, clientToken: token, nasClient: transport });
    transport.select().catch(() => {});
    control.onChange = () => { bridge.reset(); transport.reset(); transport.select().catch(() => {}); };
    return { server: 'http://127.0.0.1:' + bridge.server.address().port, token, runtimeVersion: '0.5.0', ...control.status() };
  })().catch(error => { starting = null; throw error; });
  return starting;
}
// The app holds this subscription while open. Cancelling it lets webOS apply
// its normal idle lifecycle instead of leaving a permanent background daemon.
service.register('start', message => {
  if (!isCompanionCaller(message)) return message.respond({ returnValue: false, errorText: 'Only the companion app may start this service' });
  start().then(result => message.respond({ returnValue: true, subscribed: Boolean(message.isSubscription), ...result })).catch(() => message.respond({ returnValue: false, errorText: '电视连接服务启动失败' }));
});

process.on('exit',()=>transportOwner?.close());
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{transportOwner?.close();process.exit(0);});
