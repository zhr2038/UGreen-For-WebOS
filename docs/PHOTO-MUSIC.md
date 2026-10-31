# WebAudio 幻灯片背景音乐

`app/photo-music.js` 导出 `window.createPhotoMusic`，只用一个惰性 `AudioContext` 和 `GainNode`，不创建 `<audio>` 或第二个HTML媒体播放管线。短音频保留一个完整AudioBuffer；超过整曲PCM预算的MP3改用WebCodecs逐帧解码，以及最多约四秒的AudioBufferSource小队列。普通图片与UHD静音视频可共用这个实例；模块本身不操作图片、UHD video 或UI。

## 接入合同

```js
let soundtrack = window.createPhotoMusic({
  getGateway: () => new URL(asset('/')).origin,
  volume: 1,
});
await soundtrack.play(asset(track.stream), {
  position: savedPosition || 0, loop: true, signal,
});
const status = soundtrack.state();
savedPosition = status.currentTime;
await soundtrack.pause(); // 同步stop/disconnect当前全部Source，随后等待suspend。
await soundtrack.resume(); // 不重取文件；流式模式继续已有decoder和小队列。
soundtrack.setVolume(.5); // 0–1。
await soundtrack.stop(); // 清唯一buffer、URL和offset；context保留但suspend。
await soundtrack.dispose(); // NAS/账号切换：关闭context，清实例后重新创建。
soundtrack = null;
```

工厂不创建context、请求或解码。第一次play由用户操作触发时尽早调用 `context.resume()`，随后异步取流/解码。如果浏览器仍因策略挂起，state 如实给 `contextState:'suspended'`、`running:false`；不能当作声音已经播放。用户明确恢复时可调用resume；不存在能力/codec不支持会抛固定的中文 `PhotoMusicError`，不会启动备用HTMLAudio。

URL只能是当前gateway同origin的 `/photo-music/<40位小写hex>`，只允许一个非空client查询参数。禁止任意NAS路径、外部host、redirect、hash和其他query。网络错误不回显URL/cap/原始异常。`state.src` 供组件判断当前曲目，是不可枚举的本机URL；JSON状态不含cap。账号在同gateway内部切换无法仅凭origin识别，根必须在NAS切换、退出和gallery reset执行dispose并清实例。

## 状态和时间

`state()` 返回 `mode:'buffer'|'mp3-stream'`、`phase/currentTime/duration/paused/ended/loop/volume/loaded/loading/pendingDecode/bufferBytes/contextState/running/audibleVerified:false`，以及contexts/fetches/decodes/sources计数。currentTime 用实际 `AudioContext.currentTime` 计算并按duration取模，暂停同步记下偏移；每次resume重建一次性SourceNode，原节点立即stop/disconnect。loop中的暂停/续播不重取文件；流式decoder仅在loop边界或显式seek时重新配置。

流式状态额外提供 `compressedBytes/indexBytes/queuedSeconds/queueBytes/peakQueueBytes/retainedBytes/ownedBudgetBytes/decoderQueueSize/decoderInFlight/decoderInputs/decoderOutputs/decoderCount/frameCount`。计数不含曲名、文件路径、cap或原始异常；`retainedBytes`是模块保留的压缩数据、帧索引、PCM三者之和，不是浏览器进程RAM。`decoderInFlight`含已离开decodeQueueSize但还未输出的帧。

`paused` 是应用是否要求播放，`contextState` 是实际context状态；context运行、SourceNode启动、音频buffer已解码都不是出声验收。自然结束设置ended并保留buffer供显式play重播；stop清buffer，dispose关闭context。成功play返回的loading已是false。AbortSignal在加载和已成功播放的生命周期都有效，取消会停止播放。新play取消旧请求；迟到结果不能复活旧音乐。

## 资源和不可强杀的原生解码

默认完整音频文件最多16MiB、完整解码buffer最多64MiB（Float32长度×声道数×4），可收紧，不能提高这两个硬上限。读取直接复制到有界几何缓冲，不保留无界chunk对象数组；Content-Length存在时必须与实际字节一致。未知长度扩容/收尾复制的暂存字节有界，取消和超限会cancel reader。

WAV PCM/Float、FLAC STREAMINFO、MP3 LayerIII完整帧的samples/rate/channels在调用原生decode之前估算PCM大小，按context输出sampleRate折算重采样预算。短文件继续走原有decodeAudioData路径；MP3估计超过64MiB时自动走下述流式路径，不再拒绝正常三分钟的内置曲目，也不提高PCM上限。可用`mp3Mode:'stream'`强制短MP3走同一路径，默认`'auto'`。接受的完整decoded buffer仍做64MiB和声道/时长校验。

浏览器 `decodeAudioData` 没有可传入的 AbortSignal。取消/超时立即结束外层Promise、停止Source、清缓存和abort fetch，但原生decode可能继续直到浏览器返回。因此64MiB不是所有未知codec的解码器峰值分配保证。停止后仍在原生decode时，pendingDecode保持true，后续任务的fetch/decode排在串行锁之后，不同时开第二个context/buffer扩张。迟到buffer被丢弃。dispose发出context.close；若原生decode仍未结束，返回cleanupConfirmed:false而不声称已强杀释放。

