# 相册功能对照与接入记录

基线：绿联 Android TV 1.21.0 的相册模块（官方 APK 中的 `x4/b`、`SizeType`、相册预览和分类客户端）。逆向材料、NAS 返回值和个人会话均只放在本地 `.local`，不随代码发布。

## 已实现的相册能力

| 功能 | NAS 协议 | 本次实现与证据 |
| --- | --- | --- |
| 原始照片文件 | `v5/photo/picture/stream`，`size_type=0` | 新增 owner 绑定原图能力链接；206 Range 实测成功，原文件不进预览缩放缓存 |
| 实况照片动态部分 | 同一路径，`size_type=5,get_thumb=1` | 实测返回 206、MP4；查看器可播放动态部分并返回静态照片 |
| 人物、地点、事物、宠物、自定义分类 | `v5/photo/ai/{figure,city,object,pet,custom}/list` | 五类接口实测正常，分类描述保存为本机 owner 绑定的短期句柄 |
| 分类照片 | `v5/photo/ai/picture/list` | 人物 / 地点 / 事物 / 宠物分类下照片读取通过，分页与返回保留分类上下文 |
| 文件名搜索、照片文字搜索 | `v5/photo/search/cate`，category 8 / 5 | 正向搜索与无结果对照通过；不调用添加搜索历史接口 |
| 照片信息 | `v5/photo/picture/info` | 尺寸、格式、大小、拍摄时间、相机 / 镜头 / 曝光及地点；不向客户端返回 NAS 文件路径或原始 GPS 坐标 |
| 专门类型筛选 | `type_option.live/gif/raw` | 追加实况、GIF、RAW 筛选；不把 RAW / HEIF 当作浏览器已支持的格式 |
| 文件夹 | `v5/photo/picture/folder/list`，根 `path=''`、`storage_type=3` | NAS 返回的目录路径仅保留在 owner 句柄内；支持面包屑、逐层返回、名称 / 拍摄时间 / 大小 / 类型、升降序与分页 |
| 精选回忆 | `v5/photo/album/recommend`、`recommend/playlist` | 推荐卡片与播放列表；事件、相册上下文保留在服务端句柄，播放列表一次最多读取 1000 项并本地分页，最多缓存四份 |
| 幻灯片 | 官方预览设置枚举 | 2 / 3 / 5 / 10 / 15 秒、顺序 / 随机 / 循环、适应 / 填充；已知总数可跨页随机，未知目录总数明确标为“随机（本页）” |
| 背景音乐 | `v5/photo/picture/slideshow/music/{check,stream}` | 可选 NAS 自带曲目，票据不出代理；仅图片幻灯片时播放，进入视频前释放 audio 资源，回到图片后恢复位置；暂停、后台和离开均释放 |
| 敏感图像显隐 | `PhotoBean.isSensitivity`、预览状态 | 默认为模糊；用户明确“显示图像”才签发当前预览可见能力；退出预览恢复默认，格子缩略图始终模糊；不写 NAS 敏感标记 |
| 相册视频 | `v2/stream/transcode/info/play/close`，`src_type=5` | 画质菜单按 NAS 返回生成；通过 `video_path_id` / `path_type=1` 和 Base64 相册上下文绑定资源；继承安全 HLS 代理；mock 验证，尚未建立真实转码任务 |
| 视频播放操作 | 官方 restart / speed 动作 | 重新播放及 0.5 / 0.75 / 1 / 1.25 / 1.5 / 2 倍速；画质切换保留位置；实际电视编码与倍速兼容仍需实机验收 |

已有时间线、已有相册 / 收藏、旋转、放大、幻灯片和视频浏览保持兼容。隐藏人物不展示；人物的 `lock` 标志不会被错误当成“隐藏”而丢弃正常分类。

## 原图读取与真实 UHD 输出

官方 `SizeType` 的 ORIGINAL / SMALL / MIDDLE / LARGE 分别是 0 / 1 / 2 / 3。一次只读实测中，同一张照片的 SMALL 是 400×528 JPEG、LARGE 是 1280×1696 JPEG，而 ORIGINAL 是 3024×4032 HEIF。因而原图链接不能进入原来的 1920×1080 WebP 预览处理，也不能把 HEIF 的 Content-Type 改成 JPEG。

