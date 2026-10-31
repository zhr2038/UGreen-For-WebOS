# 电影 HTTP 路由接入

`lib/movie-http.mjs` 导出 `createMovieHttpHandler`、`movieSourceUrl` 和安全的默认代理 `proxyMovieMedia`。根继续拥有 `/api/play`、`/api/progress`、`plays` Map 和播放进度 snapshot；适配层只分派已登记播放的高级选项与来源流。

## 最小接线

```js
import { createMoviePlaybackService } from './movie-playback-service.mjs';
import { createMovieHttpHandler, movieSourceUrl } from './movie-http.mjs';

const movies = createMoviePlaybackService({ dir, makeUrl: movieSourceUrl });
const movieHttp = createMovieHttpHandler({
  movies,
  validatePlay(id, owner) {
    const play = plays.get(id);
    return Boolean(play && play.owner === owner &&
      Date.now() - play.created <= 24 * 3600000);
  },
});

// 根 protected 分支：已通过现有 clientId() 检查配对能力。
const owner = clientId(req, url);
if (await movieHttp(req, res, { url, owner })) return;
// 再继续 /api/play、/api/progress 和其他原有路由。

// 根 /api/play 建立 file/item 和自己的进度 snapshot 后：
const source = movies.register(id, owner, nas, play, {
  urlContext: { client: currentRequestCapability },
});
// 将 source.stream/sourceId/kind/quality 加入已有播放响应。
```

适配层默认接管 legacy `/media/:id`，应在根原 `/media/` 分支之前调用。它通过 `movies.raw()` 的旧账号 snapshot 取流，不读取当前全局 `nas/config`。根 NAS 切换/退出/服务关闭仍应 `await movies.reset()`。`/api/play/close` 结束源和转码任务，**不会删除根 plays Map**；根可以保留另一个独立 snapshot 供已经排队的进度请求写入，再按自己的15分钟/24小时策略清理。

返回值为布尔：已识别的路由（包括错误响应）返回 true；未知路由返回 false，不消费 body、不鉴权、不访问 NAS。不覆盖根的 `/api/play`。可设 `handleRawMedia:false` 保留根自己处理 legacy media。

## 参数合同

```js
createMovieHttpHandler({
  movies,
  authenticate, // 可选 (req,url) -> owner；根未传 context.owner 时才调用。
  validatePlay, // 可选 (id,owner,{req,url,kind}) -> true/false，或抛出错误。
  proxy,        // 可选，默认使用 proxyMovieMedia。
  readBody,     // 可选 (req) -> JSON plain object；默认安全读取，最大16KiB。
  maxBodyBytes: 16384, // 默认 body reader 的上限，最多64KiB。
  handleRawMedia: true,
  onError,      // 可选，仅接收 {status,code,nasCode?}，无原始错误/URL。
});

await movieHttp(req,res,{
  url, owner,
  urlContext: { /* 可附加根 mapper 需要的其他上下文 */ },
  signal, // 可选根生命周期信号。
});
```

owner 必须来自根已经完成的配对检查，不能取请求体或查询参数。未传 owner 时必须提供有效的 authenticate，模块不会仅凭一个 cap 字符串自行认定身份。`validatePlay` 在每条请求上检查根 owner/过期时间，返回 false 映射404；服务还会再检查实际 session/source 的 owner。

`urlContext.client` 始终被**当前请求**的 Bearer capability 覆盖；没有 Bearer 时使用当前 query client，与现有 bridge 优先级一致。即使根传入陈旧的 urlContext.client，也不会污染嵌套播放列表。没有当前请求 capability 则401。该值只用于本次内存中的本机 URL，不写盘、不输出日志。

## 路由

| 路由 | 方法 | 服务方法 |
| --- | --- | --- |
| `/api/play/options?id=...` | GET/HEAD | `options(id,owner)` |
| `/api/play/active?id=...` | GET/HEAD | `active(id,owner,{urlContext})` |
| `/api/play/skips?id=...&duration=...` | GET/HEAD | `skips(id,owner,{duration})`，duration可省略 |
| `/api/play/track-preferences?id=...` | GET/HEAD | `trackPreferences(id,owner)` |
| `/api/play/quality` | POST | `quality(body,owner,{signal,urlContext})` |
| `/api/play/subtitle` | POST | `subtitle(body,owner)` |
| `/api/play/preferences` | POST | `preferences(body,owner,{signal})` |
| `/api/play/close` | POST | `close(body.id,owner)` |
| `/api/play/source/:id/:sourceId` | GET/HEAD | 原画 `stream`；旧HLS裸根路径继续兼容 |
| `/api/play/source/:id/:sourceId/playlist.m3u8` | GET/HEAD | HLS根，重写的 `manifest` |
| `/api/play/source/:id/:sourceId/:resourceId.m3u8` | GET/HEAD | HLS子清单，再次重写并携带当前请求clientcap |
| `/api/play/source/:id/:sourceId/:resourceId` | GET/HEAD | 分段/密钥；旧子清单裸opaqueID路径继续兼容 |
| `/media/:id` | GET/HEAD | 固定账号 snapshot 的 `raw` |

