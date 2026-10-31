# 官方 TV App 播放功能对照与后端接口

此处对照绿联 Android TV **1.21.0** 的实际接口注解、请求模型与播放器菜单实现。使用独立实现，没有将原 APK、反编译源码或私有 SDK 二进制加入项目。

## 已实现的后端

`lib/playback.mjs` 提供每部影片 / 每集独立的 `PlaybackSession`。

- 原画始终保留为默认选项。读取选项不会提前创建转码任务。
- 转码画质仅来自 NAS 返回的 `transcode` 数组，不写死 4K、1080P 或某个码率。
- 按 NAS 原生流程创建任务、请求所选质量、读取 HLS；支持 H.264 兼容请求。
- 重写 HLS 中的分段、嵌套清单、初始化分段和密钥 URI。浏览器只取得本机不透明资源 ID，不会拿到 NAS token 或原文件路径。
- 取得 NAS 声明的音轨、内嵌字幕，以及已保存的轨道偏好。NAS 轨道 ID 和列表顺序分别返回，不将两者混为同一个索引。
- 读取 NAS 现有外挂字幕。SRT / WebVTT 与 ASS / SSA 的文本台词可以转换为 WebVTT，支持编码选择和正负字幕延迟；也可返回原始 ASS / SSA 字节供完整字幕渲染器使用。
- 提供在线字幕搜索、下载状态及删除适配器。下载和删除只接受本播放会话先前取得的不透明 ID，不接受浏览器提供的任意 NAS 路径；只应由用户主动操作触发。
- 读取跳片头 / 片尾信息及设置开关。`op` 是从影片开头计的秒数，`ed` 是从影片结尾倒数的秒数，接口将后者转换为绝对播放位置。
- 取消请求、关闭会话、切回原画或新任务准备失败时，只清理本对象的 NAS task ID。关闭失败会抛出错误，不报告虚假的资源释放成功。

## 接入方式

所有路由仍须先使用现有本机能力令牌认证，并检查 `play.owner`。一个会话只能对应后端已经验证的 `play.file.path`；不要把前端输入的文件路径传入构造函数。

```js
import { PlaybackSession } from './playback.mjs';

const engine = new PlaybackSession(scopedNas, play);
const options = await engine.describe();
const selection = await engine.selectQuality(options.qualities[1].id);

if (selection.kind === 'hls') {
  const manifest = await engine.manifest(resourceId => localResourceUrl(resourceId));
  // 以 manifest.contentType 返回 manifest.body。
}

const resource = engine.resource(resourceId);
// resource.manifest 为 true：engine.manifest(localResourceUrl, resourceId)
// 其他分段：沿用现有流式代理，转发 resource.path / resource.query / Range。

const subtitle = await engine.subtitle(externalSubtitleId, {
  format: 'vtt', encoding: 'auto', offset: 0,
});

await engine.close();
```

`localResourceUrl()` 必须把**当前本机能力令牌**编码到每一个分段 / 密钥 / 嵌套清单的 URL。原生视频播放器不会自动继承 JSON API 的 Authorization 请求头。不要在这些 URL 中使用 NAS token。

请给每个 `PlaybackSession` 传入对应账户的连接快照，而不是登录切换时会被改写的共享凭据对象。退出播放器、切换影片、注销或更换 NAS 时，需要清理旧会话。服务退出时也应等待受限的清理流程；仅发送一次前端卸载请求不能保证 NAS 的转码任务已释放。

可以通过下列方法扩展菜单：

| 方法 | 用途 | 状态边界 |
| --- | --- | --- |
| `describe()` | 实际画质、音轨和字幕列表 | NAS 能力，不是 LG 解码验收 |
| `selectQuality(id)` | 原画 / NAS HLS 转码 | 前端收到新源前保留原来的可用源和播放位置 |
| `manifest(map, resourceId?)` | 安全重写 HLS | 正文已改变，不能沿用上游 Content-Length |
| `resource(id)` | 内部流式代理描述 | 只给后端使用，不直接序列化给浏览器 |
| `subtitle(id, options)` | 外挂字幕读取和转换 | ASS 转 WebVTT 仅保留文本，完整样式需另接渲染器 |
| `trackPreferences()` | NAS 已保存的轨道偏好 | 不证明 LG 原生音轨实际切换 |
| `skips({duration})` | 绝对秒数的跳片头片尾区间 | `duration` 优先使用实际播放器时长 |
| `setSkipEnabled(bool)` | 用户主动改变 NAS 跳过开关 | 不会自动伪造跳过区间 |
| `searchSubtitles(params)` | 在线字幕候选列表 | 依赖 NAS 提供的字幕服务 / 账号 / 网络 |
| `downloadSubtitle(id)` | 用户请求下载或查询进度 | 返回 NAS 状态；有路径不等于文件已可读取 |
| `deleteSubtitle(id)` | 用户主动删除已列出的字幕 | 需要界面明确确认；测试没有实际删除用户文件 |
| `close()` | 幂等关闭自己的任务 | 可失败，不应把失败改写为成功 |

