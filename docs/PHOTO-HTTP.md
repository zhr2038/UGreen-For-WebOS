# 相册视频 HTTP 边界

`createPhotoHttpHandler` 将 Photos / PhotoVideoSessions 的事务和 HLS 暴露为独立路由，不接管其他相册、影视、NAS 登录或静态文件路由。本轮没有修改共享 bridge、入口、service 或 package；根集成由 root 完成。

## 最小接入

在 root 已完成 clientId 认证、取得 owner 之后调用：

```js
import { createPhotoHttpHandler } from './photo-http.mjs';

const photoHttp = createPhotoHttpHandler({
  photos,
  proxy, // root 现有 proxy(req,res,path,query,kind,nas)，可省略
  onReset: () => photos.clear(), // root 只委托一次清理，不再重复 clear
});

if (await photoHttp(req, res, {
  url,
  owner,
  urlContext: { client: authenticatedClientCapability },
  signal: requestSignal,
})) return;
```

返回 true 表示请求已处理，false 表示不是本模块路由。`owner` 和 `urlContext.client` 是已认证的服务端上下文，不能从 JSON body、未验证的查询或 NAS 用户名直接赋值。模块不会把 body 里的 owner 当成权限来源。

独立使用时可传 `clientToken`：模块核对 Bearer / client 查询能力并默认以 SHA-256 派生 owner。多客户端也可传 `authorize(req,url,context)`，返回已经认证的 `{owner,client}`。未配置 authorize 时接受 root 的已认证上下文；配置后仍会调用并核对 owner，明确拒绝不能退回上下文绕过。同时存在的 header、query、urlContext 能力必须一致，不允许用 header B 覆盖 URL 的 client A。

默认生成同源相对能力 URL。若 root 需要映射，可传 factory 的 `makeURL(path,urlContext)` 或本次 `urlContext.makeURL`，返回值必须保留原路径和唯一、正确的 client 查询，不允许额外 token / ugk 参数。绝对 URL 还需显式给出服务端可信 `urlContext.origin`；不会信任用户请求里的 Host 或绝对 request-target 来决定凭据发送目的地。

## 路由

| 路由 | 方法 | JSON / 资源 |
| --- | --- | --- |
| `/api/photos/video/start` | POST | `{asset:<40hex-video-cap>}` |
| `/api/photos/video/quality` | POST | `{id,quality,request?}`；缺 request 时生成随机编号 |
| `/api/photos/video/commit` | POST | `{id,candidate}` |
| `/api/photos/video/discard` | POST | `{id,candidate? ,request?}`；至少一个候选定位字段 |
| `/api/photos/video/close` | POST | `{id}` |
| `/photo-hls/<40hex-candidate>/playlist.m3u8` | GET / HEAD | 当前候选主播放列表；原 master / master.m3u8 保留兼容 |
| `/photo-hls/<40hex-candidate>/<32hex-resource>.m3u8` | GET / HEAD | 已注册的子播放列表；必须校验 manifest 类型，不能给分片伪造后缀 |
| `/photo-hls/<40hex-candidate>/<32hex-resource>` | GET / HEAD | 分片、初始化段或密钥；旧子列表不带后缀的读取仍兼容 |

所有 JSON 请求限制为 16KB、普通对象及该操作的已知字段。根会话 / 候选 / 资源标识严格检查，不接收 NAS 路径、任意远程 URL 或认证字段。

start 的 original 和 quality 的 url 都补 client 能力。主播放列表和任意已识别 m3u8 子资源均通过 **session.manifest(makeURL,resource,signal)** 重写，每一层的 URI、MAP / KEY URI 都得到同一客户端能力。不能直接调用缺少 makeURL 上下文的 `videos.manifest()` 后把结果直通。