`movieSourceUrl(descriptor,{client})` 生成上述 source 路径，play/source/resource ID 只接受1–160字符的ASCII字母、数字、下划线、连字符，适配根已有随机ID。服务传入 `manifest:boolean`，根HLS或嵌套manifest生成显式 `.m3u8` 后缀；该布尔不会暴露NAS路径。原画、二进制资源不能通过追加该后缀伪装成清单，类型不匹配404。所有 read 查询只允许对应参数和 client；拒绝重复参数、路径转义、未知请求体字段和非对象 JSON。质选 `preferH264` 若提供只能为 true，与服务现有行为一致。

LG的[mediaOption官方说明](https://webostv.developer.lge.com/develop/guides/mediaoption-parameter)将HLS自动识别与src中的m3u8扩展及HLS MIME关联。本模块同时保留显式扩展与 `application/vnd.apple.mpegurl`；应用端可另设mediaTransportType:HLS，不能仅因后端取到TS就认定电视选择了正确管线或完成解码。

画质 body 为 `{id,action:'prepare',qualityId}`、`{id,action:'commit',candidateId}`、`{id,action:'discard',candidateId}`；默认 action 为 prepare。字幕沿面板 read/search/download/delete 合同，在线写入只在显式 POST action 才发生。普通偏好 `{id,preferences}`，NAS 跳片头片尾开关必须显式 `{id,action:'skip',enabled:boolean}`。skips 和 track-preferences 是只读，并未混在 options 内。

## commit 响应丢失

根必须在候选媒体准备成功后 commit。若 commit 的 HTTP 响应丢失，不能立即认定服务器未提交并恢复旧源，因为旧 task 可能已被关闭。使用只读 active 核对：

```js
const actual = await api('/api/play/active?id=' + encodeURIComponent(id));
if (actual.sourceId === candidate.candidateId) {
  // 已提交：保留已加载的新源，采用 actual.quality/sourceId。
} else {
  // 尚未提交：恢复 actual.stream 或仍有效的旧源，再 discard 候选。
}
```

active 的 stream 重新使用该次核对请求的 capability，不携带原 NAS 地址或 token。active 只读，不延长候选 TTL，不切源，不写进度。

## 默认代理和 HTTP 行为

默认 `proxyMovieMedia` 使用来源描述符的私有 `nas/path/query`，NAS 永远收到 GET；客户端 HEAD 读取必要的头和小段内容后关闭上游，返回相同 Content-Type/Length/Range 且没有响应 body。支持单个 byte Range（含 open end 和 suffix）、If-Range，以及正确的206/416；拒绝非法或多范围请求。嵌套清单返回重写后的200、真实 Content-Length 和 Accept-Ranges:none，客户端 Range 可被忽略。

仅转发必要的媒体类型、字节长度和范围头，不转发 NAS Cookie、Location、鉴权头、Content-Disposition 或任意错误 body。NAS 以200返回 JSON/HTML、错误类型、非法206范围、长度不一致时返回安全502。application/octet-stream 根据私有源扩展名映射常见视频/音频/字幕类型，密钥保留二进制类型。所有响应 no-store、nosniff。根继续设置公共 CORS 和处理 OPTIONS。

客户端断开、请求 aborted 或外部 signal 取消，会传给 quality prepare 和 NAS open/pipeline；代理也直接销毁上游响应，防止忽略 signal 的适配器停留在等待 next()。正常结束移除自己的监听器。候选回滚和绝对 TTL 由 MoviePlaybackService 继续保证。

若复用根现有 proxy，其调用与原六个参数一致，并增加一个可忽略的第七参数：

```js
await proxy(req,res,path,query,'video',sourceNas,{signal,urlContext});
```

注入的 proxy 必须 await 完整流生命周期，并自行保持上述 Range/HEAD、上游错误过滤和取消保证。默认不传 proxy 即可使用模块内已经测试的安全实现。

错误 HTTP status 仅来自有限白名单；客户端收到固定 `{error,code,nasCode?}`，不回显原始异常、文件路径或鉴权 URL。NAS 的1010/1011/1012/1019/1024映射401，其他未知异常502，已取消410。响应头已发出时关闭连接，不追加JSON。onError 也不接收私密错误文本。

## 验证

```powershell
node --test test/movie-http.test.mjs
```

16项测试使用真实 Node HTTP server/client、真实 MoviePlaybackService 与 PlaybackSession、内存假 NAS 流：覆盖 owner/TTL、只读 skips/track-preferences、事务和丢响应 active 对账、每级清单当前cap、分段/密钥、HEAD/Range/416、账号切换 snapshot、字幕显式写动作、普通偏好、body限制与路径逃逸、私密错误过滤、绝对TTL、prepare迟到取消、媒体中途断开和桥接proxy参数。不访问真实 NAS，不代表 C5 解码或HDR验收。
