import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { UgOS } from './ugos.mjs';
import { PlaybackSession, decodeSubtitle } from './playback.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const cancelled = () => Object.assign(fail('播放操作已取消', 410), { name: 'AbortError' });
const token = () => randomBytes(20).toString('hex');
const identityKeys = ['server', 'alias', 'token', 'staticToken', 'clientId', 'username', 'uid', 'authMode', 'tlsFingerprint', 'nasPublicRsa'];
const transport = Symbol('owned movie transport');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const modes = new Set(['sort_list','loop_list','loop_single']);
const fits = new Set(['contain','cover','fill']);
const rates = new Set([.5,.75,1,1.25,1.5,2]);
const safeText = value => typeof value === 'string' && value.length <= 80 && !/[\x00-\x1f/\\?&<>]/.test(value);
const safeExternalLabel = value => typeof value === 'string' && value.trim() && value.length <= 240 && !/[\x00-\x1f/\\?&<>]/.test(value);
const safeLanguage = value => typeof value === 'string' && (value === '' || /^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})?$/.test(value));
const defaults = () => ({ mode:'sort_list', rate:1, fit:'contain', subtitle:{offset:0,size:100,color:'#FFFFFF',position:90,language:''} });

/** Strict ordinary preferences; this is not a NAS path or credential store. */
export function validateMoviePreferences(value) {
  if (!plain(value)) throw fail('无效的播放偏好'); const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'mode' && modes.has(item) || key === 'fit' && fits.has(item) || key === 'rate' && rates.has(item)) out[key] = item;
    else if (key === 'audio') out.audio = validateTrack(item);
    else if (key === 'subtitle') {
      if (!plain(item)) throw fail('无效的字幕偏好'); const subtitle = {};
      for (const [name, setting] of Object.entries(item)) {
        if (name === 'offset' && Number.isFinite(setting) && Math.abs(setting) <= 600 || name === 'size' && Number.isFinite(setting) && setting >= 50 && setting <= 200 || name === 'position' && Number.isFinite(setting) && setting >= 5 && setting <= 95 || ['opacity','background'].includes(name) && Number.isFinite(setting) && setting >= 0 && setting <= 1 || name === 'outline' && typeof setting === 'boolean' || name === 'color' && /^#[0-9a-f]{6}$/i.test(setting) || name === 'language' && safeLanguage(setting)) subtitle[name] = setting;
        else if (name === 'selection') {
          if (!plain(setting) || !['off','native','external'].includes(setting.kind)) throw fail('无效的字幕选择');
          if(setting.kind==='off'){if(Object.keys(setting).length!==1)throw fail('无效的关闭字幕偏好');subtitle.selection={kind:'off'};}
          else if(setting.kind==='external'){if(!safeExternalLabel(setting.label)||Object.keys(setting).some(k=>!['kind','label','language'].includes(k))||setting.language!==undefined&&!safeLanguage(setting.language))throw fail('无效的外挂字幕偏好');subtitle.selection={kind:'external',label:setting.label,...(setting.language===undefined?{}:{language:setting.language})};}
          else subtitle.selection={kind:'native',...validateTrack(Object.fromEntries(Object.entries(setting).filter(([k])=>k!=='kind')))};
        }
        else throw fail('不支持的字幕偏好字段');
      }
      out.subtitle = subtitle;
    } else throw fail('不支持的播放偏好字段');
  }
  return out;
}
function validateTrack(value) {
  if (!plain(value)) throw fail('无效的轨道偏好'); const out = {};
  for (const [name, item] of Object.entries(value)) {
    if (name === 'label' && safeText(item) || name === 'language' && safeLanguage(item) || name === 'index' && Number.isInteger(item) && item >= 0 && item < 100000 || name === 'count' && Number.isInteger(item) && item >= 0 && item < 100000) out[name] = item;
    else throw fail('不支持的轨道偏好字段');
  }
  return out;
}
function mergePrefs(current, patch) { return {...current,...patch,subtitle:{...(current.subtitle||{}),...(patch.subtitle||{})}}; }

