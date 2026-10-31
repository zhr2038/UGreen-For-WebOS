# NAS public_key 私有保留合同

官方 Android TV 1.21.0 的 `LoginDeviceResult.public_key` 和
`ScanLoginDeviceInfo.public_key` 原始字符串现保存为私有会话字段
`nasPublicRsa`。不解Base64、不转PEM/DER、不trim，不从密码握手头猜一个替代值。
该补丁只修复身份资料保留，不代表DeviceConnect握手、P2P或实际加速已验收。

## 已核对的官方证据

本地APK分析证据位于
`.local/reference/p2p-native-identity-contract/rsa-writers.txt`：

- 普通登录路径调用 `LoginDeviceResult.getPublic_key()`，随后把原字符串交给
  `e4.d.E(String)`；相关段落约75–80行。
- 扫码路径调用 `ScanLoginDeviceInfo.getPublic_key()`，随后同样交给
  `e4.d.E(String)`；约240–244行。
- 同一扫码资料中的public_key又传入新的LoginDeviceResult构造参数，约266行。
- native任务已沿该私有配置读出到DeviceConnect的 `nasPublicRsa` 参数，未经过Base64解码。

只认可这些已见证的 `public_key` 字段。没有加入 `publicKey`、证书公钥、
`x-rsa-token` 或其他兼容字段回退。现有 `x-rsa-token` 仍只用于密码加密握手，
其处理逻辑没有改变；没有证据证明它就是SDK需要的NAS身份字符串。

## 数据流和边界

`retainNasPublicRsa(value)` 从 `lib/ugos.mjs` 导出，返回原值或undefined：
必须是非空白字符串、UTF-8最多16KiB，不包含NUL或其他非法控制字符。
CR/LF/TAB及原有首尾空白保留。这里只做安全边界检查，不声称验证RSA内容。

| 入口 | 私有行为 | 普通响应 |
| --- | --- | --- |
| `UgOS.login()` | 成功login的data.public_key写config.nasPublicRsa；无效/缺字段清旧值 | 仍只返回name/model |
| `UgreenLink.pollQr()` | linkParams.public_key原值带入内部authorized.device.nasPublicRsa | 仅供DirectConnection消费，直接HTTP状态不返回device |
| `DirectConnection.commit()` | 复制并有界化candidate私有key；会话验证成功后替换config并持久化 | 返回白名单status，不含key |
| `DirectConnection.save/load()` | session.json的nasPublicRsa按原字符串原子保存/读回，沿用私有目录及0600文件模式 | status/qr poll均不暴露key |

账号替换使用新candidate，不能从旧config补key。新登录/扫码/保存会话缺key仍然
允许原有HTTPS功能，只清除旧key；不会为了可选P2P字段使登录失败。未成功的登录
不改变原会话；提交写盘失败回滚原config，包括原账号key。注销清除该字段。
load旧session缺nasPublicRsa时清掉内存中之前账号的key，不自动把旧文件里的
public_key/publicKey字段迁移进来。

该字段不加入status、QR普通poll、登录API返回或diagnostic值，不打印。
后续snapshot/seal/transport应携带同一个私有原字符串，并绑定初始账号身份；
缺key时native capability应如实返回缺少NAS身份，不使用另一个账号的key。

## 已有旧会话如何处理

旧session没有该字段时保持现有HTTP会话。当前没有建立并验证可供自动补key的
只读接口合同，所以不请求猜测端点、不使用密码握手头、不自动迁移、更不强制退出。
今后用户正常执行密码登录或官方扫码，且官方响应带public_key时，新私有会话就会
保留它；如果要做其他补录路线，先从官方代码证明响应来源、绑定账号和原值语义，
再另行实现。此补丁没有执行任何真实NAS登录、扫码或电视操作。

## 离线验证

```powershell
node --test test/nas-public-rsa.test.mjs test/direct.test.mjs test/ugreenlink.test.mjs test/ugos.test.mjs
```

21项通过，其中新增8项验证原字符串和边界、普通/QR私有持久化、普通响应不泄露、
缺字段兼容、账号切换/读旧会话清理、不猜兼容字段以及写盘失败回滚。
测试只用合成key、临时目录、假NAS与已有loopback测试，不读取真实会话文件。
