# 本机官方SDK按需准备

`lib/native-provision.mjs` 只准备固定官方版本的两个ARMv7库，不加载或执行它们，不收NAS
token/public_key，不改变电视或用户数据。没有SDK二进制进入Git或IPK；首次实际prepare
由根在用户设备本机调用。本次只运行合成ZIP/mock HTTPS和私有临时目录测试，没有向
UGREEN下载端点下载真实SDK。

```js
const provision = createNativeProvision({
  dir:join(privateAppDir,'native-sdk'),
  trustedDir:join(privateAppDir,'native-sdk'),
});
const result = await provision.prepare({signal});
const {ugAgent,pgTunnel} = result.paths; // 仅内部binding读取。
const publicStatus = provision.status(); // 只有ready及数字/布尔指标。
provision.cancel(); // 取消本实例订阅；另一个等待者仍可继续。
provision.dispose();
```

factory惰性，没有自动网络或目录IO。dir必须是固定可信私有目录的native-sdk子目录；
复用private-state的canonical/当前UID/0700、普通文件nlink1/0600、O_NOFOLLOW/目录FD
锚定，禁止安装根或系统目录。结果paths不可枚举，JSON响应不含本机路径；status没有
下载URL、文件名、NAS身份或匿名签名字段。不要把第二个内部测试依赖参数接到HTTP/Luna。

## 固定来源及校验

- 唯一metadata：`https://api-zh.ugnas.com/api/system/v1/ua/temp/link?appType=client&id=657`。
- 只消费实际已见的 `code/data.linkData.tempUrl`，HTTPS、无userinfo/hash、固定
  `dl-cn.ugnas.com/appVer/android/4421/Tv121044211027cir.apk`。
- query只准timestamp/signature各一个；只留本次内存，不硬编码或发布实际签名值。
- APK总长135984880；原本地完整APK参考MD5为9a6a6091c710073d4910c4edbce2b7aa，
  SHA256为f7888f6bb170d4725943a7bb5d95839459d45bfba63544516332c3c7a733f28a。

| entry | local header offset / bytes | payload bytes | SHA-256 |
| --- | --- | ---: | --- |
| lib/armeabi-v7a/libugagentsdk.so | 86667404 / 3956 | 4060832 | ff124cd20c40c0b8f462615214f9ab2c7087b09dac8fb70be95238969ba45fc0 |
| lib/armeabi-v7a/libpgJniTunnel.so | 85355440 / 5200 | 1306764 | cb951e736079ad5f8cf5d30732ae2659ae2fc9ecda1c1040c37a3702ebb9c0b9 |

已从现有本地APK只读核出header SHA分别为
90b76ce4ebc4be237c3fd988b0bb1e70d69c9917fb788d091df827cfd3429332及
5eb69635884d70d0caa0a44a789f6c98dabfff0e8ab28b1c7c041c920bd9bdc0。
两个实际entry都是stored(method0)，数据分别在86671360、85360640；额外实现method8
inflateRaw的硬maxOutputLength及精确长度/SHA校验，供重新审核的pin使用。

只做metadata和两条固定Range（缺哪个只取哪个）。每条必须206、精确Content-Range
起止与总长、精确Content-Length、identity编码、强ETag等于原APK MD5，并发送同值
If-Match。重定向、200整包、压缩响应、缺/弱/变化ETag、长度/header/库hash变化都拒绝，
没有130MB整包fallback。根线程随后只读调用官方metadata及GET Range0-0，实测206、
Content-Range `bytes 0-0/135984880`、Content-Length1、无Content-Encoding，强ETag为
`"9A6A6091C710073D4910C4EDBCE2B7AA"`，CDN接受本模块的小写If-Match。此证据确认
了对象范围/长度及ETag兼容性，只读取1byte APK头；没有下载两库或重新验证整APK/SDK hash。

Range提取没有重算整APK SHA256；本实现检查可信HTTPS对象的已pin强ETag/总长及选定
header/两库SHA，不把参考整包SHA写成“当前已全包验算”。库或ZIP布局改动需重新审核
并更新代码中的immutable pins，不能通过用户URL或所谓“最新版本”自动绕过。

## 资源、并发和落盘

metadata最多64KiB，每条Range/解压大小由固定pin限定（pin硬上限8MiB）。读取过程中
计数超限会销毁响应，inflateRaw超出输出上限立即失败。默认全任务60秒、最大120秒，
独立请求超时，AbortSignal也能结束停在headers/body的请求；迟到响应会关闭。外层
deadline即使在原生文件IO未settle时也返回超时，active会如实保持到清理结束，期间
不另起并发任务。每个
目录单flight，多个调用者共用准备，只有全部订阅者取消才终止共享任务。

先校验所有已有库。内容损坏、错误owner/link/type等直接拒绝，不覆盖或偷换；完整缓存
不访问网络。新临时文件独占创建、0600、写入和fsync后用不覆盖目标的link进行原子
发布，随后立即移除自有临时名、复验SHA/nlink和fsync目录。遇到并发新目标先验证，
损坏目标保留并报错。取消只清当前拥有的临时inode；已经完整验证的缓存可以保留。

若进程恰在link与临时名移除之间被杀，留下多link缓存会被下一次严格检查拒绝，不会
自动删除未知别名或修补内容。它是可重新获取的SDK缓存，不是唯一用户会话；后续
显式修复/清缓存UI可以另行处理，当前没有偷偷重新下载覆盖的流程。

返回ready仅表示选定SDK文件已准备，不能当SDK握手、代理端口、P2P、authenticated-byte
验证或速度改善证据。后续binding仍须按自己的manifest/ABI及实际网络门禁验证。

## 公开AOSP运行时

7个候选公开运行时、实际匹配NOTICE和来源链见
[AOSP运行时审查](../third-party/AOSP-RUNTIME.md)及
[provenance](../third-party/AOSP-RUNTIME-PROVENANCE.json)。本模块没有复制这些二进制；
它们与本机提取的两份UGREEN/PeerGine SDK库分开处理。

## 测试

```powershell
node --test test/native-provision.test.mjs
```

14项测试使用合成header/ZIP、真实inflateRaw和内部mock HTTPS，覆盖固定来源/Range、
错误响应、zip/库hash、压缩炸弹、缓存与损坏不覆盖、4MiB真实私有IO、单flight、取消、
超时、迟到响应、文件写中止以及链接边界。WSL Linux与private-state相关共32项、0skip；
Windows上述14项也全过，但Windows数据语义不等于POSIX mode/UID保护。未下载真实SDK，
没有电视操作、NAS身份输入或SDK执行。
