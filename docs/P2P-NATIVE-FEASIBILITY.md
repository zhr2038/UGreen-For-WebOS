# C5 原生 SDK 个人用适配：可复现实验与具体缺件

## 已经实际证明的范围

**官方 Android SDK 的 ARMv7 原生库，已经在真实 LG C5 内核上通过私有 Bionic 运行时完成受限加载、版本读取及 C 符号查找。** 没有使用 QEMU，也没有把 Android Bionic 库当成 glibc 加载。

这不等于 SDK 初始化成功，更不等于 P2P 穿透、加速或影片传输已成功。唯一获准执行的探针没有调用 `sdk_init`、`sdk_start_agent`、`sdk_start_agentP2P`，没有接收 NAS token / 账号 / SSAP key，也没有切换电视画面。

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
| `sdk_release` | 无输入 | 释放 SDK 全局状态；尚未调用 |

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
- 从原始 ext4 `system.img` 只读提取 `bin/linker` 与 `libc/libdl/libm/liblog/libz/libstdc++`，没有挂载或修改电视 / NAS 系统。
- AOSP `NOTICE.txt` 随私有运行时保留；SDK 库仅从用户已有的官方 APK 导入，未进入公开仓库或发布包。

交叉编译的 `tools/p2p-native-probe.c` 是独立 ARM32 PIE。采用 `-nostdlib` 和显式 Bionic `libc.so / libdl.so`，没有链接宿主 glibc 或 musl。编译目标字符串虽采用 ARM EABI 编译配置，但实际动态依赖完全由 ELF `NEEDED` 和私有 Android linker 决定。

静态闭包检查：552 个强动态导入均可在 SDK 与该 Bionic 运行时中找到定义；13 项符号版本要求也均存在。仅剩 3 个 OpenSSL 可选弱钩子未定义。**静态闭包本身不是执行证据**，实机加载结果单独记录如下。

## 3. 唯一一次获准的 C5 版本探针

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

版本探针已经消除了“C5 内核完全不能执行该 Android 核心”的猜测，下一步的缺件更具体：

1. **真实 App UID 执行验证。** 目前只证明 `prisoner` 上下文。App 的文件标签、可执行权限、工作目录、私有运行时位置和 child-process 启动仍需逐项验证，不能借 SSH 的结果冒充 App 沙箱通过。
2. **受限 SDK 初始化 / 关闭。** 应先无 NAS 凭据、保持禁止网络的 `sdk_init`→`sdk_release`，验证线程、资源和退出；若因 socket guard 导致失败，应区别于 ABI 失败。未经再次确认，不执行这一关。
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

## 7. 后续关卡已离线准备，尚未执行

已制作一个完全独立的私有诊断 App/JS service，具有不同 App ID、`visible=false`、无脚本页面、无 UI 自动启动。只有带私有随机 nonce 的 `describe / runVersion / cancelVersion` 方法；没有任意命令、路径、JSON 配置或 SDK 初始化入口。它拒绝 root、SDK prisoner 和已知主 App UID，要求诊断服务属于自身 App UID。

服务仅在自己的 `0700 .state/runtime` 中校验并复制固定 11 个运行时文件，哈希必须与清单一致；不修改包目录或系统现有权限。唯一 native worker 与上面已审版本探针的二进制哈希一致。child 环境不提供 HOME、NAS 凭据、SSAP key 或 nonce；使用固定工作目录、私有 TMPDIR 和动态库搜索目录。ELF 的相对 `./linker` 解释器已静态核对，但**仍未在真实 App UID 下执行**。任何命名空间/规范路径不符都会停止，未因推测合法系统符号链接而放宽校验。

另外已恢复 Android provider 实际构造的初始化 JSON：`cloudServer.serverHost/serverPort`、AES256、日志级别2、日志上限128/延迟5/数量5、日志控制台false、上传周期120000及 App 私有日志路径。没有给未证实的日志/周期字段杜撰单位，也没有将“周期设为0”当成禁网保证。provider 真实代码将负数 init 返回标为失败；非负返回本身仍不证明任何网络链路。

独立的无 NAS 凭据 `sdk_init → sdk_release` worker 已完成 ARM32 PIE/Bionic 交叉编译，仅存私有目录，不在诊断 IPK 内。它在加载 SDK 前实施 CPU/地址空间/core/文件大小限额，禁止 socket 相关系统调用、io_uring、fork/新进程 clone 及 exec，仅允许线程 clone；记录调用时间及自身 UID、线程、RSS、VmPeak。**未执行 init/release**，还需要单独审核和受监督的实机执行步骤。

受限 stdio 控制器也仅是离线准备，尚未连接真实 native worker：固定空参数操作、限长/限时帧、单操作在途、故障关闭；关闭确认必须同时有对应 release 返回和正常进程退出。已通过25项离线测试，包含真实 Linux 文件权限/哈希/限额启动器与 fake worker 的协议测试。这些测试没有执行 SDK，不能代替 App UID、初始化或 P2P 数据通道验收。
