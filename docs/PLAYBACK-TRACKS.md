# webOS 轨道和高级播放控制

`lib/playback-tracks.mjs` 是可直接打包到浏览器的纯 JavaScript 模块，没有 Node 模块依赖，也不会调用未经检测的 Luna `selectTrack`。它实际操作 `<video>` 暴露的轨道，而不只是显示 NAS 的元数据列表。

## 已实现的客户端行为

- 音轨：只枚举实际 `video.audioTracks`，通过 `enabled` 切换；NAS 的 PID（例如 4352）不会被当成 HTML 轨道索引。
- 内嵌字幕：只枚举实际 `video.textTracks`，通过 `mode` 选择或关闭。运行时没有轨道就返回不可用，不根据 NAS 描述凭空制造可切换轨道。
- 外挂 / 已抽取的文本字幕：取得 WebVTT 后，创建并复用一条应用自己的 `TextTrack`，填入真实 `VTTCue`。切换、停止或重复进入不会无限累积 renderer tracks。
- 字幕延迟：按原始 cue 时间重新计算，避免多次调节形成累计漂移。支持读取到 cue 的原生字幕及应用字幕；运行时不提供 cue 时明确返回未应用。
- 字号、颜色、透明度、背景、描边及垂直位置：使用经过校验的 `::cue` CSS 和 cue 位置；不会把请求样式改写成“实机显示已验收”。
- 语言：在实际轨道中按语言查找，处理 `chi/zho/cmn` 与 `zh`、`eng` 与 `en` 等别名；没有所需轨道时保持未应用。
- 记忆：由调用方提供 store，按不含 URL / token 的账号与影片范围保存音轨、明确关闭字幕、延迟和样式。轨道加载完成后恢复一次，之后不会用默认轨道覆盖新的手动选择。
- 倍速：与官方 Android TV 的 `getTVRates()` 相同，0.5、0.75、1、1.25、1.5、2 倍。音频直通模式只允许 1 倍；读回 `playbackRate` 确认设置被接受。
- 播放列表：官方 `sort_list`（顺序）、`loop_list`（列表循环）、`loop_single`（单集循环）的下一项计算。
- 画面适配：`contain`、`cover`、`fill` 的 HTML 视频样式控制，不改动外层视频元素的位置或 transform。
- 迟到结果：异步字幕下载受到源版本和选择版本保护；取消、关字幕或换片后，旧结果不会突然启用字幕。
- ASS：提供专用渲染器工厂接入、独立覆盖层生命周期、延迟、异步取消和资源清理。没有接入工厂时不会把 ASS 文本转换冒充完整样式渲染。

## 接入合同

```js
import { MediaTrackController, nextPlaybackIndex } from '../lib/playback-tracks.mjs';

const tracks = new MediaTrackController(video, {
  store, // get(key, fallback)、set(key, value)，只保存播放偏好。
  loadSubtitle: async (id, { signal }) => {
    // 访问本播放会话的本机字幕 API，返回 WebVTT 字符串。
    // 后端 offset 保持 0，延迟只在此控制器处理，避免重复平移。
    return fetchOwnedSubtitleAsText(id, signal);
  },
  onChange: state => renderTrackMenu(state),
});

tracks.setSource('accountHash:movie:123:version0', nasPlaybackOptions);
// 然后设置 video.src / load。emptied 会取消旧工作，但保留目标偏好范围。

tracks.selectAudio(tracks.state().audio[1].id);
tracks.selectText(tracks.state().subtitles[0].id);
await tracks.selectExternal(backendExternalSubtitleId);
tracks.setOffset(0.05); // 正值延后；0.05 秒即 50 毫秒。
tracks.setStyle({ size: 125, color: '#FFFF00', position: 90 });
tracks.selectLanguage('audio', 'zh');
tracks.off();

tracks.setRate(1.25, { passthrough: false });
tracks.setFit('contain');
const next = nextPlaybackIndex('sort_list', currentIndex, queue.length);

// 停止：reset；永久移除播放器：dispose。
tracks.reset();
tracks.dispose();
```

接入 `assjs` 时可增加以下构造参数。版本和依赖应由根构建流程固定，不能在电视端临时从 CDN 下载执行：

```js
loadAss: (id, { signal }) => fetchOwnedOriginalAssAsDecodedText(id, signal),
assContainer: document.querySelector('#ass-overlay'),
createAssRenderer: async (script, video, container) => {
  const { default: ASS } = await import('assjs');
  return new ASS(script, video, { container, resampling: 'video_width' });
},
```

然后 `await tracks.selectAss(id)`。调用方负责让 `#ass-overlay` 覆盖原生视频区域、禁止截获遥控 / 指针事件，并置于操作菜单下方；控制器为每个渲染器创建独立子层，切换或取消时销毁该实例。ASS 脚本样式不等同 `::cue`，此模式下普通文本样式返回 `applied:false`，避免虚假的字体覆盖承诺。