function captureNas(upstream, expected) {
  if (!upstream?.config) throw fail('NAS 没有可保存的播放连接', 503);
  const baseline = Object.fromEntries(identityKeys.map(key => [key, upstream.config[key]]));
  const raw = typeof upstream.snapshot === 'function' ? upstream.snapshot() : new UgOS({...upstream.config});
  const origin = upstream[transport] || upstream;
  if (!raw || raw === origin || raw.httpsAgent && raw.httpsAgent === origin.httpsAgent || typeof raw.then === 'function' || typeof raw.open !== 'function' || typeof raw.request !== 'function') throw fail('NAS 没有提供独立的播放连接', 503);
  if (!raw.config || raw.config === origin.config && !Object.isFrozen(raw.config)) { raw.httpsAgent?.destroy(); throw fail('NAS 没有提供独立的播放配置', 503); }
  const check = expected || baseline;
  if (identityKeys.some(key => raw.config?.[key] !== check[key])) { raw.httpsAgent?.destroy(); throw fail('NAS 播放连接的账户发生变化', 409); }
  let disposed = false;
  const invoke = (name, path, options) => {
    if(disposed)return Promise.reject(cancelled());
    return Promise.resolve().then(()=>{if(disposed)throw cancelled();return raw[name](path,options);}).catch(error=>{
      if(disposed||error?.name==='AbortError')throw cancelled();
      // UGOS errors may echo an authenticated URL or a private media path.
      // Keep a numeric provider code, never forward arbitrary transport text.
      const code=Number.isInteger(error?.code)?error.code:undefined;
      throw Object.assign(fail('NAS 播放请求失败'+(code===undefined?'':`（错误码 ${code}）`),502),code===undefined?{}:{code});
    });
  };
  const wrapper = { config:raw.config, request(path,options){return invoke('request',path,options);},open(path,options){return invoke('open',path,options);},snapshot(){if(disposed)throw cancelled();return raw.snapshot ? raw.snapshot() : new UgOS({...raw.config});} };
  Object.defineProperty(wrapper,transport,{value:raw});
  return {nas:wrapper,identity:check,dispose(){if(disposed)return;disposed=true;raw.httpsAgent?.destroy();}};
}
function privateDescriptor(nas, path, query, extra = {}) {
  const result = {...extra}; Object.defineProperties(result,{nas:{value:nas},path:{value:path},query:{value:query}}); return result;
}

