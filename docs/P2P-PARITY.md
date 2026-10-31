# 原生 P2P：协议证据、适配边界和接入合同

## 当前结论

**真实 NAS 协商已验证；官方 SDK 的事件与启动参数已恢复；LG 原生 P2P 引擎尚未贯通。** 当前交付不应在界面上标记“P2P 已完成”或把已有 HTTPS 中继改名为 P2P。

本模块提供协商、SDK 事件解码、LG 运行环境 / ELF ABI 检查、可注入的原生绑定生命周期、身份验证门槛及中继回退。未携带或分发从官方 APK 提取的原生库。

个人私有诊断已在真实 C5独立 App UID5059中通过 Bionic SDK版本读取及全禁网 init/release/进程退出；没有执行联网初始化、SDK start或NAS数据传输。详细范围、线程/内存事实与剩余缺件见 [P2P-NATIVE-FEASIBILITY.md](P2P-NATIVE-FEASIBILITY.md)。专有库没有进入公开 App或仓库。

**独立的受信 LAN HTTPS 加速已在 C5 验证可用。** 它使用官方 SmartDNS，不依赖尚未贯通的 SDK，也不称为 P2P。可仅取 `lib/transport/trusted-lan.mjs` 和 `test/transport-lan.test.mjs` 接入热修。

## 受信 LAN HTTPS：可独立接入

```js
import { selectTrustedLan } from './lib/transport/trusted-lan.mjs';

const lan = await selectTrustedLan({
  relayNas: existingRelayNas,
  alias: config.alias,
  // Optional: the full official nodeInfo response / its data object.
  // If omitted, the selector calls official discovery itself.
  nodeInfo,
  signal,
  timeout: 3000,
});
const upstream = lan.client || existingRelayNas;
// upstream has the same UgOS open()/request() contract; choose it internally.
const status = lan.summary; // lan-https or ugreenlink-relay; p2p is always false.
// On logout, changed NAS credentials, or connection disposal:
lan.close();
```

安全顺序：

1. 只取官方 `nodeInfo.netInfo.smartdns.lan / lanv6` 给出的 `*.lan.ug.link` HTTPS 主机，拒绝 HTTP、裸 IP、用户信息、路径和其他域名。
2. DNS 必须提供 RFC1918 IPv4 或 ULA IPv6 地址。固定本次已核验地址，TLS SNI / 主机名仍使用官方域名，防止从无 token 探测到认证请求之间发生 DNS 重绑定。
3. 公网 relay 和候选 LAN 主机均先访问**不带 token** 的 `/ugreen/v1/verify/handshake`，要求 CA / 主机名校验通过，且候选的 `x-ugreen-id` 与已信任 relay 匹配。UGOS 实际在该无认证探测中返回 HTTP 200、API code 1010，不能把它当成登录成功，也不能因此偷偷带 token 重试。
4. 只有上述检查通过，才经候选执行认证 `v1/user/priority_link`，并核对实际 `uglink_id`。成功后才返回可用客户端。
5. 候选客户端明确清除 `tlsFingerprint` 例外，使用正常 CA 校验；绝不禁用 TLS，也不自动接受 NAS 私有 / 自签证书。

成功返回 `{ client, route, summary, close }`；失败 `client=null`，`summary.mode='ugreenlink-relay'`。`route` 含内部 origin / 固定地址，不应传到前端或写盘。原 `config.server` 应继续保存 relay；不要用选中的私网地址覆盖持久化登录配置。重新登录、NAS IP 改变或 LAN 失败时关闭旧客户端并重新探测；失败后保留 relay。业务写操作不要因切路盲目重发。

C5 只读证据：无 token 预检 `rejectUnauthorized=true`、`socket.authorized=true`，与 relay 的实例 header 一致；随后认证 media_list 为 HTTP / API 200、2 个媒体库。运行**同一选择器模块**时，受信 LAN 选择约 552 ms，认证列表累计 583 ms，原生海报 116662 字节返回 200、耗时 24 ms。这是本次条件下的样本，不是所有网络 / 海报的性能保证。

6 项 `test/transport-lan.test.mjs` 覆盖请求顺序、证书失败、实例与账号不匹配、域名 / DNS 边界、固定 DNS、1010 无认证探测语义、超时和取消。真实 C5 的匿名化结果仅存本地 `.local/reference/p2p-parity-selector-c5-evidence.jsonl`；原始域名、NAS ID、会话未公开。

## 实际证据