模块需由现有 esbuild 流程打包或通过一个浏览器入口暴露。不要把 `lib/playback.mjs`（含 Node 网络 / crypto）一起打进前端。

选择菜单必须使用控制器返回的 ID。ID 包含当前源版本，旧菜单项在换片后会失效。NAS 描述只在轨道数量一致时补充运行时空白的名称；数量不一致时不能强行按 NAS 列表索引配对。

## 官方 App 的真实选项与参数

APK 1.21.0 的对应类与约束：

| 项目 | 恢复的真实行为 |
| --- | --- |
| TV 倍速 | `Rate.Companion.getTVRates()`：0.5 / 0.75 / 1.0 / 1.25 / 1.5 / 2.0；通用移动端列表另有 3.0，TV 列表没有 |
| 播放模式 | `PlayModelType`：`sort_list`、`loop_list`、`loop_single` |
| 解码方式 | `Decode.hard` / `Decode.soft`，由 Android 原生 IPlayer / JNI 实现 |
| 音频输出 | `AUDIO_OUTPUT_STEREO` / `AUDIO_OUTPUT_BYPASS`；切到 bypass 前检查当前 rate 必须为 1.0 |
| 字幕颜色 | `UGNSubtitleColor`：透明 / 黑 / 白 / 黄 / 红 / 绿 / 蓝 |
| 字幕对齐 | `UGNSubtitleAlign`：顶部居中 / 底部居中 |
| 字幕调整 | 对话框将位置增减 0.05、字号乘 0.9 / 1.1、延迟增减 50 毫秒；重置走播放器的 reset 流程 |
| 轨道偏好 | NAS `v1/video/details/media_tracks` 的 audio / subtitle index 与语言；客户端原生轨道 ID 不是 API 预览列表里的 PID |
| 外挂读取 | `v2/stream/transcode/subtitle?subtitle_path=...`；NAS 列表为 `videoPath` camelCase body；已有后端模块实际验证 SRT → WebVTT |
| 内嵌字幕 | Android App 主要由 `libnasplayer.so` / UGN 原生解码器读取容器内字幕，不是把 pre_info 的字幕数组直接显示便完成渲染 |
| 跳片头片尾 | NAS `op` 是开头秒数；`ed` 从总时长倒数。必须按时长换算，不能丢弃 `start > end` 的片尾偏移 |

## LG 平台证据及限制

LG 官方公开文档提供 [mediaOption](https://webostv.developer.lge.com/develop/guides/mediaoption-parameter) 的加载与起播参数，但没有等同 Android JNI 的强制软解 / 硬解或单 App 音频直通开关。LG 官方人员曾在[开发者社区](https://forum.webostv.developer.lge.com/t/how-to-add-subtitle-in-webos-tv/2552)说明公开支持的字幕路径是外置 WebVTT。这不应被扩张为所有机型 / 固件都暴露同样的内嵌轨道。

其他开发者的原始实机记录表明 C5 可通过 HTML 音轨属性工作，但也记录了 Luna 直接选择越界轨道可能导致解码失败；这属于项目作者的实机证据，不是 LG 对所有固件的承诺：[音轨记录](https://github.com/lennylxx/webos-iptv-player/blob/main/docs/audio-track-selection.md)、[字幕记录](https://github.com/lennylxx/webos-iptv-player/blob/main/docs/vod-subtitles.md)。[Stremio 的源码与问题记录](https://github.com/Stremio/stremio-video/issues/189)也展示了重复的原生音轨选择可能覆盖用户偏好。

因此，本模块优先使用浏览器实际暴露的轨道，绝不以 NAS 元数据索引盲调 `com.webos.media/selectTrack`。属性读回确认仅证明控件状态被接受，不能代替声音或字幕画面的现场确认。

## 尚需补齐 / 实机确认

- 当前 C5 固件上 `audioTracks` / `textTracks` 的真实数量、实际语言与听感 / 画面仍需由根任务在获准测试窗口内核对；本研究没有切换电视或部署。
- 某个容器内字幕未由 LG 暴露时，还需 NAS 的真实抽取接口或有边界的客户端容器抽取器；不能用“不支持”按钮冒充完整实现，也不能将 NAS `media_tracks` 偏好写成功当作已渲染。
- 完整 ASS / SSA 定位、字体和动画，应实际安装并接入专用渲染器，再做 C5 画面测试。当前工厂适配契约匹配 [ASS.js 的作者 API](https://github.com/weizhenye/ASS)，支持完整脚本内容和 delay；测试用注入 renderer 验证生命周期，尚未声称渲染结果与 Android / libass 逐像素相同。
- 图形字幕 PGS / VobSub、强制解码方式与真正音频直通需要额外平台或媒体处理实现，普通 HTML 控件无法保证功能等价。

`node --test test/playback-tracks.test.mjs` 通过 14 项离线测试，包含实际 setter / cue / CSS 操作、ASS 工厂与覆盖层生命周期、取消竞态、偏好隔离和可用轨道边界；这些测试没有被称为实机解码验收。
