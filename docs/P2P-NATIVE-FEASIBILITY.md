# C5 原生 SDK 个人用适配：可复现实验与具体缺件

## 已经实际证明的范围

**官方 Android SDK 的 ARMv7 原生库，已经在真实 LG C5 的独立 App UID5059 下，通过私有 Bionic 运行时完成受限版本读取，以及全禁网的初始化/释放并正常退出。** 没有使用 QEMU，也没有把 Android Bionic 库当成 glibc 加载。

这不等于联网 SDK 协商、P2P 穿透、加速或影片传输已成功。初始化实验的 socket 系统调用全部被 seccomp 拒绝，`sdk_init` 返回0、`sdk_release` 返回后 worker 正常退出；没有调用 `sdk_start_agent`、`sdk_start_agentP2P`，没有接收 NAS token / 账号 / SSAP key，也没有启动电视 UI 或切换输入源。

## 1. APK 中恢复出的真实调用面

对照 Android TV 1.21.0 的 `libugagentsdk.so`：

- ARMv7 ELF32，`EM_ARM`、EABI5、soft-float ABI，标注 minimum API 19 / NDK r24。
- ARM64 ELF64，`EM_AARCH64`，标注 minimum API 21 / NDK r24。
- 两个 ABI 都有 32 个全局导出，其中 29 个是 `sdk_*` 或相应 JNI 入口。
- ARMv7 的主库有 247 个动态导入，ARM64 有 273 个。主库依赖 `libpgJniTunnel.so`、`liblog.so`、`libz.so`、`libm.so`、`libdl.so`、`libc.so`；PeerGine 库还需要 `libstdc++.so`。

### C 门面存在，JVM 并非所有调用的必需条件

JNI 的 `init` / `startAgent` 包装主要负责转换 Java 字符串，随后调用已导出的 C 门面。可恢复的边界如下：

| C 导出 | 恢复出的输入 | 证据与限制 |
| --- | --- | --- |
| `sdk_version` | 可写字符缓冲、整数容量 | ARM32 / ARM64 两份直接机器码数据流确认；返回值未依赖 |
| `sdk_init` | JSON 字符串 | JNI 字符串转换后传入，返回整数 |
| `sdk_start_agent` | JSON 字符串 | 返回 HTTP 代理句柄，不能把它当成代理端口 |
| `sdk_stop_agent` | 代理句柄 | JNI 原样转发整数 |
| `sdk_get_agent_port` / `sdk_get_pg_agent_port` | 代理句柄 | 返回端口；尚未调用 |
| `sdk_get_link_type` | 代理句柄 | 返回链路枚举；尚未调用 |
| `sdk_start_agentP2P` | 代理句柄、JSON 字符串 | JNI 两个参数分别原样传递；尚未调用 |
| `sdk_set_token` | 代理句柄、两个字符串 | 来自 JNI 的整型与两个 UTF-8 字符串；尚未调用 |
| `sdk_register_agent_event_callback` | 回调指针 | 回调接收代理 ID、事件号、JSON 文本；尚未注册 |
| `sdk_release` | 无输入 | 离线调用已返回；仍需区别于 SDK 已逐线程关闭 |

**本次没有找到 UGAgent 的公开 C 头文件。** 上表是对官方二进制与 JNI 包装的恢复结果，不能写成“官方头文件已确认”。后续任何新增调用仍应逐一核对真实 ABI。

版本原型的直接证据：ARMv7 `sdk_version` 在 `0x3483e4` 检查第一个寄存器参数非空、第二个参数为正；容量足够时写入固定版本字符串，小缓冲分支按容量减一复制并补零。ARM64 `0x557b84` 的缓冲 / 容量数据流一致。JNI `getVersion` 内联了同一字符串，并没有调用这个 C 导出。

因此版本探针采用 128 字节缓冲，按 `void sdk_version(char*, int)` 的输入边界调用，忽略返回；这次实机返回与静态字符串完全一致。

## 2. 运行时路径与静态闭包

C5 的只读环境信息为：内核 `6.12.44-352 / aarch64`，Node.js 进程 `process.arch=arm`。普通 Node C/C++ addon 与直接 glibc `dlopen` 不是此次路径。

现有服务的只读进程元数据为独立 App UID、无有效 capability，当前 `NoNewPrivs=0 / Seccomp=0`；这不是子进程执行许可的证明。服务包文件由 root 拥有，后续应在服务自己创建的私有目录生成属于 App UID 的运行副本，而不是修改现有包文件权限。SSH 探针目录也不能直接等同于 App 的私有目录。

