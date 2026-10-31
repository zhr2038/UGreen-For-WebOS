# 原生照片查看：Node 本机配对适配器

`lib/native-photo-loopback.mjs` 为已交付的 `NativePhotoSession` 提供 Node WebSocket、叶证书 pin 和本 App 私有授权存储。旧照片模块、rootservice、bridge、package 未修改；本轮没有连接真实 C5、配对或调用 media.viewer/open。

## 接口与接入

root 增加纯 JS `ws` 依赖后，可以在电视服务端创建一次 owner：

```js
import WebSocket from 'ws';
import { join } from 'node:path';
import { createNativePhotoLoopback } from './native-photo-loopback.mjs';

const nativePhotos = createNativePhotoLoopback({
  WebSocket,
  directory: join(privateWritableDataDirectory, 'native-photo'),
  appId: 'top.hrhome.nascinema',
  appName: '云映',
  onState: state => publishSanitizedState(state),
  onLeaseChange: lease => updateFiniteOriginalProxyActivity(lease),
});
```

构造和 import 不读文件、不联网。公开方法：

- `connect()`：只有此前由本 App 保存的有效授权才能开始连接。
- `connect({allowPairing:true})`：明确的用户配对操作；首次信任本机证书和无 key 注册只在此路径发生。
- `open(originalCapabilityUrl, photo, {allowPairing})`：先连接，再调用旧 Session 的受限图片 open；没有真实 `onLeaseChange` 回调时直接拒绝，不用空 Activity 冒充后台存活。
- `close(reason)`：正在初始化时取消并销毁 socket；已连接时仅关闭本 Session 持有的图片会话，保留本 App 配对状态。
- `dispose()`：取消初始化 / 清理本次图片会话、断开 socket，之后不允许重连；不删除已经合法保存的长期授权。
- `snapshot()`：仅返回状态、是否配对、是否保存过 key、当前图片会话、当前 TLS 是否已核对及有限错误码；从不返回 key、证书、指纹或私有文件路径。

目录必须是由 root 指定的本 App 专用可写绝对目录，不能来自浏览器参数。没有导入 key / 指纹功能，也不会扫描或复用电脑上的 `lg-tv.json`。传入 clientKey、keyStore、host、port、url 或 endpoint 覆盖项会被拒绝。

## 校验与凭据发送顺序

固定顺序为：

