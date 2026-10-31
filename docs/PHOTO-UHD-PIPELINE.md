# 原图经视频平面显示：UHD 原型与验收记录

本轮只新增独立原型、能力查询和测试文件；没有修改现有 photos、bridge、背景音乐或 package 文件，没有切换 C5 画面、配对、调用原生 open 或部署。以下本机结果来自 2026-11-01 的 Windows / Headless Chrome 156，不能当作 C5 固件结果。

## 路径与成立条件

候选链路为：本机原图能力 URL → 原始 JPEG / PNG / 可支持的 HEIF 解码 → 3840×2160 OffscreenCanvas → WebCodecs AVC 关键图像 → MP4 → 本 App 的唯一 video 元素。遥控器、信息面板和幻灯片仍可留在原 App。

LG 的 UHD 机型图形层为 1920×1080，视频层可达 3840×2160；因此这条路径值得验证。它没有把 `<img>` 或图形层改成 UHD。[LG 分辨率表](https://webostv.developer.lge.com/develop/specifications/app-resolution)

webOS TV 26 使用 Chromium 132，TV 25 使用 Chromium 120；LG 同时提醒平台 API 可能与相应 Chrome 有差别。必须在 **实际安装包的页面上下文** 查询，不能用电脑 Chrome 或 C5 系统浏览器代替。[LG Web 引擎规范](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine)

LG TV 26 的 UHD 格式表包含 H.264 L5.1、HEVC、VP9 / AV1。该表只说明播放能力，不能推出 WebCodecs 编码能力或所有特殊低帧率文件均可播放。[LG AV 格式表](https://webostv.developer.lge.com/develop/specifications/video-audio-260)

WebCodecs 不要求实现支持特定编码器或图片格式；静态支持查询和实际编码是两层证据。[W3C WebCodecs](https://www.w3.org/TR/webcodecs/)

## 一次不播放、不切画面的 C5 查询

注入 `app/photo-uhd-probe.js` 文本后执行：

```js
await probePhotoUhdCapabilities()
```

默认只做以下查询，不创建编码器、不解码私人图片、不发网络请求、不播放声音 / 视频：

- secure context、协议、实际 userAgent、相关 API 是否存在。
- 3840×2160 的 AVC Baseline / High、HEVC Main、VP9、VP8 编码配置；包括硬件、软件或不指定加速偏好。
- ImageDecoder 的 JPEG、PNG、WebP、AVIF、HEIF、HEIC、两种 sequence 和 TIFF 格式支持。
- 同一 video 元素的 `canPlayType` 和 MSE `isTypeSupported`，不设置 src。

每个异步查询最多 1.2 秒，编码配置查询最多三个并发。默认最差约八秒；超时返回 timeout，不重试。返回 `provesEncoding=false` 和 `provesPhysicalUhd=false`。

可以单独加：

```js
await probePhotoUhdCapabilities({ probe4kCanvas: true })
```

此选项临时分配约 33MB 的 4K 离屏画布，在最右侧写入 / 读回一像素黑白细节后释放。它不会显示画布，也不证明视频平面或物理输出。

下一次约二十秒窗口优先只运行默认查询，保存完整报告。若 VideoEncoder 不存在或 4K 配置全部不支持，不能把这条候选路径显示为可用。

## 独立编码原型

`app/photo-uhd-pipeline.js` 暴露 `PhotoUhdPipeline`，构造 / 脚本加载本身不做 IO。调用方需要显式提供原始尺寸及取消信号：

```js
const result = await PhotoUhdPipeline.encodeOriginal(originalCapabilityUrl, {
  expectedWidth: photo.width,
  expectedHeight: photo.height,
  width: 3840,
  height: 2160,
  durationMs: 15000,
  fit: 'contain', // 或 cover
  codec: 'avc1.420033',
  hardwareAcceleration: 'no-preference',
  signal: abortController.signal,
});
// result.blob 为 video/mp4；由调用方决定何时、怎样播放。
```

原图 URL 只接受 `http://127.0.0.1:PORT/photo-original/<40hex-cap>`，不会接受 NAS 外部地址、预览图链接或账号密码。原图 GET 必须返回完整 200；最大读取 32MB，三十秒超时。JPEG / PNG 先读文件头尺寸再分配栅格；与 NAS 原图尺寸不符时直接拒绝，可接受 EXIF 导致的宽高对调。

HEIF / HEIC 不支持时返回 `IMAGE_DECODE_UNSUPPORTED`，保留先前的系统查看器候选，不改读 1280 预览。若未来 C5 的 ImageDecoder 确实支持，则解码原字节并校对解码尺寸后才进入画布。当前没有使用假 HEIF 文件成功解码来证明格式支持。

原型只支持 AVC / MP4，不支持 HEVC、VP9/WebM 输出、音轨或任意通用转封装。`fit=contain` 保留黑边，`cover` 裁切；PNG 透明度合成到黑色。报告保留原始尺寸、是否放大、编码器 codedWidth / codedHeight、输出栅格及限制。编码器明确返回不同尺寸时拒绝；没有 coded 尺寸时也不把该项标记为已验证。

工程上限为 50MP 原图和 24MB 单个编码样本；这些是拒绝上限，**不是已证明 C5 有足够内存处理上限文件**。需要实测源图、bitmap、画布、VideoFrame、编码器及两份压缩样本同时存在时的峰值内存。处理默认三十秒预算，退出时应 Abort；迟到 bitmap / VideoFrame 会释放，编码器最终关闭。

## 为什么不是严格只有一个 MP4 sample

本机先试过严格一帧的 MP4：ffprobe 读到 3840×2160、一个已解码帧及 15 秒时长，但 Chrome 的 `play()` 立即因 end of playback 抛 AbortError。因此 **仅写一个长 stts delta 并不满足可靠播放**。

当前只编码一次图片，复用完全相同的 IDR 字节，容器写两个 sample：第一项持续到末尾一秒，第二项作为尾部时间锚，合计正好十五秒。不是重新压缩两次，也不能声称文件只有一个 sample。2 / 3 / 5 / 10 / 15 秒的 sample 表、偏移和总时长已有回归。

本机浏览器可正常开始播放；在 13.8 到 14.6 秒跨尾锚处重复读取的黑白线差值均为 253，没有读到黑帧。这个结果限于电脑解码图像；尚未证明 C5 的原生视频平面无黑闪，也未测试每张照片更换 video.src 的物理切换。

真正连续幻灯片应优先研究固定 codec / coded size 的同一 MSE 视频轨道，向连续时间线上追加新照片关键图像，避免为每张照片重建 video。当前封装器输出普通 MP4，**没有实现 fMP4 init / moof / mdat 或 MSE 队列**，不能把支持查询为 true 当作连续播放实现已完成。

## Muxer、依赖与许可

原型的极小 MP4 封装器由本项目新写，没有复制或打包外部 muxer 源码，也没有新增第三方依赖或二进制编码器。编码器来自浏览器的 WebCodecs，`avc` 长度前缀数据及 avcC 取自编码器返回；不会把 Annex B 硬当成 MP4 样本。[W3C AVC 注册说明](https://www.w3.org/TR/webcodecs-avc-codec-registration/)

若扩展到连续 fMP4 / 音轨，维护中的 Mediabunny 是纯 TypeScript、零运行时依赖、MPL-2.0；接入需保留其许可与源文件要求。旧 mp4-muxer 是 MIT，但作者已明确弃用、停止修复。当前两者都没有引入。[Mediabunny 官方仓库与许可](https://github.com/Vanilagy/mediabunny)、[旧库弃用说明](https://github.com/Vanilagy/mp4-muxer/blob/main/README.md)、[旧库 MIT 许可](https://github.com/Vanilagy/mp4-muxer/blob/main/LICENSE)

## 可复现的本机证据

```powershell
node --test test/photo-uhd-pipeline.test.mjs
node tools/check-photo-uhd.mjs
```

第二条使用现有 Playwright CLI、sharp 和本机 ffprobe / ffmpeg；不会使用 `@playwright/test`，不会接触 C5。临时文件写入 `.local/reference/photo-uhd/`，不应提交测试媒体。

| 项目 | JPEG / PNG 实测 |
| --- | --- |
| 原始输入 | 本机构造的 3840×2160 一像素黑白竖线；不是 NAS 缩略图 |
| 4K 离屏画布 | 最右侧 1px 独立写入 / 读回通过 |
| 实际编码器 | AVC Baseline，no-preference；约 0.5 秒 / 图片 |
| 文件 | 315617 字节、15 秒、一个编码图像 / 两个 MP4 sample |
| ffprobe 独立解析 | H.264 Constrained Baseline L5.1、3840×2160、2 个解码帧、15 秒 |
| HTML video | videoWidth=3840、videoHeight=2160、duration=15；时钟可前进 |
| 高频细节 | 浏览器解码像素差 253；ffmpeg gray 独立解码差 252 |
| 错误源对照 | 1280×720 文件配 3840×2160 原图声明被拒绝，没有放大后冒充原图 |
| HEIF / HEIC 查询 | 本机 ImageDecoder 返回 false；不代表 C5 的原生系统查看器不支持 |
| 真实电视输出 | 尚未验收，`nativeUhdConfirmed=false` |

另一个实测反例：本机 `prefer-hardware` 的 UHD AVC 配置查询返回 true，但实际初始化报 OperationError；同一源改用 no-preference 后成功。不能把加速偏好当成“已经使用硬件编码”的证明。

## WebAudio BGM 与唯一 still-video 的试验方案

静音 `<video>` 仍占用媒体播放资源；不能因为没有音轨就并行开启原来的 `<audio>`。LG 说明 audio 元素使用硬件解码器、容易发生资源冲突；WebAudio 可用于其他声音，但 `createMediaElementSource()` 不支持，且约有 500ms 延迟，后台时也不会自动停止。[LG Multi-Sound Playback](https://webostv.developer.lge.com/develop/guides/multi-sound-playback)

待测方案是：保留唯一静音 still-video；BGM 从本机已授权 music 能力 URL 读取，解码到一个 AudioBuffer，经 AudioBufferSourceNode → GainNode → AudioContext.destination 播放，完全不创建 audio 元素，也不调用不支持的 createMediaElementSource。

实机验证应分阶段：

1. 先用合成的两秒音频静音解码，记录 AudioContext / decodeAudioData 支持、PCM 大小和时延；不动现有 BGM。
2. 用户允许后，播放一张已确认能出 UHD 的静态视频，同时用低音量 WebAudio 短音频，观察是否夺走 / 中断视频资源。
3. 再测一首 NAS 自带 BGM，记录响声、卡顿、原生媒体会话、CPU / 内存、暂停及恢复。长音乐不能盲目整首解码：48kHz、双声道、三分钟 PCM 约 69MB；必须先约束时长与预计 PCM，再决定完整 AudioBuffer 或后续流式 AudioDecoder / AudioWorklet 方案。
4. 进入普通电影 / 相册视频前停止 SourceNode，并 await AudioContext.suspend；离开 / hidden 同样暂停并保留偏移。回到静态照片前先释放普通 video 源，再恢复 WebAudio。只报告实际测试过的组合。

若 C5 的 WebAudio 和 UHD 视频不能稳定并行，后备方向是把 BGM 作为同一视频轨道文件中的音轨，整条资源仍只有一个 video 元素；这需要音频 demux / mux 与连续时钟实现，当前极小封装器没有支持它。现有 audio BGM 逻辑保持不变，未宣布此项兼容完成。

## 真实 4K 的下一轮验收

先用默认只读能力查询，再单独安排实际原图编码；不能在查询时偷偷播放。若 C5 编码成立，先将生成 MP4 通过本机短期、owner 绑定的 HTTP GET / HEAD / Range 资源交给唯一 video，作为原生媒体链路基线。之后才 A/B Blob URL / MSE：官方公开了 HTTP / HTTPS 与 MSE 支持，但本轮没有找到能保证任意 Blob URL 必然命中 UHD 原生平面的承诺。[LG 流协议规范](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm)

最终需使用 3840×2160 高频图对照 FHD 图形层，并从电视实际观看 / 像素级拍摄、原生媒体状态和返回时间线分别记录：原图读到、4K 解码、视频平面显示、物理细节、首次出画、尾锚、照片切换、暂停恢复、BGM 同时播放。videoWidth、ffprobe、编码成功或 App 未跳转，任何单一项都不足以替代这些物理证据。