私有实验运行时取自 Google 官方默认 AOSP API 24 ARMv7 系统镜像：

- 元数据：[Google Android system-image repository](https://dl.google.com/android/repository/sys-img/android/sys-img2-1.xml)。
- 包：`armeabi-v7a-24_r07.zip`，283677512 字节。
- Google 元数据 SHA-1：`3454546b4eed2d6c3dd06d47757d6da9f4176033`，下载后已校验。
- 同一system.img的公开构建指纹为 `Android/sdk_phone_armv7/generic:7.0/NYC/3245079:userdebug/test-keys`，build日期2016-09-02、patch2016-09-06；镜像内build.prop与zip外部build.prop逐字节一致。没有取得可证明精确源码tag的manifest；文中android-7.0.0_r1仅是源码审核baseline，不能当成r07二进制的精确来源声明。
- 从原始 ext4 `system.img` 只读提取 `bin/linker` 与 `libc/libdl/libm/liblog/libz/libstdc++`，没有挂载或修改电视 / NAS 系统。
- AOSP `NOTICE.txt` 随私有运行时保留；SDK 库仅从用户已有的官方 APK 导入，未进入公开仓库或发布包。

交叉编译的 `tools/p2p-native-probe.c` 是独立 ARM32 PIE。采用 `-nostdlib` 和显式 Bionic `libc.so / libdl.so`，没有链接宿主 glibc 或 musl。编译目标字符串虽采用 ARM EABI 编译配置，但实际动态依赖完全由 ELF `NEEDED` 和私有 Android linker 决定。

静态闭包检查：552 个强动态导入均可在 SDK 与该 Bionic 运行时中找到定义；13 项符号版本要求也均存在。仅剩 3 个 OpenSSL 可选弱钩子未定义。**静态闭包本身不是执行证据**，实机加载结果单独记录如下。

## 3. 首轮 C5 prisoner 版本探针

在 SDK SSH `prisoner` 上下文执行，不是 App UID / jail 上下文。初始指定的 `/media/developer` 父目录不可由该用户写入；未改其权限。经重新限定后，仅在 SDK 已有可写 `temp` 下的 `/media/developer/temp/cloudframe-p2p-probe-*` 创建自有 `0700` 子目录，先核对规范化绝对路径和 SHA-256 清单。没有 root、系统权限变更、全局环境写入、用户 HOME 配置或电视 UI 操作。

限制与顺序：

1. SSH supervisor 和目标子进程都设置 CPU ≤5 秒、地址空间 ≤256 MiB、core dump=0；任一限额无法设置或核验就停止，不加载库。
2. 原生探针先设置 `no_new_privs` 与 seccomp，拒绝 `socket/connect/bind/sendto`。再确认一次受阻 `socket` 返回 `EPERM`；否则停止，不加载 SDK。
3. 只调用 `dlopen / dlsym / sdk_version / dlclose`。没有初始化或连接 SDK，也没有 NAS 认证材料。
4. supervisor 外部墙钟限额 10 秒、输出限额 64 KiB；超限只终止这次自有子进程。

实际结果：

| 项目 | 结果 |
| --- | --- |
| 原生进程退出码 | 0 |
| 墙钟耗时 | 79 ms |
| 资源限额核验 | 通过 |
| seccomp 的 `SOCKET_EPERM` 核验 | 通过，且发生在 `dlopen` 之前 |
| SDK 版本 | `V3.0.0-2026102100` |
| 所列 9 个 C 导出 | 全部可查到 |
| SDK init / start / P2P 调用 | 没有执行 |
| 外部限额终止 | 没有触发 |

加载器给出 `DT_FLAGS_1` 元数据及未设置 Android 时区根目录的警告，未导致本次版本探针失败。尚未因此修改 SDK 或电视系统来隐藏警告。

完整限制、二进制 SHA-256 与远端文件清单仅存本地 `.local/reference/p2p-native-c5-version-result.json`；专有库保留在经批准的私有目录，不能误上传到 GitHub。

## 4. 公开 Linux / 可分发实现调查

- UGREEN 自己的当前[客户端页](https://ai.ugreen.com/pages/app-download)没有 Linux 桌面客户端。不能把这个事实扩大成“所有依赖供应商都没有 Linux SDK”。
- 穿透科技的[官方 SDK 索引](https://www.peergine.com/static/downloadnew.json)确实提供 2026-09 的 PeerGine Tunnel SDK Ubuntu / CentOS 下载。取到的 Ubuntu 2.15.2.123 包只有 x86 / x86_64 glibc 库及头文件，没有可直接给 C5 使用的 ARM 发行物；Embedded Linux 下载项为空，需要供应商提供具体构建。
- 公开的 [peergine/pgPluginLib](https://github.com/peergine/pgPluginLib)是 Android 包装与 Android `.so`，并非可重编译的 Linux ARM 核心源码。
- [Alibaba XQUIC](https://github.com/alibaba/xquic)本身是 Apache-2.0 的公开传输库，但不是 UGAgent 的认证、信令、加密 STUN、代理或 NAS 身份绑定实现，不能只链接 XQUIC 就称对接绿联 P2P。
- 对现有 NAS 只读进程元数据能看到原生 agent 服务，但未提升权限读取受保护的可执行路径或拷贝系统组件，没有据此证明存在可直接复用的 ARM 客户端引擎。

官方 PeerGine SDK 头文件和二进制保留其原版权标记，没有找到允许把这些供应商二进制直接随本项目公开再分发的明确许可。个人私有 APK 导入与公开 IPK 分发必须分别处理；此次没有发布专有二进制。

## 5. 现在剩下的最小具体缺件

版本和离线生命周期探针已消除了“C5 内核或 App UID 完全不能执行该 Android 核心”的猜测，下一步的缺件更具体：

1. **可复用的受监督 worker。** 已在独立 App UID5059 中通过私有运行副本、child-process、版本/离线 init 验证；尚未把这条个人私有导入路径接入主 App，也未验证其他型号/系统版本。
2. **关闭和进程隔离。** 全禁网 `sdk_init` 返回0、`sdk_release` 已返回、worker exit0。快照中 init 后、release 后、dlclose 后仍有3个线程，因此不能说 release 已逐线程清空，也不能据此在常驻进程中反复 init。短命独立 worker 的进程退出边界仍然重要。
3. **DNS / Android 系统依赖。** 真实 DNS、Android 属性与日志行为尚未验证。已从 AOSP 源码确认 optional netd-client 缺失时保留原生 socket 调用，getaddrinfo 的 Android proxy 系统错误也有进程内 resolver 回退；但该 Android resolver 不自动读取普通 resolv.conf。实际 libc 导出 `_resolv_set_nameservers_for_net`，可考虑仅在 worker 内采用电视当前的同一 DNS 列表，仍需独立验证，不改系统 resolver 或偷偷改用外部 DNS。[AOSP NetdClient](https://android.googlesource.com/platform/bionic/+/android-7.0.0_r1/libc/bionic/NetdClient.cpp)、[AOSP getaddrinfo](https://android.googlesource.com/platform/bionic/+/android-7.0.0_r1/libc/dns/net/getaddrinfo.c)、[AOSP resolver cache](https://android.googlesource.com/platform/bionic/+/android-7.0.0_r1/libc/dns/resolv/res_cache.c)
4. **实际协商和数据通道。** 之后才可提供 NAS token、已验证 NAS 公钥及官方配置，观察真实 SDK `event=6,type=4/5`，验证 NAS 身份和视频 / 照片字节经该通道传输，并测试断线和中继回退。
5. **客户端封装与分发。** 个人版本可考虑独立受监督 worker、从用户自己取得的 APK 导入 SDK；公开版本仍需合法可分发的兼容构建 / 授权，或独立实现余下协议。JS 服务不应把 native 崩溃或失控调用带进 UI 进程。

这份报告不把 SDK 版本读取写成 P2P 完成，也不把同局域网 HTTPS 或公网 IPv6 地址直连改名为“SDK P2P”。

## 6. 复现材料与范围

- `tools/p2p-native-probe.c`：有 BSD 通知、版本 / 符号探针、资源限额、禁止网络且失败即止；不是连接工具。
- `tools/p2p-native-offline-report.py`：只读 APK ELF 元数据和可选运行时符号闭包，不执行库；研究环境需要 `pyelftools`，普通安装 App 不需要它。
- `.local/reference/p2p-native-*`：本次私有下载、校验、ELF / 反汇编、构建命令、运行时、远端清单与原始探针结果。它们不属于发布内容。

任何实机复现都需要重新确认其具体目录、限额与步骤；不能把本次一次性版本探针的授权当成后续初始化或联网授权。

启动结构参考 AOSP 的 [crtbegin.c](https://android.googlesource.com/platform/bionic/+/android-7.0.0_r1/libc/arch-common/bionic/crtbegin.c)及 [libc_init_dynamic.cpp](https://android.googlesource.com/platform/bionic/+/android-7.0.0_r1/libc/bionic/libc_init_dynamic.cpp)，原许可通知已保留在探针源文件和私有运行时 NOTICE 中。

## 7. 独立 App UID 与全禁网生命周期结果

已制作独立于主 App 的私有诊断 App/JS service，具有不同 App ID、`visible=false`、无脚本页面、无 UI 自动启动。第一关0.0.1只有带私有随机 nonce 的 `describe / runVersion / cancelVersion`；第二关0.0.2升级同一独立诊断 App，只提供 `describe / runOfflineInit / cancelOfflineInit`，并将刚才成功的 App UID5059版本记录及摘要作为硬门槛。没有任意命令、路径或 JSON 配置输入；拒绝 root、SDK prisoner、主 App UID或任意不同 UID。

服务仅在自己的 `0700 .state/runtime` 中校验并复制固定11个运行时文件，哈希必须与清单一致；不修改包目录或系统现有权限。child 环境不提供 HOME、NAS 凭据、SSAP key 或 nonce；使用固定工作目录、私有 TMPDIR 和动态库搜索目录。ELF 的相对 `./linker` 解释器已在真实 App UID5059 下通过。任何命名空间/规范路径不符都会停止，未放宽校验。

经逐包哈希审核后执行的两个独立关卡：

| 关卡 | 实际结果 | 严格范围 |
|---|---|---|
|私有0.0.1版本探针|App/child UID5059、exit0、20ms、限额/socket guard通过、SDK版本V3.0.0-2026102100|无init/start、无NAS凭据|
|私有0.0.2离线生命周期|App/child及全部native快照UID5059、exit0、24ms、init返回0/约2ms、release返回/约0ms|全socket/io_uring禁用，无start/无NAS凭据|

第二关 native RSS 约656KiB至2.8MiB，VmPeak约11MiB；线程从1变3，release/dlclose后的瞬时快照仍为3。外部25ms采样只观察到一次，因此不能用外部采样最大值替代 native 生命周期快照或精确峰值。这是受限离线生命周期结果，不是联网、P2P、吞吐或影片字节验收。

另外已恢复 Android provider 实际构造的初始化 JSON：`cloudServer.serverHost/serverPort`、AES256、日志级别2、日志上限128/延迟5/数量5、日志控制台false、上传周期120000及 App 私有日志路径。没有给未证实的日志/周期字段杜撰单位，也没有将“周期设为0”当成禁网保证。provider 真实代码将负数 init 返回标为失败；非负返回本身仍不证明任何网络链路。

独立无 NAS 凭据 `sdk_init → sdk_release` worker 在加载 SDK 前实施 CPU/地址空间/core/文件大小限额，禁止 socket 相关系统调用、io_uring、fork/新进程 clone 及 exec，仅允许线程 clone。两轮都有外部墙钟≤10秒、输出≤64KiB、CPU≤5秒、地址空间≤256MiB、core0；第二关增加每文件≤128KiB。文件限额不是整个目录配额。nonce/操作/manifest绑定的 one-shot 在服务重启后仍拒绝重放；不将其扩大成重装/更换状态目录后的抗重放保证。

原始版本、初始化结果及各包清单仅存 `.local/reference/p2p-native-diagnostic/`、`.local/reference/p2p-native-init-review/`。私有隐藏诊断不属于公开 App/IPK，主 App未因此获得可用连接 binding。两轮都是逐阶段另行审核执行，不构成后续联网授权。

受限 stdio 控制器也仅是离线准备，尚未连接真实 native worker：固定空参数操作、限长/限时帧、单操作在途、故障关闭；关闭确认必须同时有对应 release 返回和正常进程退出。已通过25项离线测试，包含真实 Linux 文件权限/哈希/限额启动器与 fake worker 的协议测试。这些测试没有执行 SDK，不能代替 App UID、初始化或 P2P 数据通道验收。

## 8. cloudServer 真实来源与生产接口

进一步读取同一 APK 的 classes4.dex 后，恢复了完整调用链：`DeviceConnect$p2pConnect$2` 调用 network manager `c.d()`，用混淆后的 HttpUrl `r4/c$b.h()`解析，再取 `r4/c.G()` 的 host、`r4/c.O()` 的有效 port，放入 `UgAgentP2pConfig`；provider `i.c()`转交 `i.i(host,port)`并序列化为 `UGBaseConfig.cloudServer`。

这个 APK 的 `manager/c.d()` 本身确实返回 `https://api.ugnas.com`，HttpUrl 对 HTTPS 的默认有效端口为443。它与同类中另一个读取 cluster domain 的 `b()` 方法不同，也不是 `glinfo.agent.configServerHost`。此前只把该地址作为离线实验覆盖使用；现在新增的直接字节码证据确认了它在此版本 TV 调用链中的来源，仍不能据此猜所有地区/后续官方版本的地址。

公共 `UgAgentDriver` 已移除内部硬编码主机，改为调用者明确提供 `baseConfig`；`createAgentBaseConfig({cloudApiOrigin,logPath})` 从已选择的可信 HTTPS 官方云 API 地址抽取 host/port，采用恢复出的 AES/日志/周期字段。无配置或夹带 NAS 凭据的配置会在 native init 前拒绝。未设置的 `clientType` 不再杜撰成TV。后续直接反汇编发现，尽管Java有null序列化分支，SDK本身仍拒绝缺失logPath；公共工厂现要求显式私有路径，保持logger写入权限与JSON参数有效性分开验证。

Bionic binding 的元数据也与 glibc 原生 binding 分开：要求 `isolated-process`、`single-session-worker`、真实ARM/Bionic API24运行时及独立连接 worker 协议。只有版本/离线 init 能力仍报 `NATIVE_ENGINE_CONNECT_NOT_READY`。当前尚未提供具备 authenticatedConnect 能力的生产 binding，不能从上述两次成功探针直接标记 P2P 可用。新增配置/ABI边界的15项 transport 测试均为 fake binding /离线测试。

## 9. 真实连接 worker 的准备与首个受限结果

已准备独立短命Bionic worker和只读验证器：NAS身份/token/publicRSA仅经一次stdin记录传入；SDK日志stdout/stderr丢弃、禁止文件写入和AF_UNIX日志出口；父进程死亡触发SIGKILL，限制CPU/内存/墙钟/输出；注册真实C回调，输出仅有限数字事件/端口。bind透传以保留正常出站连接，listen只允许loopback；固定SDK库的GOT只读核对必须证明此策略生效，实际选定端口还需要native fd及JS/proc的UID/inode检查。

安装目录不能作为普通服务写目录的假设已经被实机推翻：受控准备返回FS_EACCES。官方[JS Service Usage](https://webostv.developer.lge.com/develop/guides/js-service-usage)指定数据保存到/media/internal；新的固定App UID+manifest/nonce私有目录在C5 UID5059中完成了0700/0600/哈希检查和worker执行，没有修改旧目录或安装根权限。目录/文件在升级后观察到0775，只记录事实，未断言具体修改者。

首个真实连接实验在canonical HTTPS relay上通过同NAS握手及认证glinfo/priority_link后启动worker；native hello的PID/UID匹配，但进程内DNS适配返回有限代码9，exit3。因此尚未到SDK dlopen/init/start，本机认证/媒体请求也没有执行。worker已经退出，不能据此宣称P2P已连接。

随后从同API24[AOSP dlfcn.h](https://raw.githubusercontent.com/aosp-mirror/platform_bionic/android-7.0.0_r1/libc/include/dlfcn.h)确认32位Bionic的RTLD_DEFAULT为0xffffffff、NOW为0、GLOBAL为2，与glibc常用常量不同。DNS查找已准备改用显式libc句柄，并增加无地址/secret的数字子错误码；这项修复仍须独立实机验证。它不更改DNS服务器、网络权限或任何安全guard。

真实P2P验收仍须实际LINK_SELECT6/type4或5、同NAS实例/账号经选中通道认证、有限媒体字节，以及关闭/回退事实；type2、监听端口、源码或fake测试都不能替代它。跨公网/NAT与主App长期播放接入仍未完成。

后续0.0.7真实probe已通过进程内DNS配置及SDK/PG库加载后的GOT guard，再收到sdk_init=-1；尚未start/选路/读取本机媒体。SDK双ABI反汇编明确存在logPath缺失/非字符串的拒绝分支，与此前省略字段一致。已准备恢复固定已存在private cwd路径与maxSize128，同时维持文件写开全拒、FSIZE0及日志抑制；不是通过放宽文件权限让它成功。负init提前kill/drop后续release帧的父进程诊断错误亦已离线修复，真实关闭仍需下一轮分开记录。
