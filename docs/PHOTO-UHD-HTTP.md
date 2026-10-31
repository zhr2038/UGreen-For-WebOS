# 原图编码为 HTTP 4K 照片视频

现在的主流程为：真实 `/photo-original/<cap>` → 浏览器原图解码 / 可选 HEIF Worker → 3840×2160 WebCodecs AVC → raw MP4 上传到电视服务的 RAM → 本 App 唯一有效 HTML video 读取 HTTP 能力 URL。**不使用 video Blob URL，不在 NAS 安装容器，不把预览图改名当原图，也不写临时照片文件。**

## 后端接入

```js
import { createPhotoUhdHttpHandler } from './photo-uhd.mjs';
const photoUhd = createPhotoUhdHttpHandler({ photos });
if (await photoUhd(req, res, {
  url, owner,
  urlContext: { client: authenticatedClientCapability },
  signal: requestSignal,
})) return;
```

owner / client 必须来自 root 已完成的认证。也可配置 clientToken 或 authorize，与照片视频 HTTP adapter 使用同一上下文约定。root 负责加入路由鉴权前缀、CORS / OPTIONS 及 reset 接线；模块本身不启动服务。

| 路由 | 行为 |
| --- | --- |
| `POST /api/photos/uhd?asset=<40hex-original-cap>` | raw `video/mp4`，验证 owner 的 photoOriginal 能力及文件，返回 `{id,url,expiresAt,video,nativeUhdConfirmed:false}` |
| `GET /photo-uhd/<40hex-id>?client=...` | 同 owner 的 RAM MP4，支持单段 / 尾部 Range、ETag / If-Range、无缓存 |
| `HEAD /photo-uhd/<id>?client=...` | 同样状态、MIME、长度、范围头，不含 body |
| `POST /api/photos/uhd/close` | JSON `{id}`，仅 owner 可关闭；停止该资源正在发送的响应并释放 RAM |

`handler.reset()` 清理自己全部在途上传和 RAM 资源，不重复调用 Photos / NAS reset。`dispose()` 永久禁用该 handler 并清理。没有文件路径、远程 URL 或写 NAS 接口。

## 有界 RAM 与生命周期

- 单上传最多 16MiB；全部有效资源、在途上传和发送中的缓冲区容量合计最多 24MiB；最多两个槽。
- 已知 Content-Length 时先预留并分配准确容量，读取时不积累 chunks 后再整份 concat。没有长度时预留完整 16MiB，避免无上限或瞬间双份复制；因此两个未知长度上传可能因总容量限制而不能同时接收。
- 文件从预留内存开始计算固定、不可续期的 TTL，最长两分钟。GET / HEAD 不延长；未完成上传还有三十秒期限。
- 资源删除后，仍在发送的 buffer 引用计入容量，完成 / 关闭后释放；reset / close 会终止这些读取。snapshot 只提供数量和容量，不提供 buffer、owner、原图 key 或 NAS 凭据。
- 上传完成前再次校验原图能力；每次读取也检查原图能力和 NAS 账号身份摘要。NAS 配置切换后旧 RAM 资源不能继续发布为当前账号资源。root 仍应在账号变化时明确调用 reset。

## MP4 验证不是只看 4K 标签

上传必须是本项目生成的普通、自包含、单视频轨道 AVC MP4；暂不接受 fMP4 / 音轨或任意通用容器。

验证包括 box 边界 / 数量、avc1 sample entry、avcC、SPS / PPS、时间表、sample 长度、chunk offset 和自包含 data reference。用 Exp-Golomb 读取 SPS，检查可见及 coded 尺寸均为 3840×2160；sample 内若含 SPS 也重新校验，不能由后续 FHD SPS 覆盖。把 sample entry 标成 4K、实际放 FHD SPS 的文件被拒绝。所有循环、计数、文件大小均有界。

这不是完整解码器，也不能证明像素来自所选原图或已经物理 UHD 显示；真正的源图读取由客户端原图能力路径和解码合同保证，播放阶段再检查 videoWidth / videoHeight。上传 API 不据此写 physical confirmed。

## 查看器行为

用户选择“4K 视频显示”后，`photos.js` 调用 `PhotoUhdPipeline.encodeOriginal(asset(p.original),...)`，以 NAS 原始尺寸校对像素源。准备期间保留当前 `<img>`；MP4 raw POST 成功后通过`videoPlane`借用完整App在`#stage`外的现有`#video`，等待 loadeddata、4K 解码尺寸及 play 启动，再切换显示并暂停于静态画面。未注入videoPlane的独立组件才创建自身video，并放在body首层，不能放入带transform祖先的照片canvas。完整App不增加第二个video；忙碌或已有src的主平面会拒借，保留照片预览。优先等待视频帧回调，平台回调未实现时保留短暂呈现间隔；这些仍不能替代实物观察。