公开的主列表及所有子列表明确包含 `.m3u8`。LG 的 mediaOption 文档说明，src 含该扩展且使用相应 MIME 时才会自动选 HLS transport；不能仅依靠 opaque URL 的 Content-Type。[LG mediaOption](https://webostv.developer.lge.com/develop/guides/mediaoption-parameter)

HLS URL 中使用的是 quality 返回的 candidate ID，不是 start 的根会话 ID。所有查找继续由 PhotoVideoSessions 校验 owner，换另一个合法 client 也不能读取别人的候选。

## 代理与保密

分片取得的客户端始终来自 `photos.videos.hls(candidateId,owner).nas`，即该候选自己的账号快照。不会重新使用全局 photos.nas；全局账号修改后旧候选也不携带新 token。

可注入 root 的现有 proxy，也可使用模块自带代理。注入时收到的是受限客户端包装：它使用候选快照、合并本次 signal / Session abort / proxy signal，并检查响应类型，防止 NAS 的 JSON / HTML 错误或未重写的 m3u8 经分片路由直通。

- NAS 分片请求只使用 GET；客户端 HEAD 读取 GET 响应头后销毁流，避免 UGOS HEAD 返回 JSON 的差异。
- 保留 200 / 206 的 Content-Type、Content-Length、Content-Range、Accept-Ranges、ETag、Last-Modified、Content-Encoding；Range / If-Range 原样转给候选快照。
- 304 / 416 保留状态及范围信息，响应体为空，不把可能带凭据的 NAS 错误体传给电视。
- 不透传 Location、Set-Cookie、Authorization、私有文件名头等；不会把本机 client capability 转发为 NAS header / query。
- 重写后的 m3u8 返回完整 200，Content-Length 按重写后 UTF-8 字节数计算；客户端 HEAD 不含 body。不能保留原列表的字节 Range / 长度，因为 URI 已改变。
- 播放列表和 JSON 输出拒绝包含已知 NAS token / staticToken / password / ugk；NAS 任意异常文字不进入 HTTP 错误响应，错误使用固定文案。

资源是否是子播放列表仍由已有 Session 的资源分类决定（`.m3u8` 或 `/m3u8` 路径）。若 NAS 新版本以其他路径返回 m3u8 MIME，本模块会拒绝直通并返回 502；应该先在资源注册层明确分类后重写，不能为了兼容而直接暴露 NAS URI。

## 取消、事务与 reset

按 root 允许的最小变更，PhotoVideoSessions.start / quality 新增第三参数 `{signal}`；PhotoVideoSession 的 metadata / play 请求合并自身 abort 与请求 signal。NAS 启动完成后再次检查取消状态，不把迟到结果发布成可用 URL。清理调用不沿用已取消的 signal，因此仍可关闭本次 task。

本模块监听 request aborted、未完成的 response close，以及上下文 signal：

- start 被取消时中止 metadata，关闭自身初始 task；若结果迟到，按其明确根 ID 清理。
- quality 使用独立 request 编号定位候选，取消时主动 discard；不会关闭已 commit 的旧源。同 owner / 根 / request 编号的并发重复请求返回 409，避免一个请求的取消误清理另一个请求。
- commit 读取并校验请求后，promotion 是原子的；一旦接受候选，单次 HTTP 响应断开不会再关闭整个 root。客户端通过下述 active 查询对账，不能因响应丢失盲目恢复可能已经关闭的旧源。显式 close、reset 和既有 TTL 仍负责任务清理。
- 分片 / manifest 被取消只中止该 HTTP 读取，不关闭仍在播放的整个候选，兼容播放器 seek / 放弃分片。

`await photoHttp.reset()` 增加 HTTP generation、取消正在处理的请求，然后只执行一次 onReset；未配置时默认 `photos.videos.clear()`。同一轮并发 reset 共用一个 Promise。root 若委托 onReset=photos.clear，就不要再在其他层重复清理。reset 期间新请求返回 503，旧请求不能在 reset 后发布 URL。

`photoHttp.dispose()` 永久停止此处理器并执行同样的清理；后续请求返回 503。

## 已接受画质对账

`GET /api/photos/video/active?id=<root40hex>`（也支持HEAD）只读查询当前 owner 的根会话，返回：

```js
{ id, candidate, selected, kind, quality, url, warning? }
```

初始原画的candidate为null。candidate记录最后一次已接受的候选ID；切回原画时也保留该ID，即使它不需要NAS任务、已从候选Map移除。HLS的url使用`/photo-hls/<candidate>/playlist.m3u8?client=…`，原画使用已授权的`/photo-video/<cap>?client=…`。与其他播放接口一致，验证owner和client，不接受额外query、重复id或POST；HEAD包含相应Content-Length但没有body。查询不启动NAS任务。

确认响应丢失时，前端比较active.candidate与本次candidate：一致才确认已接受；若仍是之前的候选，可保留实际仍活动的源；查询失败意味着状态未知，不能断言旧源仍可用。旧task关闭结果未知的warning也可从active读取。HTTP请求持有当时的videos实例，清理不会通过当前Photos getter误访问下一账号。

照片账号与原图代理另外遵守[相册账号快照边界](PHOTO-ACCOUNTS.md)；Root proxy必须使用stream.nas。

## 回归证据

```powershell
node --test test/photo-http.test.mjs test/photo-video.test.mjs
```

15 条集成级 HTTP 回归与 10 条相册视频回归通过。测试使用真实 Node HTTP server / fetch、现有 Photos / PhotoVideoSessions，以及 fake NAS 快照 / 流；没有真实 NAS 转码或 C5 操作。

新回归覆盖三层播放列表、MAP / KEY / 分片的能力 URL、跨 owner、冲突 token、provider 错误脱敏、root proxy 的 HEAD / Range / MIME、start metadata 取消、play 启动取消、只清理新候选、重复 request 并发、外部上下文 signal、reset 后的迟到响应，以及真实HTTP丢失commit响应后通过active核对HLS/原画候选且新源仍可读取。
