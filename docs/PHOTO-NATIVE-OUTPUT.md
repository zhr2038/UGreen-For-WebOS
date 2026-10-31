# 原生照片输出：已知入口、证据与待验证事项

研究基线：2026-10-31 的 LG C5 只读能力查询、绿联 Android TV 1.21.0 / build 4421，以及 LG ConnectSDK 的公开实现。本轮没有启动图片查看器、切换输入源、安装应用或修改电视设置。

## 结论

可验证的下一条路径是：**本机原图代理 → LG 的 `media.viewer/open` 图片入口 → 实际返回的查看器会话**。目前已经确认 C5 宣告这个服务，尚未确认其成功打开图片、HTTP 回源、实际使用的 App 或物理 4K 输出。

ConnectSDK 的 `displayImage` 不能直接当作“原生 4K 查看”能力：它既有 native / DLNA 分支，也有 `MediaPlayer` WebApp 分支。普通 Web `<img>` 原图仍处于图形层，不能仅凭源文件尺寸、`naturalWidth` 或面板能力宣称原生 UHD。[LG 图形与视频分辨率](https://webostv.developer.lge.com/develop/specifications/app-resolution)

## 1. SSAP 图片请求的确切形状

以下请求形状来自 ConnectSDK 的 `WebOSTVService.displayMedia` / `displayImage`，不是从媒体视频播放参数猜出来的：

```json
{
  "type": "request",
  "id": "photo-request-1",
  "uri": "ssap://media.viewer/open",
  "payload": {
    "target": "http://127.0.0.1:PORT/photo-original/IMAGE_CAP?client=LOCAL_CAP",
    "title": "照片",
    "description": "",
    "mimeType": "image/jpeg",
    "iconSrc": ""
  }
}
```

成功响应由电视返回 `id` 和 `sessionId`；SDK 使用它们创建 Media 类型的 LaunchSession。**目标 App ID 并没有在这个方法中硬编码。** 关闭也有对应的 `ssap://media.viewer/close`，携带本次返回的 `id`、`sessionId`。[SDK 图片打开与关闭实现](https://github.com/ConnectSDK/Connect-SDK-Android-Core/blob/2f7ebbc7eb909321ff41b2c6bcdf6b0881427579/src/com/connectsdk/service/WebOSTVService.java#L935)

接入注意：

- SSAP 不是 Luna API，不能把 URI 机械改成 `luna://media.viewer/open` 后调用 `webOS.service.request`。
- 原始 SSAP WebSocket 消息使用完整 `ssap://` URI；像当前开发工具所用的 `aiowebostv.request` 会自行补前缀，传给这类库时只使用 `media.viewer/open`，否则可能因为双前缀得到误导性的 404。
- 不应因缺少返回的会话标识而退回“停止所有媒体”或自动切换输入源。只能清理自己明确持有的查看器会话。

## 2. ConnectSDK 实际有两类图片路径

公开源码中，`displayImage` 按 **serviceDescription.version 等于 `4.0.0`** 分支：这个分支会优先使用已发现的 DLNA，未走 DLNA 时才调用上述 `media.viewer/open`。其他版本会 join / launch WebApp ID **`MediaPlayer`**，再发送 `connectsdk.mediaCommand`，其中 `type=displayImage`、`mediaURL=...`。[native 分支](https://github.com/ConnectSDK/Connect-SDK-Android-Core/blob/2f7ebbc7eb909321ff41b2c6bcdf6b0881427579/src/com/connectsdk/service/WebOSTVService.java#L962)、[WebApp 消息实现](https://github.com/ConnectSDK/Connect-SDK-Android-Core/blob/2f7ebbc7eb909321ff41b2c6bcdf6b0881427579/src/com/connectsdk/service/sessions/WebOSWebAppSession.java#L804)

这里的 version 由发现信息或 SSDP HTTP `Server` 字段解析，**不是固件 43.21.96，也不是 webOS SDK 11.2.0**。本次针对 C5 的 SSDP 只读发现没有得到回应，因而没有据此确定这台电视会命中 SDK 的哪一个分支。不能仅按“这是新电视”就断言 SDK 必走 native 或必走 WebApp。[版本解析位置](https://github.com/ConnectSDK/Connect-SDK-Android-Core/blob/2f7ebbc7eb909321ff41b2c6bcdf6b0881427579/src/com/connectsdk/service/WebOSTVService.java#L198)

`MediaPlayer` 是 WebApp 标识，不等于 Android 影视播放器或已经识别的 C5 原生照片 App。WebApp 路径即使显示成功，也仍需要确认图片是否使用了独立原生平面，不能直接越过 FHD 图形层的限制。

## 3. HTTP 回源与权限边界

上述 native 与 WebApp 图片消息都只提供 URL 和 MIME 等媒体字段，没有自定义 HTTP 请求头、Cookie、Bearer header 或关闭证书校验的字段。因此不宜直接交出依赖 NAS 请求头的 URL，更不能把 NAS 登录会话嵌入对外图片链接。

建议继续使用电视本机代理：服务在本机读取 UGREENlink 源文件，查看器读取短期、限定单张图片的能力 URL。当前 `/photo-original/<cap>` 能保留原始文件并提供 GET / HEAD / Range；实际原图 HEIF 的 MIME 是 `image/heif`，不得改名成 JPEG。应保持非图片响应检查和令牌隔离，但不能把 HEIF 送进仅认识 JPEG / PNG / WebP 的预览解码或缩放分支。

以下仍需逐项验证，当前没有作出“已支持”的结论：

| 条件 | 已知事实 | 当前状态 |
| --- | --- | --- |
| native 查看器访问 `127.0.0.1` | 开发端经 SSH 转发访问电视服务成功；CloudFrame Web UI 也使用本机代理 | 还不能替代 native 查看器回源测试 |
| 无扩展名能力 URL | SDK 接受 URL 并另传 mimeType | 电视实际接受情况待测 |
| HTTP / HTTPS | URL 字段没有 SDK 内部 scheme 白名单 | 不能推导当前 TV 接受所有 scheme 或自签名 HTTPS |
| Authorization header | 消息没有此字段 | 使用本机图片能力 URL，不依赖外加 header |
| 301/302、Range、HEAD | 原图代理可提供标准响应 | native 查看器如何使用这些请求尚未抓到 |
| native 连接注册 | SDK 通过 SSAP register、manifest 和可保存的 client-key 建立连接 | 发布版需要自己的授权生命周期，不能打包开发电脑的配对密钥 |

SDK 的 open permissions 包括 `LAUNCH`、`CONTROL_INPUT_MEDIA_PLAYBACK` 等；WebApp 分支还涉及 `LAUNCH_WEBAPP` 和 `APP_TO_APP`。应只申请所选路径实际需要的权限，并按电视返回完成注册 / 配对，不能假定 App 内 Luna 权限自动授予 SSAP 权限。[权限定义](https://github.com/ConnectSDK/Connect-SDK-Android-Core/blob/2f7ebbc7eb909321ff41b2c6bcdf6b0881427579/src/com/connectsdk/service/webos/WebOSTVDeviceService.java#L134)、[SSAP 注册实现](https://github.com/ConnectSDK/Connect-SDK-Android-Core/blob/2f7ebbc7eb909321ff41b2c6bcdf6b0881427579/src/com/connectsdk/service/webos/WebOSTVServiceSocketClient.java#L620)

## 4. JPEG、PNG、HEIF：文件解码与显示平面是两回事

LG 的 webOS 26 通用用户指南列出原生照片文件支持：普通 JPEG、PNG，以及 AVIF / HEIC / HEIF，并区分普通 JPEG 与 progressive JPEG 的尺寸限制。该指南的示例上限包括普通 JPEG 15360×8640、PNG 5760×5760、HEIF 4800×3600；8K 型号另有更高值。这是**通用原生照片文件解码表**，不是当前中国 C5 固件经 SSAP 回源后的实际验收记录，也不是 Web `<img>` 的格式能力表。[LG 原生照片格式指南](https://kr.eguide.lgappstv.com/manual/w26_tv/w26_kr11/engk.html)

因此：

- JPEG / PNG 是首轮 native 回源测试的合适基线，但仍需实际 open。
- HEIF 有原生支持的文档依据，值得测试；不能因为当前 Web 查看器采用保守格式白名单就断言 C5 本身不支持 HEIF。
- 某个 HEIF 文件满足像素总数，并不自动证明所有 profile、位深、方向信息和编码变体都可解码。
- RAW 原文件不在上述 native 文件表内。不能把“NAS 能交出 RAW”扩大为“电视可原生显示 RAW”。

## 5. 目前能读到什么，不能读到什么

本次对 C5 的只读 `api/getServiceList` 查询确认：`media.viewer v1`、`media.controls v1` 已宣告。只读安装应用列表中存在 `com.webos.app.mediadiscovery`，其 UI 类型为 web、resolution 为 1920×1080。但本轮没有调用 open，**不能据此硬编码它就是接收图片的 App**。

ConnectSDK 的原生 `WebOSTVService#getMediaInfo`、`subscribeMediaInfo`、`getPlayState` 明确返回 notSupported；公开的图片请求也没有输出分辨率回调。本轮没有发现可据以实现“读取实际 native 图片输出像素”的受支持接口。不要凭名字创造 `media.viewer/getMediaMetaData` 或把文件 / 面板元数据当成它的替代品。[原生 MediaInfo 方法](https://github.com/ConnectSDK/Connect-SDK-Android-Core/blob/2f7ebbc7eb909321ff41b2c6bcdf6b0881427579/src/com/connectsdk/service/WebOSTVService.java#L924)

下列数值分别只能证明各自的范围：

- NAS `width/height`：索引中的源图片尺寸。
- `<img>.naturalWidth/naturalHeight`：Web 图片解码资源的尺寸。
- `deviceInfo.screenWidth/screenHeight`：电视的相关屏幕 / 播放能力值。
- `appinfo.resolution`：应用 UI 图形层的尺寸。

它们都不足以单独证明某一张照片最终以 native 4K 平面显示。

## 6. 最小且可恢复的下一轮实机测试

1. 先在不切屏的状态准备一个本机、短期、仅图片可用的原图能力 URL，并验证它的 GET / HEAD / Range、Content-Type、长度与原始字节。
2. 用户明确允许短暂进入照片查看器后，再以用户点击“系统查看”触发 `media.viewer/open`；先用 JPEG，再测 PNG 和已知 HEIF。不能在后台研究阶段偷偷 open。
3. 记录返回的 `id/sessionId`、服务侧 HTTP 实际请求和响应状态；同时观察实际前台 App。不要从候选 App 列表中预填结果。
4. 使用 3840×2160 的黑白高频线条 / 棋盘格测试图比较 native 路径与 FHD Web 图形路径，单独记录源读取、解码成功、可见显示和像素级输出证据。
5. 用持有的 `id/sessionId` 关闭该会话。若用户已切换到 HDMI 或其他界面，保留这个较新的手动选择，不再自动抢回 App。

还需处理服务存活：跳入系统查看器时，CloudFrame 的网页可能挂起或被关闭。只依赖网页持有的 Luna 订阅，可能在图片请求尚未结束时失去代理。应对自己明确持有的图片会话创建**有期限的 Activity**，完成后释放；不要永久关闭服务的 idle timeout。[LG JS 服务生命周期](https://webostv.developer.lge.com/develop/guides/js-service-faq)

## 7. 官方 TV 版功能边界：音乐与文件管理

本次使用原始 APK manifest 解析结果与实际菜单分支交叉确认，不用共用资源字符串推导功能：

| 项目 | 证据 | 结论 |
| --- | --- | --- |
| TV 主要入口 | manifest 注册 `MainActivity`、`MediaCenterHomeActivity`、`AlbumHomeActivity` 等共 25 个 Activity；主菜单真实点击分支为相册、影视中心、继续观看、最近更新、影视收藏 | 这些是确定的 TV 用户路径 |
| 独立音乐 App | 没有注册 Music Activity；主菜单与对应桌面卡片没有音乐分支，服务列表也没有独立音乐播放 Service | 当前 APK 没有找到独立音乐播放器入口，不应列成已经确认的缺失必选项 |
| 幻灯片背景音乐 | 相册预览 / 回忆页面实际引用 `AlbumSlideshowMusicRepository`，并有 NAS music check / stream 及缓存结构 | 是确定的 TV 相册功能；已补自带音乐与图片 / 视频资源互斥，自定义音乐选择入口尚未确认 |
| 通用文件管理 | 没有注册 FileManager Activity，主菜单没有文件管理分支；`RemoteWebActivity` 是协议 / 隐私页面，出现 `file:` 处理不等于文件管理入口 | 当前没有证据把通用 NAS 文件管理算作 TV 独立功能 |
| 相册文件夹浏览 | AlbumApp 的实际导航引用文件夹详情返回目标 / 页面，且有 `v5/photo/picture/folder/list` 调用 | 是确定的相册内功能，不能因无独立 Activity 而漏掉 |

“未找到独立入口”限于这个 APK 版本，不等于未来版本或其他平台一定没有相应功能。

### 相册项的实现状态

- 已实现相册内文件夹、面包屑导航、文件夹排序与分页。
- 已实现精选回忆、事件及其幻灯片资源列表；每张回忆列表最多 1000 项，不扩大为无限播放列表。
- 已实现幻灯片时长完整集合：2、3、5、10、15 秒。
- 已实现 Sequential、Random、Loop 和适应 / 填充；这里的官方 Original 是显示模式，不能解释成“原始文件或原生 4K 输出”。已知总数可跨页随机，未知目录总数只在本页随机并明确标注。
- 已实现 NAS 自带背景音乐、票据隔离和图片 / 视频切换时的音频释放；TV 设置实际绑定 musicEnabled，自定义音乐文件选择入口尚未确认。
- 已实现相册视频 `src_type=5`、照片 ID 的 NAS 画质协议及 owner 任务清理；仅 fake NAS 转码测试，待真实转码及电视解码验收。
- 已实现敏感图像当前预览显隐，不改变 NAS 持久属性；原生查看的配对 / 受限会话控制器已实现 mock 验证，仍缺实际适配器接入与实机证据。

以上清单来自实际相册预览屏、设置面板和类型引用，独立音乐 App / 通用文件管理应先列为未确认范围或额外扩展，而不是用共用文案扩大 TV 基线。

## 8. 已实现的受限 SSAP 会话控制器

`lib/native-photo-session.mjs` 是无外部包依赖的协议控制器。构造器不执行 IO，由调用方注入：

- `createSocket(url)`：固定传入 `wss://127.0.0.1:3001`，必须返回兼容 Node WebSocket 事件的连接；传输层仍须验证 / 固定电视证书，不可全局关闭 TLS 校验。
- `keyStore.load()/save(key)`：本 App 自己的私有授权存储。没有导入或复用开发电脑已有的 client-key，状态快照也不返回 key。
- `onLeaseChange({active,expiresAt,...})`：建立和释放有期限的原图代理 Activity；失败则清理本次打开的查看器。不能把一个返回 `true` 的空实现当作后台存活已得到证明。
- `onState(snapshot)`：仅状态、实时授权标志、是否存在本 App 保存 key、以及本次查看器会话 ID / 期限；不含源 URL 或任何密钥。

公开操作为 `connect({allowPairing})`、`open(localOriginalUrl, photo, {allowPairing})`、`close(reason)`、`disconnect()`、`dispose()`。首次没有本 App key 时必须明确传 `allowPairing:true`；注册 manifest 仅请求 `LAUNCH` 与 `CONTROL_INPUT_MEDIA_PLAYBACK`。保存过 key 不等于当前连接已注册成功。

控制器不提供通用 SSAP RPC。只发送上述图片 open 和同一响应 ID / sessionId 的 close；不发送全局媒体停止、输入源切换或其他 App 启动。连接 / 配对 / 请求默认超时为 10 / 60 / 15 秒，查看器默认期限五分钟且配置上限十分钟；没有无界 keepalive 或自动重连。取消后迟到的 open 响应也只关闭迟到的本次 ID，缺 ID 时不退回“关闭全部”。

socket 丢失不能证明照片查看器已关闭。控制器保留原有有限 lease 到截止时间；过期或显式关闭只尝试本次会话，无法确认时应提示用户按返回，而不是抢回 HDMI / App。旧计时器不能关闭较新的照片会话。

12 条 fake socket 回归覆盖最小权限、私有 key 存储、配对显式意图、超时、精确会话关闭、迟到回应、Activity 失败、取消及无效帧。**本轮没有真正连接、配对或 open，也没有 native 回源 / 解码 / 4K 的实机验收。** 接入真实 Node WebSocket 适配器可能需要新增 `ws` 运行时依赖，当前没有改 package 文件或打包该依赖。

## 9. 预览操作栏不等于手机端全部照片操作

实际 TV 预览动作枚举 `s4` 的六个 key 为 `restart`、`settings`、`resolution`、`speed`、`info`、`sensitive_image`。实际设置屏绑定 duration、playbackMode、displayMode、musicEnabled。没有找到这个 TV APK 可达的照片收藏切换、删除、下载、编辑或持久隐藏操作；相册 API `x4/b` 只有收藏列表读取，没有这些照片写接口。Kotlin 的 `collectAsState` 是流状态收集，背景音乐缓存 / App 升级的 downloading 文案也不是照片下载菜单。

`sensitive_image` 根据 PhotoBean 的敏感标记和当前预览 `sensitiveImageShown` 切换，因而实现为当前查看的显隐能力，并保持格子缩略图默认模糊。不能误实现成修改 NAS 敏感标记，也不能因只找到共用 API 字符串就加入删除用户文件的动作。这一结论仅限当前 APK 版本。
