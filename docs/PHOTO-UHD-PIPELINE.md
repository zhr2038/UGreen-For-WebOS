# 原图经视频平面显示：UHD 路径与验证

0.4.0 已将这条路径接入相册。C5 上已通过实际 UI 按钮验证真实 NAS HEIF 的解码、4K 视频加载、覆盖层和退出清理。本文记录软件和媒体链路证据；物理像素细节、原图色彩一致性及听感另行验收。

## 实际路径

原图能力 URL → JPEG / PNG 或惰性 HEIF Worker → 方向校正 → 3840×2160 OffscreenCanvas → WebCodecs AVC → MP4 → 本机有时限的 RAM HTTP 资源 → App 唯一主 video。

LG UHD 机型的 Web 图形层为 1920×1080，视频层可达 3840×2160。普通 img 读取完整原图不等于将图形层变成 4K。[LG 分辨率规范](https://webostv.developer.lge.com/develop/specifications/app-resolution)

C5 实测 Blob 播放未成功，同样 MP4 通过本机 HTTP 可以加载。因此实际接入使用支持 GET / HEAD / Range 的 owner 绑定 HTTP 资源，不把桌面 Chrome 的 Blob 成功推及电视。主 video 放在带 transform 的页面 stage 外；全屏覆盖层透明，避免遮住视频平面。照片与电影按租约独占此 video，归还时恢复样式和属性，迟到回调不能清掉后来开始的电影源。

## 编码与资源边界

`app/photo-uhd-pipeline.js` 只接受电视本机已授权的原图能力 URL。读取上限32MB、工程原图硬上限50MP；HEIF 默认解码预算更小，详见 [HEIF](HEIF-DECODER.md)。上限是拒绝边界，不代表已证明 C5 可以处理上限图片。

先核对文件头 / NAS 尺寸与解码尺寸，再按 contain / cover 绘制；透明像素合成到黑色。HEIF 先在 WASM 中缩放，避免把完整大栅格复制到 JS。迟到 bitmap / VideoFrame 会关闭，退出或取消关闭编码器和 Worker。

MP4 封装器由本项目实现，不依赖外部 muxer。只编码一次静态图像，容器复用同一 IDR 字节为两个 sample，第二项充当尾部时间锚；不是两个独立压缩图像。桌面 Chrome 的严格单 sample 试验会立即结束，因此没有采用它。支持2 / 3 / 5 / 10 / 15秒时间表；没有实现连续 fMP4 / MSE 幻灯片队列。

后端 `lib/photo-uhd.mjs` 校验 AVC SPS 的 coded3840×2160，限制单文件16MB、总RAM24MB及两个资源槽，包含进行中的上传 / 读取。资源有120秒绝对期限，不写磁盘或 NAS；关闭、账号切换及过期后释放。边界和能力鉴权详见 [HTTP](PHOTO-UHD-HTTP.md)。

**这是有损 AVC 视频显示，颜色可能与原图不同；不保留原始色深 / HDR，也不是逐点无损输出。** 低分辨率图片需要放大时明确提示。UHD 模式不同时旋转或缩放；普通预览继续支持原有操作。

## C5 实际结果

测试基线为 webOS26 / Chromium132，使用安装包自身页面；桌面浏览器和配置支持查询不代替实际编码。[LG Web 引擎规范](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine)、[WebCodecs](https://www.w3.org/TR/webcodecs/)

| 项目 | 实际结果 |
| --- | --- |
| 原图 | NAS4032×3024 HEIF；按方向校正为3024×4032 |
| HEIF Worker | 解码约3.3秒，输出bitmap1620×2160；WASM内存约88.4MB |
| 端到端 | 约5.9秒完成读取、解码、编码、上传与加载；该单一样本结果不是性能保证 |
| 编码与加载 | coded及videoWidth / videoHeight均3840×2160，未将小预览图放大冒充原图 |
| 实际UI | 点击相册及4K按钮，stage外唯一video，无transform祖先，覆盖层透明，控件可见 |
| 返回列表 | 视频src、平面租约、body / video样式、Worker、预载及临时RAM均清理 |
| BGM共存 | 真实约198秒内置MP3分帧解码，音频和4K视频时钟同时推进，PCM队列约0.6MB；Gain=0，不证明可听效果 |
| 物理与色彩 | 未做像素级拍摄 / 观看对照，不宣称原图色彩或物理4K细节验收 |

WebAudio 使用单个 AudioContext / Gain，长MP3逐帧解码且只排入短PCM队列，不创建第二个HTMLAudio，也不调用电视不支持的createMediaElementSource。离开、后台、换账号时显式暂停 / 释放，详见 [音乐实现](PHOTO-MUSIC.md)。LG 的多声音说明见 [Multi-Sound Playback](https://webostv.developer.lge.com/develop/guides/multi-sound-playback)。

## 本机验证

```powershell
node --test test/photo-uhd-pipeline.test.mjs test/photo-uhd.test.mjs
node tools/check-photo-uhd.mjs
node tools/check-ui.mjs --photos
```

UI回归中的受控媒体事件用于验证状态、清理和竞态，不能作为电视解码或物理输出证据。源码许可、HEIF对应源码及安装步骤见 [本版记录](CHANGELOG-0.4.0.md)。
