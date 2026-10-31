# 七文件 AOSP ARMv7 运行库构建准备

`assets/native-runtime-armv7/` 只包含已核对的七个未修改 AOSP 文件，以及完整关联 NOTICE 和原 provenance。没有 UGREEN/PeerGine 私有 SDK、APK、账号身份、5059 worker 数据或本项目生产 worker。

| 文件 | 字节数 |
| --- | ---: |
| linker | 621708 |
| libc.so | 771876 |
| libdl.so | 13708 |
| libm.so | 132780 |
| liblog.so | 63432 |
| libz.so | 91796 |
| libstdc++.so | 22116 |
| NOTICE.AOSP.txt | 345480 |
| AOSP-RUNTIME-PROVENANCE.json | 2832 |

七个二进制合计 1,717,416 bytes；本次全部九个文件合计 2,065,728 bytes。各二进制精确 SHA256 以 [provenance](../third-party/AOSP-RUNTIME-PROVENANCE.json) 为准。`NOTICE.AOSP.txt` 是 [已核对的完整关联文本](../third-party/AOSP-RUNTIME-NOTICES.txt) 的逐字节副本，SHA256 为 `4a6fc73769dee5ed3c2740633c19a2666161caca03bb56b2e3b56300bd33a0d5`，不是一行许可证摘要，也不是私有目录中 1,691,261 字节的全系统 NOTICE。

来源为 Google 的 Android API24 ARMv7 r07 系统镜像。实际关联通知包括 BSD 类/其他宽松条款、Apache 和 zlib 条款，详见 [原始审计说明](../third-party/AOSP-RUNTIME.md)。精确源码 manifest/tag 尚未证实：`android-7.0.0_r1` 只是审查基线，不能写成这批预编译文件的确切源代码版本或声称源码可逐字节重建。provenance 保留 `preciseSourceManifestVerified:false`。

## 验证已附文件

在仓库根目录运行：

```powershell
node tools/prepare-native-runtime.mjs --verify
```

不提供源目录时，工具只使用仓库内已附文件和 `third-party/` 的 NOTICE/provenance。缺少任何运行库会报 `NATIVE_RUNTIME_SOURCE_REQUIRED`，不会隐式下载约 284MB 镜像或请求私有 SDK。`--verify` 不填充缺失文件、不创建输出目录、不执行二进制。

## 从明确本机目录重新准备

```powershell
node tools/prepare-native-runtime.mjs --source-dir ".local/reference/p2p-native-runtime-armv7"
```

也支持显式环境变量：

```powershell
$env:CF_NATIVE_RUNTIME_SOURCE = "E:\path\to\approved-runtime"
node tools/prepare-native-runtime.mjs
```

工具只读取固定七个文件名，不复制整个目录；源目录即使含私有 SDK/APK/worker/身份数据也不会被读取或复制。先校验全部七份源的大小与 SHA256，随后仅发布缺失的目标文件；复制后再校验全部九个目标。已有损坏目标不会被覆盖，目标内存在白名单之外文件会拒绝，不会自动删除。源目录及文件不 chmod、不移动，读取前后权限保持。

只接受文件系统路径，不接受 HTTP/file URL，没有 `--manifest`、`--sha256`、`--out-dir` 或下载选项。文件/目录 symlink、junction，以及已有目标的 hardlink 均拒绝；不能借输出路径指向别处。每份输出先写自身独占临时文件、fsync、核对哈希，再无覆盖发布；临时文件只逐个清理，没有递归删除/移动。I/O 中断可留下已完整发布的部分文件，重新指定同一正确源目录即可补齐。

## 打包集成合同

```js
import {prepareNativeRuntime} from './prepare-native-runtime.mjs';

const runtime = await prepareNativeRuntime();
// runtime.directory：已验证的绝对目录，非枚举，JSON报告不会包含本机路径。
// runtime.files：固定九个允许打包的文件及大小/SHA256。
```

目前没有修改 `package-tv`、service 或 `build-assets` 入口。Root 后续应等待 prepare 完成，再按其固定清单复制到 staging，并保留完整 NOTICE/provenance；不要直接打包 `.local/reference/`。新复制的 linker 在 POSIX 上以 0755 创建，其他文件以 0644 创建；跨平台 Git checkout/打包时应只对 staging 中的 linker 确保可执行模式，不修改研究源目录权限。

`ready:true` 表示这批构建资产的大小/哈希完整性通过，**不表示生产 worker 已提供、私有 SDK 已可分发、C5 上可运行或 P2P 功能验收成功**。工具不部署、不执行 linker/so，也没有实际网络请求。

## 回归

```powershell
node --test test/prepare-native-runtime.test.mjs
```

17 项细分检查包含：固定七文件与完整通知、前后哈希、缺源离线拒绝、先校验后复制、拒绝损坏目标、未知 manifest 路径、junction/hardlink、未知目标文件、只补缺失文件、verify 无写入、生产 CLI 不允许 pin/manifest/output 覆盖，以及 `CF_NATIVE_RUNTIME_SOURCE` 仍受生产哈希约束。小型合成 manifest 只由 Node 测试进程的 `_nativeRuntimeTesting` 内部辅助入口使用；生产 API/CLI 不接收该入口的 manifest、目标路径或 pins。

本次实际复制验证了七份源及九份目标，随后离线 `--verify` 全过，并比对源目录和七文件的 Windows ACL，前后未改变；没有执行任何二进制。