## 官方协议证据

Android TV 的 `MediaCenterApiInterface` / `QueryTranscodeInfoBody` / `BaseV2RequestBody` 声明：

| 操作 | 接口和必要参数 |
| --- | --- |
| 预览信息 | POST `v2/stream/transcode/pre_info`，`video_path`、`task_id`、`timestamp`、`src_type:2`、`v2Enable:true` |
| 创建任务 | POST `v2/stream/transcode/create`，同上；实际响应可以是空对象 |
| 转码信息 | POST `v2/stream/transcode/info`，从 `redir_link` 只提取 `video_name` |
| 选画质 | GET `v2/stream/transcode/play`，`m3u8_file=video_name_resolution.m3u8`、任务上下文、`regen:0`、`prefer_h264` |
| 播放清单 | GET `v2/stream/transcode/m3u8`，所选 `m3u8_file` 和任务上下文 |
| 关闭任务 | GET `v2/stream/transcode/close`，只提交自己的任务上下文 |
| 外挂字幕列表 | POST `v2/stream/transcode/subtitle/list`；这里是 **`videoPath`**，不是 `video_path`；还有 `supports` 和 `ignore_filter` |
| 外挂字幕字节 | GET `v2/stream/transcode/subtitle`，`subtitle_path` 和任务上下文 |
| 轨道记忆 | GET / POST `v1/video/details/media_tracks`，当前影片的 `file_path` |
| 跳片头片尾 | GET `v1/video/skipper`，`category_id`、当前文件 `path`；POST `v1/video/skipper/switch`，`switch_type` |
| 在线字幕 | POST `v2/stream/transcode/subtitles/search`、`subtitles/download/status`；DELETE `subtitles/delete` |

## 验证范围

真实 NAS 受控验证通过：

- 1080p AVC / AAC 样例返回原画＋720P＋480P；4K HEVC 样例返回原画＋1080P＋720P＋480P，并列出 37 条内嵌字幕描述。
- 真实 720P HLS：create → info → play → m3u8 返回有效的 `#EXTM3U` 清单；重写后约 3661 行，首个 TS 分段的 Range 请求返回 206、1880 字节且具有 TS 同步字节。
- NAS 已有外挂 SRT 转为有效 WebVTT，样例包含 2588 条字幕 cue。
- 各次受控验证均在 finally 中提交自己 task 的 close，NAS 接口接受关闭；没有切换电视输入源，也没有创建虚假的观看记录。
- `node --test test/playback.test.mjs`：13 项测试通过，覆盖能力菜单、HLS 资源隔离、任务取消和清理、字幕格式 / 编码 / 延迟以及在线字幕写操作的能力 ID 边界。

没有实际调用在线字幕的下载或删除，没有用接口返回值宣称电视硬解、音轨、HDR、杜比或物理画面已经验收。

## 官方 App 中仍需客户端 / 平台补齐的项目

官方 `ControllerInfo` 和播放器菜单还包含画质、列表 / 顺序、倍速、解码方式、音频立体声 / 直通、音轨、字幕调节、外置 / 在线字幕、跳片头片尾、画面比例 / 缩放、播放器信息等能力。

这份后端不能替代客户端工作：

- LG 的实际 `audioTracks` / 媒体轨道 API、内嵌字幕解码、硬解 / 软解切换和音频直通，需要按 webOS 能力接入并实机验证。
- 只把字幕描述列出来不等于已渲染内嵌字幕。ASS / SSA 的定位、样式、特效和动画也不能用简单 WebVTT 转换冒充完整支持。
- 倍速、画面比例、逐集 / 顺序播放、字幕字号 / 颜色 / 位置等主要由客户端实现；NAS 轨道记忆或跳过开关的成功响应不证明客户端已经切换。
- 当前实现使用实际验证的 v2 转码协议；旧 NAS 的 v1 动态兼容接口、网盘直链及特定字幕提供商，仍需对应设备证据。
