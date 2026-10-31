# 电影播放服务接入

`lib/movie-playback-service.mjs` 包装已有 `PlaybackSession`，提供账号隔离、独立的画质候选任务、HLS 和字幕授权，以及本机播放偏好。该模块不改根 `plays` Map、不提交播放进度、不操作电视、不下载或删除用户的真实字幕文件进行测试。

## 创建和登记

```js
import { createMoviePlaybackService } from './movie-playback-service.mjs';

const movies = createMoviePlaybackService({
  dir, // 可选：本机私有配置目录，原子保存 movie-preferences.json。
  makeUrl({ id, sourceId, kind, resourceId }, { client }) {
    const base = '/api/play/source/' + encodeURIComponent(id) + '/' + sourceId;
    const suffix = resourceId ? '/' + resourceId : '';
    return base + suffix + '?client=' + encodeURIComponent(client);
  },
  onWarning(warning) { /* 仅 code/message，无 NAS 地址、路径或令牌。 */ },
});

// 根先检查本机配对能力；owner 应是根得到的配对主体，不取请求体字段。
const original = movies.register(id, owner, nas, play, {
  urlContext: { client: currentClientCapability },
});
```

`makeUrl(descriptor, urlContext)` 必须同步返回以 `/` 开头的本机相对 URL，不接受外部 URL。`descriptor` 包含 `id/owner/sourceId/kind`，资源还含 `resourceId`；kind 为 `original/hls/hls-resource`。原画和 HLS 均由此映射；HLS 内的每条嵌套清单、分段、密钥地址也由此映射。根在**每次调用**传入当前请求的 `urlContext`，使地址携带正确的本机能力令牌；模块不从全局账号或全局 capability 拼接 URL。

`register` 保存最少的播放文件和片目信息，创建独立的种子 snapshot 和原画连接；后续 metadata、HLS 及新原画候选一律从该种子 snapshot 派生。没有 `snapshot()` 时从旧 snapshot 的 config 复制 `UgOS`。新的连接不得更换账号身份、认证方式、TLS pin，也不得复用原对象、原 Agent 或可变的原 config。关闭只销毁这些自有连接，不销毁传入的上游 NAS。

响应只含公开字段：

```js
{ id, sourceId, kind: 'original', quality: { id: 'original', ... }, stream }
```

根继续保存自己的 `play.owner/item/file/created` 供原播放进度、收藏、结束事件使用。ID 应随机且唯一；所有服务方法都检查当前登记的 owner。所有 URL 路由还须先执行根原有的本机 capability 检查，避免仅凭随机 ID 取流。

## 四个设置 API

| 根路由 | 服务调用 | 说明 |
| --- | --- | --- |
| GET `/api/play/options?id=...` | `await movies.options(id, owner)` | 真实 NAS 画质、音轨、字幕、source、warnings，加已提交的 selected 和本机 preferences |
| POST `/api/play/quality` | `await movies.quality(body, owner, {signal,urlContext})` | action 默认 prepare；也支持 commit/discard |
| POST `/api/play/subtitle` | `await movies.subtitle(body, owner)` | read/search/download/delete，沿现有面板合同 |
| POST `/api/play/preferences` | `await movies.preferences(body, owner, {signal})` | 普通本机偏好；显式 skip action 才写 NAS |

画质不能凭电视型号或客户端枚举自行构造。服务只接受当前 NAS `describe().qualities` 的 ID，原画始终存在并默认选中。每个播放只有一份 metadata session，外挂字幕和在线搜索结果的能力 ID 属于这份 session，避免重新 describe 后 ID 失效。

### 画质候选事务

```js
const candidate = await movies.prepareQuality(
  { id, qualityId }, owner, { signal, urlContext }
);
// {id,sourceId,candidateId,expiresAt,kind,quality,stream}

// 根把 candidate.stream 加载到播放器并验证可播放，续接位置和暂停状态。
// 此时原 source 仍可访问，原 NAS task 尚未关闭。
try {
  await loadAndVerifyCandidate(candidate);
  const active = await movies.commitQuality(
    { id, candidateId: candidate.candidateId }, owner, { urlContext }
  );
  // 更新根实际 sourceId/quality，展示 active.warnings（如有）。
} catch (error) {
  await restorePreviousPlayerSource();
  await movies.discardQuality({ id, candidateId: candidate.candidateId }, owner);
  throw error;
}
```

HTTP 请求体分别是 `{id,qualityId,action:'prepare'}`、`{id,candidateId,action:'commit'}`、`{id,candidateId,action:'discard'}`。`preferH264` 当前固定 true，服务不接受客户端自造转码参数。

候选拥有独立 taskId、sourceId、snapshot、资源 Map；prepare/discard 不关闭已播放的旧任务。根的实际媒体切源必须按上述事务加载后 commit，面板收到 prepare 成功本身不代表电视解码成功。新 prepare 仅替换旧候选，不替换活动源。候选创建起最多 120 秒，读取清单/分段不会续期，过期后禁止访问并清理；AbortSignal 和迟到的 NAS 返回均不能将旧候选激活。commit 前验证本机 URL。成功提交后关闭旧源，旧 close 失败或超时只返回 `OLD_SOURCE_CLEANUP_UNCONFIRMED`，不会误报新源失败或切回已关闭的旧源；这条未确认状态也保留到最终 close/reset。

