# 相册账号快照与生命周期

`Photos` 保留公开的 `photos.nas` 作为外部当前账号入口；真实的图片能力、分类、文件夹、回忆、音乐与视频会话，分别存放在内部 `PhotoAccount` 实例。每代账户拥有独立 NAS 客户端、配置、Agent、AbortController 和随机 epoch。

## 失效边界

- `photos.clear()` 同步使当前代失效，清 maps、取消 metadata、关闭原图/预览等读取流，再等待该代视频任务清理并销毁其 Agent。关闭旧 NAS task 始终使用它自己的子快照；不使用新账号，也不销毁外部全局 Agent。
- 每次公开入口以及异步返回都检查当前代和账号 identity。identity 包含 server、alias、username、uid、token、staticToken、authMode、clientId、TLS fingerprint、NAS RSA 和 password 的摘要；展示名称和传输模式变化不单独当作换账号。
- 即使调用者忘记 clear，只要 identity 已改变，迟到 metadata 也不能创建/发布旧能力。已经打开的原图、实况、音乐和图片流在下个输入 chunk 前再次检查 identity，停止继续输出旧字节。根仍应在切账号时主动 clear，不能用“下一个 chunk 检查”代替及时 reset。
- 同账号 clear 也换随机 epoch。能力、分类和 collection handle 的哈希包含本代随机量，相同 NAS ID 和同一电视 owner 不能复活旧链接或命中上一代的缩略图缓存 key。
- `get` 保留 owner 与有效期验证；跨代对象不能重新交给 `stream` 或 `image`。旧异步操作通常返回 410，旧 URL/能力查询返回 404。

列表、相册、分类、详情、敏感预览显隐、文件夹、精选回忆/播放列表、音乐检查都经同代连接读取。collections 自身 clear 也更新 generation/nonce 并取消旧读取。取消不依赖 NAS 或 fake 实现是否真的处理 AbortSignal：外层立即拒绝；迟到 open 返回的流被销毁，不再登记能力。

## 原字节代理接入

Root 已验证 owner 与资源 kind 后：

```js
const asset = photos.get(capability, owner);
const stream = photos.stream(asset);
await proxy(req, res, stream.path, stream.query, asset.kind, stream.nas);
```

必须传第六个 `stream.nas`，不能退回全局 `photos.nas`。`stream.path` 保持既有固定 NAS 路由；`stream.query` 和 `stream.nas` 均为非枚举属性，可直接读取，但不会进入 JSON。`asset.source` 同样非枚举且冻结，内部音乐 ticket、账号凭据与 Agent 不出现在公开照片 JSON。`photos.image(asset)` 在内部使用同一个快照，无须 Root 另传连接。

Root 在照片 metadata await 后仍需检查自己的 bridge generation，再发送结果；同时在登录/注销/切 alias 时调用 `photos.clear()`，客户端调用 `photoGallery.reset()` 清旧列表与音乐 UI。这与库内保护互补。

## 快照类型

生产优先调用同步 `nas.snapshot()`，必须得到独立实例与 Agent；已有 AdaptiveNas 快照保留经验证 LAN/DNS pin，且可继续创建独立视频子快照。直接 UgOS 则从私有配置复制创建新 Agent。身份字段不可写，配置对象不能被全局替换；AdaptiveNas 仍能更新自身非身份的 linkMode。

仅为已有离线测试保留普通对象 fake 注入：复制其方法、创建独立 config/Agent，不借用 fake 的全局 Agent。这不是任意第三方生产客户端的复制协议；未知 class、共享 Agent、异步 snapshot 或返回原对象的 snapshot 会拒绝。fake 的闭包行为仍由测试注入方负责，不能把 fake 通过当成生产网络验证。

## 回归

```powershell
node --test test/photo-accounts.test.mjs test/photos.test.mjs test/photo-collections.test.mjs test/photo-video.test.mjs test/photo-http.test.mjs test/photo-uhd.test.mjs
```

当前 59 项通过，包括 18 项账号生命周期细分检查。使用独立 fake NAS、真实 Node HTTP 与内存流；没有真实 NAS 操作或电视切屏。覆盖迟到 list、九类异步读取清理、无 clear 换身份、同 owner 跨账号、同账号清理 nonce、旧流停止、晚到 open 销毁、只关闭旧账号视频 task、实际 UgOS/AdaptiveNas Agent 与 LAN pin 独立性，以及丢 commit 响应后的 active 对账。