默认加载/排队/解码总超时30秒，最多60秒；context控制默认3秒、最多10秒，避免挂起的resume/suspend/close阻塞幻灯片。其他照片/UHD预览始终由调用者保留。原生decode和重采样行为依据[Web Audio规范](https://www.w3.org/TR/2021/REC-webaudio-20210617/#dom-baseaudiocontext-decodeaudiodata)；MP3 LayerIII帧结构对照[FFmpeg官方解码头实现](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/mpegaudiodecheader.c)并用真实合成MP3验证。

## 构建和测试

root只需把 `photo-music.js` 加入静态资源/安装包，并在photos前加载；没有新的npm依赖或build步骤。测试专用可注入fetch/createContext，上层无需使用。

```powershell
node --test test/photo-music.test.mjs
node test/run-photo-music-ui.mjs
node test/run-photo-music-stream-ui.mjs
```

18项单测覆盖原buffer路径及长MP3的PCM队列上限、八帧in-flight（包括decodeQueueSize已归零而尚未输出）、暂停续播、seek、loop、迟到输出关闭、超时/abort、gateway变化与释放。原7项真实浏览器WAV/短MP3回归仍通过；新增7项真实Chrome WebCodecs回归用ffmpeg生成198秒48kHz双声道MP3（测试运行器要求本机ffmpeg/libmp3lame），以及已有22.05kHz MPEG2小样。实际读出非零PCM并以Gain0静音排定Source，队列峰值约1,548,288bytes，真实时钟推进、197秒seek+loop回绕、暂停续播单fetch和自然结束均通过。

**每个Gain始终0，没有发声或切换电视**，没有用用户音乐做桌面播放、不创建HTMLAudio。Root另在C5查得默认AudioContext 48kHz、mp3配置支持true；仍需Root用现有20秒窗口做真实builtin MP3与4K视频共存的Gain0验收。桌面证据和API setter不能代替C5解码、硬件共存或可听效果。

## 内置长MP3的有界播放

2026-11-01只读检查了当前NAS三条builtin音乐：压缩文件分别4,191,803 / 4,436,681 / 4,791,928 bytes，48kHz双声道MPEG1 LayerIII，帧累计197.856 / 186.768 / 199.296秒，48kHz整曲PCM分别约72.46 / 68.40 / 72.98MiB，均超过64MiB。这是实际容量限制，不是文件超过16MiB或过保守的时长估计。只保留数字元数据，没有保存音乐、曲名或cap。

只有一个压缩文件fetch，仍限制16MiB；完整压缩数据用于暂停续播、seek与loop，**网络下载本身不是按秒流式取回**。帧索引为最多100,000条Uint32偏移（约400KiB），校验连续MP3帧、稳定rate/channels，支持MPEG1/2/2.5、VBR、ID3v2前缀和ID3v1尾部。未知中断、截断或中途改变采样率/声道直接失败。

逐帧以`EncodedAudioChunk({type:'key',timestamp,duration,data})`送入`AudioDecoder({codec:'mp3',…})`；先通过isConfigSupported。最多八个尚未由输出时间戳确认的输入帧，亦检查decodeQueueSize。只有排队窗口以内的压缩帧进入decoder，不把整曲提交给codec后再丢弃大PCM。输出通过`copyTo(...,{format:'f32-planar'})`直接写当前小AudioBuffer，并在finally关闭每个AudioData；取消后的迟到输出也close。

PCM排队默认4秒（可在0.5–4秒收紧），最多8MiB且受maxBufferBytes进一步约束，节点最多256个；输入帧边界可能比窗口多不足一帧。已消耗PCM及时stop/disconnect并清buffer。显式模块资源预算32MiB，覆盖最多16MiB压缩数据、400KiB索引、最多8MiB PCM及1MiB codec传递预留。浏览器内部decoder、resampler、AudioContext分配不可由页面精确计量，该预算不等于进程峰值RAM保证。

暂停同步停止所有已排定Source，保留小PCM队列与压缩缓存，不继续喂帧；恢复重新排定小队列并继续同一decoder，无第二fetch或整曲decode。显式seek重建当前decoder，从目标前最多约两秒连续帧预热MP3 bit reservoir，丢弃目标以前输出；loop到尾部flush、关闭旧decoder后才建立下一轮，始终一个decoder。MP3 encoder delay/padding可能留下片头尾空白，不宣称无缝gapless。自然结束或seek到结尾会直接settle。

停止、abort、dispose、新播放会关闭当前decoder、清定时器和全部节点/PCM/压缩缓存；generation阻止旧回调恢复播放。每次继续喂帧先重验gateway，账号切换仍必须由根dispose（同origin内部换账号不能由URL检测）。不支持MP3 WebCodecs时长曲目返回静态`MUSIC_STREAM_UNAVAILABLE`，不退回超预算整曲解码或HTMLAudio。配置支持本身不代表真实解码成功。

此路径依据[W3C MP3 WebCodecs Registration](https://w3c.github.io/webcodecs/mp3_codec_registration.html)的逐帧/key chunk约定，以及[WebCodecs AudioData复制和生命周期](https://www.w3.org/TR/webcodecs/#audiodata-interface)；标准不要求浏览器支持MP3，也不允许用isConfigSupported结果代替实测。