状态明确显示有损视频及颜色可能不同。若原图本来较小，显示“放大不会增加细节”。没有把 coded 4K 等同新增图像细节或物理原生验收。

切图、返回、隐藏和退出会中止原图处理、归还借用video的原样式及媒体属性并清自身source、关闭 RAM 能力；独立fallback只删除自己的video。lease和srcIntent双重检查阻止旧清理修改同节点的新owner source/回调/属性。呈现时只令stage/viewer/canvas背景透明，归还时移除呈现class恢复照片层；独立4K成功也清除旧预览错误和loading遮罩。一份已开始的本机上传会在三十秒内完成或超时，若ID迟到立即按原gateway/client关闭，不覆盖新照片或新视频。失败保留原先预览/原图，不把失败结果继续标为4K。4K模式禁用图片旋转/放大；准备期间或显示后改变适应/填充，都会使旧输出失效并重新编码。GIF在此静态模式使用首帧，文案明确说明；原图模式仍可显示原动图。

## HEIF 注入合同

root 加载 `heif-client.js` 并提供 CloudFrameHeifConfig 后，photos 惰性创建 `window.createPhotoHeifDecoder()`；未实际选择 HEIF 不启动 worker。传给 pipeline 的合同为：

```js
decodeImage(blob, { signal, expectedWidth, expectedHeight,
  targetWidth: 3840, targetHeight: 2160 })
// => { image: ImageBitmap, sourceWidth, sourceHeight,
//      orientationApplied: true, scaled, close() }
```

sourceWidth / sourceHeight 是真实原始解码、按最终方向轴给出的尺寸，允许与 NAS 宽高对调；image 可以已缩至适合 4K 的中间位图。pipeline 校验原 source，并用 image 实际尺寸绘制。报告分别保留 source、decodedIntermediate、decoderScaled、intermediateUpscaled 和方向，不把缩图尺寸错误当成 NAS 原图尺寸。

HEIF 路径在主线程只读取 32 字节品牌头，直接把原始 Blob 交给 Worker，不先完整 arrayBuffer 再复制一次。成功、失败、取消和迟到结果均调用 close。当前可选实现、许可证、构建资源及真实 HEVC 测试范围见 [HEIF-DECODER.md](HEIF-DECODER.md)。没有 decoder / 不支持格式 / 超时仍走明确 fallback，不偷换预览。

## 背景音乐

加载 `photo-music.js` 时，普通图片与静音 UHD 视频共用一个惰性 WebAudio AudioContext / AudioBufferSource，不额外创建 HTMLAudio。切普通视频 / 实况前先同步停止软件 Source，再挂起 Context；返回图片按偏移恢复。Gallery 离开或账号变化时 dispose，不能复用已关闭的 Context。

没有该模块时保留旧普通图片 HTMLAudio 路径，UHD 则先释放它并明确提示背景音乐暂停。WebAudio 的 running / currentTime / setter 不证明扬声器实际出声，audibleVerified 保持 false；C5 的声音、延迟、内存和切换仍需根实机检查。[PHOTO-MUSIC.md](PHOTO-MUSIC.md) 记录该实现范围。

## 证据分层

本机/fake边界包含7条RAM/SPS/owner/Range/TTL/reset/读取取消回归；pipeline编码与解码合同、尺寸错误和迟到关闭；Gallery现有41条流程，新增共享video归还、无transform祖先、透明overlay、七类UI/账号竞态、hidden与迟到upload、lease/srcIntent、commit丢响应active对账等。脚本为`test/photo-uhd.test.mjs`、`test/photo-uhd-pipeline.test.mjs`、`test/photo-gallery-ui.js`、`tools/check-photo-uhd.mjs`；图库入口为`node tools/check-ui.mjs --photos`。这些Gallery测试使用fake媒体事件，不代表真实C5解码或物理输出验收。

root 的 C5 证据文件 `.local/c5-uhd-capabilities.json`、`.local/c5-uhd-encode-result.json` 和 `.local/c5-uhd-network-result.json` 已区分：

- Chrome132 packaged file 页面为 secure context，4K AVC no-preference / software 配置可用，hardware 配置不可用；HEIF / HEIC 的原生 ImageDecoder 不支持。
- C5 合成 3840×2160 PNG 真正编码成功，945ms、128879 字节、无上采样。
- 同 MP4 的 Blob 播放失败 code4；HTTP 原文件及 HTTP fragmented 能 loadeddata 并返回 3840×2160，MSE fragmented 另记录一帧。HTTP 两项的 frame 计数记录为 0，不能自行补成已看到画面。
- 已证明的能力查询、编码、HTTP 加载与 MSE 帧，不等于主查看器真实 NAS 照片、物理 4K 高频细节、颜色或可听 BGM 已全部验收。所有 physical / native UHD confirmed 字段仍为 false。
