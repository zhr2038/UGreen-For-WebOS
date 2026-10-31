# 播放设置面板接入

新增 `app/player-options.js` 与 `app/player-options.css`，沿用现有 `.player-dialog`。模块只重绘注入的弹窗容器，不重绘整个 App，不设置视频 src、不写 currentTime、不注册 `onended`，也不提交播放进度。

## 工厂

```js
const options = window.createPlayerOptions({
  video,
  api,
  asset,
  root: () => document.querySelector('#player-dialog'),
  getPlayback: () => S.playback,
  tracks, // 可选，建议使用 MediaTrackController。
  store,  // 可选 get/set；只存普通播放偏好。
  focus,
  toast,
  onClose() { /* 根清理 S.dialog，恢复原来的焦点和控制栏计时。 */ },
  async onSourceSwitch(result, context) {
    // 此处由根实现实际切源、续播位置、暂停状态和播放器重绘。
    // result.stream 为本机播放地址；context.sourceUrl 已由 asset() 处理。
    // context.id / context.playback：发起操作的播放会话。
    // context.position / paused：新源准备成功时的视频状态。
    // context.signal / isCurrent()：异步媒体准备前后的取消检查。
  },
});

S.dialog = 'advanced';
await options.open('settings');

// 在现有全局键处理器的播放器分支之前：
if (options.key(event)) return;

// 根原有的、唯一的 ended 处理器中：
const next = options.nextIndex(currentIndex, queue.length);
// next === null 表示顺序播放已到结尾。

// 返回、停止、换片或离开播放器时，根显式调用：
options.close();
```

`root` 必须是专门的弹窗容器，不是 `#app` 或整个 body。首次打开面板会替换这个容器中的旧弹窗，以免两个 `.player-dialog` 重叠。模块不挂全局键盘事件；根必须维护自己的 `S.dialog`，并优先调用 `key()`，否则旧播放器 Space / 返回逻辑可能重复执行。

支持页面：`settings`、`quality`、`audio`、`subtitles`、`subtitleStyle`、`language`、`rate`、`mode`、`fit`、`online`、`manage`。`back()` 逐级返回，`close()` 清理并触发 `onClose`。还提供 `active()`、`mode()`、`preferences()` 和 `nextIndex()`。

菜单开关、源版本和待处理请求都有 generation 保护。切源期间禁用重复操作；返回或换片后迟到响应不会触发 `onSourceSwitch`。空播放地址会报错，不会切断当前源。

## 仅使用以下 API

所有接口仍须由根检查本机能力令牌和 `play.owner`，不能只相信传入的 ID。

| 调用 | 请求 | 响应 |
| --- | --- | --- |
| GET `/api/play/options?id=...` | 当前播放 ID | `PlaybackSession.describe()` 的 `qualities/audio/subtitles/source/selected`，可附 `preferences` |
| POST `/api/play/quality` | `{id,qualityId,preferH264:true}` | `{stream,kind,quality,...}`；`stream` 必须非空，由根构造当前本机源地址 |
| POST `/api/play/preferences` | `{id,preferences:patch}` | 接受保存或抛出错误；面板区分“当前已应用”和“播放偏好未保存” |
| POST `/api/play/subtitle` | 见下表 | 获取 / 搜索 / 下载 / 删除字幕的统一分派 |

偏好 patch 可能包含：

```js
{
  mode: 'sort_list' | 'loop_list' | 'loop_single',
  rate: 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2,
  fit: 'contain' | 'cover' | 'fill',
  audio: { label, language, index },
  subtitle: {
    selection: { kind: 'off' } | { kind: 'native', label, language, index },
    offset, size, color, position, language
  }
}
```

`mode()` / `nextIndex()` 只决定队列索引，不会自行开始下一集。顺序播到末尾返回 null；列表循环回 0；单集循环返回当前索引。根仍负责唯一的结束、进度提交和下一项切源流程。

## 轨道与字幕

有 `MediaTrackController` 时，通过其 `state()` 列出真实音轨 / 内嵌字幕，并调用 `selectAudio/selectText/off/selectExternal/selectAss/setOffset/setStyle/selectLanguage/setRate/setFit`。

没有控制器时，音轨与内嵌字幕仍可通过实际 `video.audioTracks` / `textTracks` 操作；不会把 NAS 的 4352 等 PID 用作电视轨道索引。高级外挂渲染和字幕调整没有实现时明确显示不可用。