export function createMoviePlaybackService(options) { return new MoviePlaybackService(options); }
export class MoviePlaybackService {
  constructor({ dir, makeUrl, createSession=(nas,play)=>new PlaybackSession(nas,play), now=Date.now, candidateTtlMs=120000, cleanupTimeoutMs=5000, maximum=16, setTimer=setTimeout, clearTimer=clearTimeout, onWarning=()=>{} } = {}) {
    if (typeof makeUrl !== 'function') throw new TypeError('A local capability URL mapper is required');
    this.dir=dir;this.makeUrl=makeUrl;this.createSession=createSession;this.now=now;this.candidateTtlMs=Math.max(1,Math.min(120000,Number(candidateTtlMs)||120000));this.cleanupTimeoutMs=Math.max(1,Math.min(15000,Number(cleanupTimeoutMs)||5000));this.maximum=maximum;this.setTimer=setTimer;this.clearTimer=clearTimer;this.onWarning=onWarning;
    this.roots=new Map();this.closedRoots=new Map();this.preferencesCache={};this.writeTail=Promise.resolve();this.generation=0;this.ready=this.loadPreferences();
  }
  async loadPreferences() {
    if(!this.dir)return;await mkdir(this.dir,{recursive:true,mode:0o700});
    try { const value=JSON.parse(await readFile(join(this.dir,'movie-preferences.json'),'utf8'));if(!plain(value))return;for(const [scope,prefs] of Object.entries(value).slice(-512)){if(!/^[a-f0-9]{64}$/.test(scope))continue;try{this.preferencesCache[scope]=validateMoviePreferences(prefs);}catch{}} } catch {}
  }
  warning(code) { const value={code,message:code==='OLD_SOURCE_CLEANUP_UNCONFIRMED'?'新画质已启用，但旧转码任务结束未确认。':'播放资源结束未全部确认。'};try{this.onWarning(value);}catch{}return value; }
  url(root,source,context,resourceId) {
    const manifest=resourceId?Boolean(source.handle.session.resource(resourceId).manifest):source.kind==='hls';
    const value=this.makeUrl({id:root.id,owner:root.owner,sourceId:source.id,kind:resourceId?'hls-resource':source.kind,manifest,...(resourceId?{resourceId}:{})},context);
    if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||/[\r\n]/.test(value)||value.length>8192)throw fail('本机播放地址无效',503);return value;
  }
  wire(root,source,context) { return {id:root.id,sourceId:source.id,preferenceScope:root.scope,...(source.state==='candidate'?{candidateId:source.id,expiresAt:source.deadline}:{}),kind:source.kind,quality:{...source.quality},stream:this.url(root,source,context)}; }
  get(id,owner) { const root=this.roots.get(String(id));if(!root||root.owner!==owner||root.closed)throw fail('播放会话不存在或已关闭',404);return root; }
  assertLive(root) {if(root.closed||this.roots.get(root.id)!==root)throw cancelled();return root;}
  register(id,owner,nasSnapshot,play,{urlContext}={}) {
    id=String(id);if(!id||id.length>160||typeof owner!=='string'||!owner||owner.length>512||!play?.file?.path)throw fail('无效的播放会话');
    if(this.roots.has(id))throw fail('播放会话已经登记',409);if(this.roots.size>=this.maximum)throw fail('播放会话过多',429);
    const seed=captureNas(nasSnapshot);let raw;
    try {
      raw=captureNas(seed.nas,seed.identity);
      const savedPlay={file:{path:String(play.file.path),duration:Number(play.file.duration)||0},item:{id:play.item?.id,libraryId:play.item?.libraryId,categoryId:play.item?.categoryId,type:play.item?.type,name:String(play.item?.name||''),duration:Number(play.item?.duration)||0}};
      const config=seed.nas.config,account=[config.alias||config.server,config.username||config.uid||hash([config.token,config.staticToken])];
      const scope=hash([account,savedPlay.item.id,savedPlay.item.libraryId,savedPlay.item.categoryId,hash(savedPlay.file.path)]);
      const initial={id:token(),kind:'original',quality:{id:'original',label:'原画',original:true},handle:{owned:raw,session:null},state:'active'};
      const root={id,owner,seed,play:savedPlay,scope,active:initial,pending:null,candidates:new Map(),retired:new Set(),cleanupWarnings:new Map(),generation:0,closed:false};this.roots.set(id,root);this.closedRoots.delete(id);
      return this.wire(root,initial,urlContext);
    }catch(error){this.roots.delete(id);raw?.dispose();seed.dispose();throw error;}
  }
  handle(root) {
    const owned=captureNas(root.seed.nas,root.seed.identity);let session;
    try{session=this.createSession(owned.nas,root.play);}catch(error){owned.dispose();throw error;}return{owned,session};
  }
  async cleanup(handle,code='RESOURCE_CLEANUP_UNCONFIRMED') {
    if(!handle)return[];if(handle.cleanup)return handle.cleanup;
    handle.cleanup=(async()=>{
      let timer;const work=Promise.resolve().then(()=>handle.session?.close()).finally(()=>handle.owned.dispose());
      const outcome=await Promise.race([work.then(()=>true,()=>false),new Promise(resolve=>{timer=this.setTimer(()=>resolve(false),this.cleanupTimeoutMs);})]);this.clearTimer(timer);
      if(!outcome){try{handle.owned.dispose();}catch{}return[this.warning(code)];}return[];
    })();return handle.cleanup;
  }
  async retire(root,handle,code) {root.retired.add(handle);try{const warnings=await this.cleanup(handle,code);for(const warning of warnings)root.cleanupWarnings.set(warning.code,warning);return warnings;}finally{root.retired.delete(handle);}}
  async options(id,owner) {
    const root=this.get(id,owner);await this.ready;this.assertLive(root);
    if(!root.metadata){const handle=this.handle(root);root.metadata={handle};root.metadata.promise=Promise.resolve().then(()=>handle.session.describe()).then(result=>{if(this.roots.get(root.id)!==root||root.closed)throw cancelled();root.options=result;return result;}).catch(async error=>{if(root.metadata?.handle===handle)root.metadata=null;await this.retire(root,handle);throw error;});}
    await root.metadata.promise;this.assertLive(root);
    return {...root.options,preferenceScope:root.scope,selected:root.active.quality.id,preferences:mergePrefs(defaults(),this.preferencesCache[root.scope]||{})};
  }
  active(id,owner,{urlContext}={}) { const root=this.get(id,owner);return this.wire(root,root.active,urlContext); }
  async prepareQuality({id,qualityId},owner,{signal,urlContext}={}) {
    const root=this.get(id,owner);if(typeof qualityId!=='string'||qualityId.length>150)throw fail('无效的画质选项');
    const handle=qualityId==='original'?{owned:captureNas(root.seed.nas,root.seed.identity),session:null}:this.handle(root);
    const source={id:token(),kind:qualityId==='original'?'original':'hls',handle,quality:{id:qualityId},state:'preparing',deadline:this.now()+this.candidateTtlMs,generation:++root.generation};
    const previous=root.pending;root.pending=source.id;root.candidates.set(source.id,source);
    source.timer=this.setTimer(()=>{this.expire(root,source).catch(()=>{});},this.candidateTtlMs);source.timer?.unref?.();
    const abort=()=>{this.expire(root,source).catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
    try {
      if(signal?.aborted)throw cancelled();
      if(previous){const old=root.candidates.get(previous);if(old)await this.expire(root,old);}
      const options=await this.options(id,owner);const quality=options.qualities.find(q=>q.id===qualityId);if(!quality)throw fail('此影片没有这个画质选项');
      this.assertCandidate(root,source);source.quality={...quality};
      if(handle.session){await handle.session.describe({external:false});this.assertCandidate(root,source);await handle.session.selectQuality(qualityId,{preferH264:true});}
      this.assertCandidate(root,source);source.state='candidate';return this.wire(root,source,urlContext);
    }catch(error){await this.expire(root,source);throw error;}
    finally{signal?.removeEventListener('abort',abort);}
  }
  assertCandidate(root,source) { if(root.closed||this.roots.get(root.id)!==root||root.pending!==source.id||root.candidates.get(source.id)!==source||source.deadline<=this.now()){this.expire(root,source).catch(()=>{});throw cancelled();} }
  async expire(root,source) { if(root.candidates.get(source.id)===source)root.candidates.delete(source.id);if(root.pending===source.id)root.pending=null;this.clearTimer(source.timer);source.state='discarded';return this.retire(root,source.handle); }
  async commitQuality({id,candidateId},owner,{urlContext}={}) {
    const root=this.get(id,owner);if(root.active.id===candidateId)return{...this.wire(root,root.active,urlContext),warnings:[]};
    const source=root.candidates.get(candidateId);if(!source)throw fail('候选播放源不存在',404);this.assertCandidate(root,source);if(source.state!=='candidate')throw fail('候选播放源尚未准备好',409);
    // Validate the response URL before the irreversible promotion/old cleanup.
    const result=this.wire(root,source,urlContext);delete result.candidateId;delete result.expiresAt;
    const old=root.active;root.active=source;source.state='active';root.candidates.delete(source.id);root.pending=null;this.clearTimer(source.timer);
    const warnings=await this.retire(root,old.handle,'OLD_SOURCE_CLEANUP_UNCONFIRMED');this.assertLive(root);if(root.active!==source)throw cancelled();return{...result,warnings};
  }
  async discardQuality({id,candidateId},owner) {const root=this.get(id,owner);if(root.active.id===candidateId)throw fail('不能丢弃正在播放的源',409);const source=root.candidates.get(candidateId);if(!source)return{discarded:true,warnings:[]};return{discarded:true,warnings:await this.expire(root,source)};}
  quality(payload,owner,options={}) {if((payload.action||'prepare')==='prepare')return this.prepareQuality(payload,owner,options);if(payload.action==='commit')return this.commitQuality(payload,owner,options);if(payload.action==='discard')return this.discardQuality(payload,owner);throw fail('无效的画质事务');}
  source(id,owner,sourceId) {
    const root=this.get(id,owner);const source=sourceId?root.active.id===sourceId?root.active:root.candidates.get(sourceId):root.active;
    if(!source)throw fail('播放源不存在',404);if(source.state==='preparing')throw fail('播放源尚未准备好',409);if(source.state==='discarded')throw fail('播放源已结束',410);
    if(source.state==='candidate')this.assertCandidate(root,source);return{root,source};
  }
  raw(id,owner) {const root=this.get(id,owner);return privateDescriptor(root.seed.nas,'/ugreen/v1/stream/transcode/raw/get',{video_path:root.play.file.path},{kind:'original',manifest:false});}
  stream({id,sourceId},owner) {const{root,source}=this.source(id,owner,sourceId);if(source.kind!=='original')throw fail('此播放源需要读取 HLS 清单',409);return privateDescriptor(source.handle.owned.nas,'/ugreen/v1/stream/transcode/raw/get',{video_path:root.play.file.path},{kind:'original',manifest:false});}
  async manifest({id,sourceId,resourceId},owner,{signal,urlContext}={}) {const{root,source}=this.source(id,owner,sourceId);if(source.kind!=='hls')throw fail('此播放源不是 HLS',409);const result=await source.handle.session.manifest(key=>this.url(root,source,urlContext,key),resourceId,signal);this.source(id,owner,source.id);return result;}
  resource({id,sourceId,resourceId},owner) {const{source}=this.source(id,owner,sourceId);if(source.kind!=='hls')throw fail('此播放源不是 HLS',409);const value=source.handle.session.resource(resourceId);return privateDescriptor(source.handle.owned.nas,value.path,value.query,{kind:'hls-resource',manifest:Boolean(value.manifest)});}
  async subtitle(payload,owner) {
    const root=this.get(payload.id,owner);await this.options(payload.id,owner);this.assertLive(root);const session=root.metadata.handle.session,action=payload.action||'read';
    if(action==='search'){const result=await session.searchSubtitles({query:payload.query,language:payload.language,page:payload.page});this.assertLive(root);return result;}
    if(action==='download'){const result=await session.downloadSubtitle(payload.resultId);this.assertLive(root);if(result.subtitle){root.options.subtitles=root.options.subtitles.filter(s=>s.id!==result.subtitle.id).concat(result.subtitle);}return result;}
    if(action==='delete'){const result=await session.deleteSubtitle(payload.subtitleId);this.assertLive(root);root.options.subtitles=root.options.subtitles.filter(s=>s.id!==payload.subtitleId);return result;}
    if(action!=='read')throw fail('无效的字幕操作');
    const format=payload.format||'vtt';if(!['vtt','original'].includes(format))throw fail('不支持的字幕格式');
    if(format==='original'){const selected=root.options.subtitles.find(s=>s.id===payload.subtitleId);if(!selected||!['srt','ass','ssa','vtt'].includes(selected.codec))throw fail('此字幕不能作为文本脚本返回',415);}
    const result=await session.subtitle(payload.subtitleId,{format,encoding:payload.encoding||'auto',offset:0});this.assertLive(root);
    return{body:Buffer.isBuffer(result.body)?decodeSubtitle(result.body,payload.encoding||'auto'):result.body,contentType:result.contentType,format};
  }
  async preferences({id,preferences,action,enabled},owner,{signal}={}) {
    const root=this.get(id,owner);
    if(action==='skip'){await this.options(id,owner);this.assertLive(root);const result=await root.metadata.handle.session.setSkipEnabled(enabled);this.assertLive(root);return result;}
    if(action!==undefined)throw fail('无效的播放偏好操作');const patch=validateMoviePreferences(preferences);
    const encoded=JSON.stringify(patch);for(const value of [root.seed.nas.config.token,root.seed.nas.config.staticToken,root.play.file.path])if(typeof value==='string'&&value.length>=8&&encoded.includes(value))throw fail('播放偏好不能包含私密连接数据');
    const work=this.writeTail.catch(()=>{}).then(async()=>{await this.ready;if(signal?.aborted)throw cancelled();this.assertLive(root);const next=mergePrefs(this.preferencesCache[root.scope]||{},patch),all={...this.preferencesCache,[root.scope]:next};const keys=Object.keys(all);while(keys.length>512)delete all[keys.shift()];
      if(this.dir){const temp=join(this.dir,'movie-preferences-'+randomUUID()+'.tmp');try{await writeFile(temp,JSON.stringify(all),{mode:0o600});if(signal?.aborted||this.roots.get(root.id)!==root)throw cancelled();await rename(temp,join(this.dir,'movie-preferences.json'));}catch(error){await unlink(temp).catch(()=>{});throw error;}}
      this.preferencesCache=all;return{preferences:mergePrefs(defaults(),next)};});this.writeTail=work;return work;
  }
  async skips(id,owner,options) {const root=this.get(id,owner);await this.options(id,owner);this.assertLive(root);const result=await root.metadata.handle.session.skips(options);this.assertLive(root);return result;}
  async trackPreferences(id,owner) {const root=this.get(id,owner);await this.options(id,owner);this.assertLive(root);const result=await root.metadata.handle.session.trackPreferences();this.assertLive(root);return result;}
  async close(id,owner) {
    const existing=this.closedRoots.get(String(id));if(existing){if(existing.owner!==owner)throw fail('播放会话不存在或已关闭',404);return existing.promise;}
    const root=this.get(id,owner);root.closed=true;root.generation++;this.roots.delete(root.id);
    const handles=Array.from(new Set([root.metadata?.handle,root.active.handle,...root.retired,...Array.from(root.candidates.values(),s=>{this.clearTimer(s.timer);s.state='discarded';return s.handle;})].filter(Boolean)));root.candidates.clear();root.pending=null;
    const promise=Promise.all(handles.map(h=>this.cleanup(h))).then(results=>{const warnings=[...root.cleanupWarnings.values(),...results.flat()];try{root.seed.dispose();}catch{warnings.push(this.warning('RESOURCE_CLEANUP_UNCONFIRMED'));}const unique=Array.from(new Map(warnings.map(w=>[w.code,w])).values());return{closed:true,cleanupConfirmed:!unique.length,warnings:unique};});
    this.closedRoots.set(root.id,{owner,promise});while(this.closedRoots.size>64)this.closedRoots.delete(this.closedRoots.keys().next().value);return promise;
  }
  async reset() {this.generation++;const roots=Array.from(this.roots.values());const results=await Promise.all(roots.map(root=>this.close(root.id,root.owner)));return{closed:roots.length,cleanupConfirmed:results.every(r=>r.cleanupConfirmed),warnings:results.flatMap(r=>r.warnings)};}
}