对照版本：官方 Android TV 1.21.0，源码证据取自其 DEX / ELF。原 APK、反汇编、协商原文仅保存在本地 `.local/reference/`，不属于发布内容。

### 官方连接层

- `v1/connect/uglink/glinfo?clientVersion=1.21.0` 是 NAS 的已登录协商接口。
- 用户 NAS 实际返回 `tunnelType=uglinkAgent`、`tunnelStatus=1`，并给出 `agent`、`glConfig`、`pgConfig`；`supportTunnels` 当前为 `null`，不能据此构造虚假的可用后端列表。
- `agent` 携带 P2P 身份、认证键及 STUN / 信令 / 配置服务器参数。它们是私有协商数据，不能出现在前端状态、日志或公开仓库中。
- APK 的 `P2pType` 同时包含 `peergine`、`guanglian`、`tutk`、`uglinkAgent`，这些不是同一条可互换的 HTTP 路径。

`UGAgentService` 通过 JNI 加载 `libugagentsdk.so` 和 `libpgJniTunnel.so`。原生库的结构和字符串表表明，其自研路径包含加密 STUN、信令消息及 XQUIC 数据传输；它不是标准 WebRTC，也不是把 UGREENlink URL 替换为 IPv6 地址。

### 必须区分的 SDK 事件

根据 `UgAgentEventListener`、`UgAgentWrapper` 及连接结果对象：

| 事件 | 含义 | 能否标 P2P |
| --- | --- | --- |
| `event=0` | 本机 HTTP 代理开始监听 | 否 |
| `event=6, type=0` | 没有可用链路 | 否 |
| `event=6, type=2` | UGLink 云端转发 | 否 |
| `event=6, type=4` | 自研 P2P 选路，本机代理端口 | 仍须通过认证的数据路径验证 |
| `event=6, type=5` | 穿透科技 P2P 选路，本机代理端口 | 仍须通过认证的数据路径验证 |
| `event=7` | 中继节点变化，`location` 指向新地址 | 否；原链路状态需要重新判定 |

SDK 的 `init`、`startAgent`、`stopAgent` 参数由 `lib/transport/ug-agent.mjs` 独立实现序列化。`startAgent` 中 `uglinkAgent=true`、`p2pAgent=false` 等标志来自所观察到的官方包装层，不能仅凭字段名将其擅自反转并声称获得了穿透。

### C5 与原生库 ABI

只读查询结果：C5 内核是 `aarch64`，其 Node.js 进程的 `process.arch` 是 `arm`，即 32 位 ARM 运行时。

APK 同时提供 Android ARMv7 / ARM64 原生库。ARMv7的 `libugagentsdk.so` 虽然 ELF machine同为ARM，仍依赖 Android的 liblog/libc及Bionic ABI，不能作为LG glibc Node绑定直接加载。它包含JNI包装，也导出无需JVM的C门面；本次私有实验通过单独Bionic进程验证了受限运行，未把JNI误当成所有调用的必需条件。