注入的 tracks 必须使用当前播放 ID 和同一个 api 接线，例如：

```js
loadSubtitle: async (subtitleId, { signal }) => {
  const result = await api('/api/play/subtitle', {
    id: getPlayback().id, subtitleId, format: 'vtt', encoding: 'auto'
  }, signal);
  return result.body; // JSON 返回的 WebVTT 字符串。
}
```

ASS 使用 `format:'original'`，由根解码成字符串并注入渲染器。字体 / 颜色按钮不会声称覆盖 ASS 脚本样式；延迟可以交给 ASS renderer。停止或更换源时，根还必须调用 tracks 的 `reset/setSource/dispose`，防止仅弹窗关闭以外的字幕异步工作落到别的影片上。

字幕 API 分派建议：

| 请求体（均带 id） | 对应后端 |
| --- | --- |
| `{subtitleId,format:'vtt',encoding:'auto'}` | `engine.subtitle()`，JSON 返回 `{body,contentType}`；后端 offset 保持0，避免与客户端再次平移 |
| `{action:'search',query,language,page}` | `engine.searchSubtitles()`，返回 `{items,page,pages,total}` |
| `{action:'download',resultId}` | 用户点击“下载并使用”才调用 `engine.downloadSubtitle()`；有 subtitle ID 后尝试真实读取，不把一个路径当作已下载完成 |
| `{action:'delete',subtitleId}` | 只有确认页点击“确认删除 NAS 字幕”才调用 `engine.deleteSubtitle()` |

没有自动下载 / 删除，也没有真实 NAS 文件写操作测试。在线字幕的提供商失败消息应如实返回。

## 根需处理的边界

- `getPlayback()` 最好始终返回当前实际源的 `quality.id` 或 `qualityId`，其优先级高于 NAS 的 prepared profile，避免准备了转码却尚未切源时显示错误状态。
- 切源请求被取消时，后端还需清理本次候选 NAS task；仅忽略迟到 UI 响应不能证明 NAS 已停止转码。若旧 HLS 源还在播放，应把候选任务与旧任务隔离，不能为取消新源而关闭正在用的旧源。
- `onSourceSwitch()` 若重绘播放器导致旧弹窗节点移除，根同时清理自己的 dialog 状态和旧面板对象。媒体事件监听、续播和进度报告继续由根集中处理。
- 本机 URI、字幕写入和偏好存储都应绑定账户 / 播放对象。面板的 API 检查不能替代服务端归属检查。
- 原生 setter 被接受不等于声音 / 字幕画面已经验收。NAS 轨道描述与客户端真正提供的轨道保持区分。

## 独立界面测试

```powershell
node test/run-player-options-ui.mjs
```

使用项目已有 Playwright CLI 和独立 headless Chrome 会话；只关闭自身会话。9 条模拟 UI 用例通过，覆盖真实动态档位、慢请求 / 重复点击 / 迟到响应、空源拒绝、实际轨道边界、字幕调节、六档倍速、三种队列模式、偏好保存失败、在线写操作的明确点击 / 删除确认，以及遥控器键处理。

已查看 `output/playwright/player-options-settings.png` 和 `player-options-style.png`，修正了设置焦点跳到返回按钮、长面板首尾露出半行内容的问题。截图是模拟内容，不是电视原画解码证据。
## 后台 hydrate 与外挂选择保存

根可在后台选项返回、仍是同一播放且用户未做较新操作时调用 `options.hydrate(data)`。该方法与 open 共享换片清理：播放ID变更会清空上一个片目的在线字幕结果/查询、关闭字幕标记、删除确认和画质缓存，并从当前片目偏好重新开始，避免临时能力ID跨播放沿用。

用户选中外挂字幕或点击在线“下载并使用”并实际读取成功后，面板将 `{subtitle:{selection:{kind:'external',label,language?}}}` 保存到现有偏好API。只保存安全文件名，不保存 `external:...` 临时ID或NAS路径；传给 `tracks.selectExternal/selectAss` 的第二参数为 `{descriptor:option,isCurrent}`，供同片事务捕获和异步取消使用。服务已经接受这一严格白名单类型；下次播放由 `MediaTrackController.applyPreferences` 用当前 metadata 解析新ID。

真实浏览器界面回归当前11项，增加外挂 descriptor 保存和 hydrate 换片清理两项。