**原图文件可读取，不等于电视已经在 4K 图形平面显示它。** LG 官方说明，UHD 电视的 Web 图形层为 1920×1080，视频层可为 3840×2160。普通 `<img>` 即便读到了完整原图，也不能证明整屏原生 4K 输出。[LG 分辨率规范](https://webostv.developer.lge.com/develop/specifications/app-resolution)

查看器提供浏览器兼容格式的“原图 / 预览图”切换；HEIF / RAW 等不确定格式继续使用预览，并明确提示当前查看器不支持。原图加载失败可返回预览，不能悄悄替换后仍显示“原图”。

`photoOutputInfo` 保留原始尺寸，并始终将尚未验收的 `nativeUhdConfirmed` 设为 false。

## 电视原生查看候选

LG 的 ConnectSDK 公布了 `ssap://media.viewer/open` 的图片请求形状（target、title、description、mimeType、iconSrc）。C5 的只读服务列表也宣告 `media.viewer v1` 和 `media.controls v1`。[ConnectSDK 官方实现](https://github.com/ConnectSDK/Connect-SDK-Android-Core/blob/master/src/com/connectsdk/service/WebOSTVService.java)

`nativePhotoRequest` 仅准备该请求，限制为电视本机的已授权 `/photo-original/<cap>` URL，**不会自动启动其他 App**。尚未确认当前 C5 上这个入口使用哪一个图片查看器、是否需要额外配对权限，以及最终是否物理 4K 输出。ConnectSDK 还有原生 / WebApp 播放器分支，因此服务存在本身也不足以作为 4K 证据。

`NativePhotoSession` 另外实现了可注入 WebSocket 的 SSAP 注册、配对、打开和有界会话清理。构造器不联网；首次配对需调用方明确 `allowPairing:true`；本轮仅 fake socket 验证，没有真正配对或打开。详见 [原生输出研究](PHOTO-NATIVE-OUTPUT.md)。

待接入经过验证的原生查看适配器后，可向 `createPhotoGallery` 传入 `nativePhotoViewer`，才显示“系统查看”按钮。验收需用户允许短暂进入原生查看器，记录实际启动的 app/session、生命周期和输出效果；应使用 4K 细节测试图，不能只读文件元数据后宣称完成。

## 主路由接入要求

本模块不修改共享 `lib/bridge.mjs`。主路由需要接入：

- `GET /api/photos/categories?...` → `photos.categories(params, owner)`。
- `GET /api/photos/info?asset=<cap>` → `photos.info(params, owner)`。
- `GET /api/photos/folders?...` → `photos.folders(params, owner)`；目录句柄仍用 `folder` 参数。
- `GET /api/photos/memories?...` → `photos.memories(params, owner)`；进入回忆用 `GET /api/photos/list?memory=<handle>`。
- `GET /api/photos/music` → `photos.music(params, owner)`；`/photo-music/<cap>` 校验 `kind=music` 后原字节流式转发。
- `POST /api/photos/preview-visibility`，JSON `{asset,show:boolean}` → `photos.previewVisibility(body, owner)`。同样需要本机客户端认证；虽然不写 NAS，仍不能绕过 owner。
- `/photo-original/<cap>`：`photos.get` 校验 owner 和 `kind=photoOriginal`，再通过 `photos.stream(asset)` 取得固定 NAS 路径及参数，原字节直通，保留 Range / HEAD。
- `/photo-motion/<cap>`：同样校验 `kind=live` 后使用流式转发。
- 原图和动态部分不能进入 `Thumbnails` / `NativeThumbnails`，也不能走仅认识 JPEG / PNG / WebP 的图片 MIME 猜测分支。应保留 NAS Content-Type。
- 更换 NAS / 账号时 `await photos.clear()`，清除图片、分类、目录、回忆句柄并关闭本账号全部相册转码任务。
- 客户端更换连接后调用 `photoGallery.reset()`，避免把上一账号的相册、分类或搜索上下文带到新连接。

相册视频路由（全部按同一客户端 owner 认证）：

- `POST /api/photos/video/start`，`{asset:<video-cap>}` → `photos.videos.start(body, owner)`，返回 `{id,options,original}`。只有 `kind=video` 且已获准显示的能力可以创建任务；不接受路径或浏览器照片 ID。
- `POST /api/photos/video/quality`，`{id,quality,request}` → `photos.videos.quality(body, owner)`，返回 `{kind,quality,url,candidate,request}`。每次切换独立准备候选任务，旧任务保持可用。
- `POST /api/photos/video/commit`，`{id,candidate}` → `photos.videos.commit(body, owner)`。前端收到新源首帧 `loadeddata` 后确认，才关闭旧任务。
- `POST /api/photos/video/discard`，`{id,candidate?,request?}` → `photos.videos.discard(body, owner)`。关闭面板、加载失败、超时和迟到响应均显式丢弃候选；取消时尚未拿到候选 ID 可按本根会话内的 request 取消。
- `POST /api/photos/video/close`，`{id}` → `photos.videos.close(body, owner)`。
- `GET /photo-hls/<40hex-candidate>/<master-or-32hex-resource>`：master 用 `photos.videos.manifest(id,'master',owner,signal)`；子资源先 `photos.videos.resource`，`manifest=true` 则递归重写 manifest，否则固定 NAS 路径原字节转发。manifest 内的资源 URL 必须通过现有客户端能力 URL 处理器补认证，NAS token 不传给浏览器。HLS URL 用候选 ID，commit 后该 ID 继续有效；不能误把 UI 根会话 ID 当 HLS ID。
- 根会话最多 16 份，闲置 30 分钟主动关闭；每个根会话最多保留当前任务及一个候选，候选有不可续期的两分钟期限。离开预览、迟到 start、取消画质和切换账号均关闭自己的任务，没有循环 keepalive。
- 每个 NAS 任务创建时捕获独立客户端 / Agent：优先 `nas.snapshot()`，无该方法时 `new UgOS({...nas.config})`。候选从初次账号快照复制，关闭任务后销毁它自己的 Agent，绝不销毁全局 Photos NAS Agent。即使外部先改账号配置再调用 clear，旧任务关闭也不能携带新账号 token；snapshot 实现需保留自己的不可变账号配置及可复制 pin。
- HLS 分片代理同样必须使用 `photos.videos.hls(candidateId,owner).nas` 的独立客户端。`videos.resource` 返回的路径 / query 不能重新交给全局 NAS 去请求，否则账号切换时可能混用新账号 token。manifest 读取已在模块内部使用快照。

## 官方 TV 菜单的范围

实际预览动作 `s4` 仅有 `restart/settings/resolution/speed/info/sensitive_image`，幻灯片设置实际引用 duration / playbackMode / displayMode / musicEnabled。没有找到此 APK 中照片收藏切换、删除、下载、编辑或持久隐藏的可达菜单，`x4/b` 也没有相应照片写操作；不能把 Kotlin `collectAsState` 当作收藏按钮或共用下载文案当作照片下载功能。

已有收藏照片**读取**仍保留。敏感图像 show/hide 是当前预览状态，不能误实现成更改 NAS 的隐藏或敏感属性。当前未调用任何照片删除、编辑或收藏写接口；若未来新版本确有这些菜单，应另核对接口并用 owner 绑定资源及删除二次确认实现。

## 验证范围与剩余差距

32 条 Node 回归覆盖协议、owner 隔离、原图 / 实况、目录 / 回忆 / 音乐、敏感预览、相册转码、双账号独立连接快照、候选画质的确认 / 取消及绝对期限、旧任务关闭结果未知的报告，以及 SSAP 的限时清理。15 条独立 Playwright CLI 流程覆盖预览、遥控焦点、目录返回、回忆、幻灯片、背景音乐资源互斥、敏感显隐、速度及画质确认 / 取消 / 解码失败回退；这使用 fake 媒体元素，不代表实机解码或显示验收。

真实 NAS 只读调用已覆盖分类、分类照片、详情、原图、实况、目录、回忆列表 / 播放列表及自带 BGM Range；目录根到子目录、12 张推荐卡片、15 项样本播放列表、3 首自带音乐读取成功。没有上传、删除、编辑、重建索引、更改 NAS 设置或创建真实转码任务。

仍缺原生查看适配器实际接入与独立授权、相册视频真实转码和遥控器验收，以及物理 UHD 照片输出证据。回忆播放列表和未知目录随机范围有上述明确上限。自定义背景音乐的协议存在，但当前没有找到 TV 可达的文件选择入口，应列为未确认范围 / 扩展，不能直接作为官方 TV 确定缺项。不能以 mock 测试通过宣称“官方全部相册功能已齐”或“已完成 4K 原生输出”。