`movies.active(id,owner,{urlContext})` 读取已提交的公开源描述。commit 同一活动 candidateId 幂等；discard 活动 sourceId 返回409，未知候选重复 discard 幂等。

## 原画、HLS 和代理

根自己的 `/media/:id` 原画路由也必须使用播放登记对应的 snapshot：

```js
const { nas: playbackNas, path, query } = movies.raw(id, owner);
await proxy(req, res, path, query, 'video', playbackNas);
```

URL 映射的新 source 路由：

```js
// kind 可由 prepare/register 响应决定；服务方法会再次检查归属。
const descriptor = movies.stream({ id, sourceId }, owner); // 仅 original
const { nas, path, query } = descriptor;
await proxy(req, res, path, query, 'video', nas);

const manifest = await movies.manifest(
  { id, sourceId }, owner, { signal, urlContext }
);
// 按 manifest.contentType 返回 manifest.body；不转发 NAS 的原始清单。

const resource = movies.resource({ id, sourceId, resourceId }, owner);
if (resource.manifest) {
  const nested = await movies.manifest(
    { id, sourceId, resourceId }, owner, { signal, urlContext }
  );
  // 同上返回重写后的 nested.body。
} else {
  const { nas, path, query } = resource;
  await proxy(req, res, path, query, 'video', nas);
}
```

`raw/stream/resource` 返回私有传输描述符，`nas/path/query` 是不可枚举属性，根通过解构读取；不得把它们显式展开进 JSON。`JSON.stringify(descriptor)` 仅包含 kind/manifest。`PlaybackSession` 按 NAS task 检查 URI 归属、同源和 transcode 路径，真实资源路径换为不透明 ID。无效、过期或其他 owner 的 source 不能代理。根代理仍负责 Range/HEAD、请求断开时 abort 和响应头过滤。服务检查可访问时刻；已经开始的代理流需由根的响应/信号生命周期结束。

## 字幕和偏好

`subtitle` 默认 action=read，接受 `subtitleId/format:'vtt'|'original'/encoding`，返回 `{body,contentType,format}` 的文本 JSON；original 只允许 SRT/ASS/SSA/VTT。后端 offset 固定0，字幕延迟由客户端控制器施加一次。图形 SUP 不作为文本伪装输出。

`action:'search'` 接受 `query/language/page`；`action:'download'` 只接受本 session 的 `resultId`；`action:'delete'` 只接受本 session 的 `subtitleId`。根必须保留面板显式点击“下载并使用”和确认删除的流程。服务会更新 metadata 中的外挂字幕能力，不接受浏览器发来的 NAS 文件路径。测试只用假 NAS 写操作，没有对真实用户文件执行下载或删除。

普通偏好在本机按 SHA-256 不透明账号/片目 scope 保存，最多512项，串行写临时文件后 rename，不写路径或 token。支持 `mode:sort_list|loop_list|loop_single`、六档 rate、`fit:contain|cover|fill`、安全轨道 label/language/index/count、字幕 selection/off/native、offset±600秒、size50–200、color六位十六进制、position5–95、language、opacity/background0–1、outline布尔。未知字段、非有限数字、路径/令牌等拒绝。浏览器无法传入存储 scope。

`preferences({id,action:'skip',enabled:boolean},owner)` 显式调用 NAS 的跳片头片尾开关，不写普通偏好文件。可选只读 `movies.skips(id,owner,{duration})` 和 `movies.trackPreferences(id,owner)` 沿官方 NAS 接口读取。轨道偏好与 NAS 音轨元数据不等于电视实际 audioTracks/textTracks 能力或画面验收。

## 结束和验证

`await movies.close(id,owner)` 使源立即不可访问，清理所有候选、metadata、活动和正在退役任务，销毁自己的 Agent、清理候选计时器，返回 `{closed:true,cleanupConfirmed,warnings}`。同 owner 重复 close 幂等（保留最近64项）。`await movies.reset()` 供根账号切换/重置/关闭调用，关闭全部登记，返回 closed 数量和合并 warnings。任务 cleanup 有默认5秒、最多15秒边界；超时后连接 wrapper 禁止继续发请求并销毁 Agent，报告未确认，不谎称 NAS 已结束。不会触碰全局新账号的 Agent。

```powershell
node --test test/movie-playback-service.test.mjs
```

20项测试包含 owner/账号切换、损坏 snapshot、事务失败回滚、绝对 TTL、取消迟到、两次 commit 竞态、旧 close 失败/超时、URL 预检、原子偏好与同ID重登记、显式字幕写操作，以及真实 `PlaybackSession` 配合假 NAS 流的 HLS重写、独立task和敏感报错过滤。没有以 NAS 元数据或 mock 成功宣称 C5 原生解码、音轨、HDR 或全功能验收。