1. 加载本 App `identity.json`，校验格式、appId、固定端点及私有文件属性。
2. 仅连接 `wss://127.0.0.1:3001`，禁止重定向；TLS 实际远端地址和端口也必须匹配。
3. 从本次 TLS socket 的 `getPeerCertificate(true).raw` 计算 **叶证书 DER 的 SHA-256**，不是证书文字、CA 或公钥摘要。[Node TLS 证书接口](https://nodejs.org/docs/latest-v22.x/api/tls.html#tlssocketgetpeercertificatedetailed)
4. 存在 pin 时必须完全相同；证书改变时，即使调用者传 allowPairing=true 也拒绝，不自动覆盖。没有 pin 时仅显式 allowPairing=true 可以进行 TOFU。
5. pin 原子提交后，发送不含凭据的 hello，等待并核对 deviceUUID。
6. 以上全部完成，包装 socket 才向 `NativePhotoSession` 暴露 open。旧 Session 此时才发送 register / 自己保存的 client-key。
7. registered 返回的 key 必须绑定同一指纹、UUID 和存储版本后原子保存，才完成配对。

raw WebSocket 自己发出的 open 不会直接转交。证书变更时，连 hello 都不会发送，更不会 register。hello 的 UUID 改变时允许身份查询消息已经发送，但 register / key 仍不发送。

为连接电视自签证书，**仅本次固定 loopback TLS 连接** 设置 rejectUnauthorized=false，再用严格叶 pin 替代 PKIX 信任；不会修改 NODE_TLS_REJECT_UNAUTHORIZED、全局 Agent、系统 CA 或 NAS 证书策略。每次创建独立 TLS socket，不传入已有 TLS session，因此不会因应用级会话复用缺少叶证书而跳过校验；首次握手后禁用 TLS renegotiation，避免在已核对身份的连接内更换证书。

`ws` 通过注入的 createConnection 获取 TLS socket；使用 agent=null。Node 的 ClientRequest 在 agent=false 时会创建一次性默认 Agent，可能绕过指定 createConnection，因此不能把 agent=false 误当作同一行为。本轮核对了本机 Node 24.16.0 的 `_http_client` 源码；root 仍须在 C5 Node 运行时及锁定的 ws 版本复核该集成。[ws 官方客户端实现](https://github.com/websockets/ws/blob/master/lib/websocket.js)、[Node HTTPS](https://nodejs.org/docs/latest-v22.x/api/https.html#httpsrequestoptions-callback)

## 私有存储与并发

只有固定 `identity.json` 保存 format、appId、endpoint、fingerprint、deviceUuid、revision 和本 App clientKey。磁盘文件本身包含机密，不得直接转成 API 响应、日志或提交仓库。

- 专用目录 chmod 0700，临时文件 / 身份文件 0600。
- 同目录唯一临时文件以 wx 创建，写入、fsync、关闭后 rename 原子替换；POSIX 再 fsync 目录。
- 拒绝身份文件 symlink、硬链接、多余读取权限、错误 owner、超大文件或非本 App 格式；不把损坏的文件自动当成首次授权。
- 进程内按 canonical directory 串行，跨进程用 wx 锁文件短暂保护读 / CAS / 原子写。锁最多等待三秒，不猜测旧锁已经失效，也不自动删除其他进程的锁。
- 每次初始化有自己不可变的 allowPairing 意图、已读记录版本、TLS pin 及 hello 状态。CAS 发现另一次初始化已改凭据时拒绝当前旧操作，不能把 key 写进另一个 peer 的记录。
- 同一 owner 并发 connect 共用第一次调用的意图；稍后的 allowPairing=true 不会把原本未授权的初始化升级成配对。

取消后不会继续把原始 socket open 或迟到 hello / registered 交给 Session。socket、TLS 和超时清理是幂等的。若原子 rename 已经提交，随后销毁适配器不会撤销用户已批准且正确绑定的长期授权；没有为回滚未知磁盘结果而覆盖新记录。

Windows 不具备相同的 POSIX chmod / 目录 fsync 语义。本轮 Windows 测试验证逻辑与原子文件结果；0700 / 0600 的真正执行保证仍需在 C5 Linux 上检查。实现中的 POSIX 权限、owner 及 inode 校验会在对应运行时执行，不能用 Windows 测试结果冒充 Linux 权限验收。

## hello、标题与 manifest 的公开依据

基线为 ConnectSDK 固定提交 `2f7ebbc7eb909321ff41b2c6bcdf6b0881427579`：

- `handleConnected()` 调用 helloTV，hello 响应处理先检查 deviceUUID，再 sendRegister。适配器照此顺序执行，不在无 hello 回应时自动退回直接发送凭据。
- SDK hello 包含 appId、appName，以及 SDK / 设备 / OS / 分辨率 / 地区信息。这里实际发送本 App 真实 appId / appName；没有伪装成 Android 设备或填造 SDK 版本。其他字段是否是当前 C5 必需仍待实际握手确认。
- SDK 构建 manifest 时，实际写入 manifestVersion 和 permissions。appId、vendorId、localizedAppNames 在该函数里是注释项，因此旧 Session 不能仅因缺少 manifest 标题就判定为不兼容；应用名称已经通过 hello 发送。
- SDK 在 registered 之后还发送 verification，并按本地证书检查决定 handleRegistered，而不是等待 verification 回复。本适配器已在注册前严格 pin 证书，**没有伪造 SDK 的 public-key / validity verification 声明**。这说明两者并非字节完全相同的握手；若 C5 需要额外 verification，须根据真实响应实现，不能凭 fake 测试宣告无需该步骤。

上述均来自公开 SDK 源码，不是已验证的 C5 行为。[ConnectSDK SocketClient](https://github.com/ConnectSDK/Connect-SDK-Android-Core/blob/2f7ebbc7eb909321ff41b2c6bcdf6b0881427579/src/com/connectsdk/service/webos/WebOSTVServiceSocketClient.java#L223)

## 验证与剩余实机步骤

```powershell
node --test test/native-photo-loopback.test.mjs test/native-photo-session.test.mjs
```

11 条新 adapter 回归与原有 12 条 Session 回归通过。新回归使用 fake WS / TLS、合成叶证书字节和合成 key，覆盖：pin 前 raw open、不发送凭据、证书变化、UUID 变化、重连、同实例意图不升级、多实例 / 多目录认证隔离、取消与销毁、迟到消息、外部凭据 / 端点拒绝、原子存储结果和 hello 超时清理。没有真实 TLS 握手或 C5 授权成功证据。

root 下一轮先接入锁定版本的纯 JS ws 及私有数据目录，**只在用户明确点击配对后**运行 connect({allowPairing:true})。记录脱敏状态、实际 hello / pairing 类型和电视提示名称；不输出 client-key。先完成配对再单独安排原图 HTTP 回源与精确 session 关闭，最终再进行物理 UHD / 格式兼容验收。fake 测试、获得 client-key 或系统查看器成功跳转都不能单独作为原生 4K 照片显示的证据。