LG 的 [JS Service 文档](https://webostv.developer.lge.com/develop/guides/js-service-basics)明确要求 JavaScript 实现的第三方模块，不支持 C/C++ addon。当前普通 webOS IPK 不能简单塞入 APK 的 `.so` 来获得原生 SDK。

UGREEN 当前[官方下载页](https://ai.ugreen.com/pages/app-download)没有提供 Linux 桌面客户端。本次尚未找到可在 LG 环境运行且分发许可明确的官方 Linux ARM SDK；这不等同于认定供应商内部没有此类构建。

### 当前网络

本次早期只读样本中，NAS的priority-link数据没有公网IPv6，C5的非回环IPv6地址仅为链路本地地址。未修改NAS、电视或路由器网络配置；没有为后续每轮实验重新检查这一可能变化的网络事实。

这意味着目前不能验收官方文档所述的公网 IPv6 直连路径，但不能据此断言全部 IPv4 UDP P2P 都不可能。官方[连接说明](https://support.ugnas.com/detail/article/en-US/671)也要求对实际网络做判断，并在穿透失败时回退中继。

## 根程序接入合同

```js
import { NativeTransport, UgAgentDriver, createAgentBaseConfig } from './lib/transport/index.mjs';
import { UgOS } from './lib/ugos.mjs';

const transport = new NativeTransport({
  nas,
  alias: config.alias,
  relayOrigin: config.server,
  driver: new UgAgentDriver({
    binding: optionalLgCompatibleBinding,
    // Caller chooses the trusted official cloud API origin; no guessed default.
    // Binding must execute in its verified private cwd; file logging stays denied.
    baseConfig: createAgentBaseConfig({ cloudApiOrigin: trustedOfficialCloudApiOrigin, logPath: '.' }),
  }),
  verifyRoute: async (route, { signal }) => {
    const probe = new UgOS({ ...config, server: route.origin, tlsFingerprint: undefined });
    try {
      const info = await probe.request('v1/user/priority_link', { signal });
      return { authenticated: true, alias: info.uglink_id };
    } finally { probe.httpsAgent.destroy(); }
  },
});

await transport.connect({ nasToken: config.token, nasPublicRsa, signal });
const uiStatus = transport.summary(); // No keys, endpoints or credentials.
const privateRoute = transport.currentRoute(); // For internal upstream routing.
await transport.stop();
```

`verifyRoute` 必须真实调用选中的代理通道并验证 NAS 身份，不能按输入 alias 原样返回成功。没有验证器、SDK 不存在、ABI 不符、未知链路类型、代理启动失败或身份不匹配时均回退 HTTPS 中继。

`summary()` 可以暴露给已认证的界面；`privateConfig`、原生启动参数和完整事件原文只能留在服务内部。普通 HTTP 请求不能注册一个 native binding 或指定任意引擎二进制。

### 原生绑定接口

这是本项目的适配接口，不是对官方 SDK 可用性的声明：

- `metadata`：`{ apiVersion: 1, platform: 'linux', arch: 'arm', abi: 'glibc', name, version }`。
- 隔离的Bionic进程另需 `abi:'bionic'`、`execution:'isolated-process'`、`lifecycle:'single-session-worker'`、`workerProtocol:'cloudframe-ugagent-stdio-v1'`、`runtime:{abi:'bionic',arch:'arm',apiLevel:24}`。只有离线init能力仍返回 `NATIVE_ENGINE_CONNECT_NOT_READY`；完整连接API和显式 `capabilities.authenticatedConnect:true` 也仅代表binding接口可用，P2P仍需选路后认证字节验证。
- `init(json)`、`startAgent(json)`、`stopAgent()`：保留官方包装层的 JSON 字段及返回码语义，负数表示失败。
- `subscribe(callback)`：传递原始 `(eventNumber, jsonString)`，返回取消订阅函数。
- 绑定来自受信任的应用代码，并负责把底层 SDK 调用限制在可取消、可关闭的单个会话中；不能从前端 JSON 动态生成。

默认没有 native binding，`nativeAvailable=false`、`nativeP2p=false`，原因是 `NATIVE_ENGINE_NOT_INSTALLED`。这一路径可正常读取协商并继续使用既有中继。

baseConfig必须明确注入；`createAgentBaseConfig` 从可信HTTPS云API地址提取host/port并按恢复出的provider字段构造配置。缺失、无效或混入NAS凭据的配置在init前拒绝。原生SDK的直接校验要求非缺失的logPath，因此调用者也必须提供经过私有cwd验证的路径；这不等于允许SDK写日志。这一APK确实通过manager/c.d()→HttpUrl→UgAgentP2pConfig选择api.ugnas.com:443；仍不在driver内部写死地址或猜其他区域配置。

## 尚需完成的原生贯通

1. 将已证明可受限运行的私有Bionic路径封装为完整、受监督、可取消的单会话worker，并验证遵循电视现有DNS的解析行为。
2. 将上述接口接到实际 SDK，而不是测试 fake；用官方 `event=6` 证明选路种类。
3. 经选中的本机代理验证已登录 NAS 身份，再读视频 / 照片流，并测量传输路径及字节计数。
4. 在真正不同的网络下验证穿透、断线、重新协商和中继回退。局域网直连不能冒充 NAT P2P。

只有经单独审核的私有隐藏诊断部署过SDK运行时；未启动诊断UI或主App、未切换输入源、未改变网络或修改NAS用户数据。公开App没有携带SDK库，也没有宣称原生P2P已贯通。

## 验证

`node --test test/transport.test.mjs`的15项测试覆盖协商隐私、事件分类、缺失SDK回退、认证身份门槛、取消、资源释放、显式云配置和隔离Bionic ABI/连接能力边界。测试注入fake SDK，只证明接口与状态机，不证明真实P2P已可用。

可用 `node tools/p2p-inspect-native.mjs PATH arm` 只读检查一个本地 ELF 文件；该工具不会执行它，也不会自动把它加入发布包。
