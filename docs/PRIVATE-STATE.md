# 自有私有状态权限修复

`lib/private-state.mjs` 只处理调用者绑定的绝对固定目录及明确文件白名单。
默认白名单为 `session.json`、`device-id`，目录0700、文件0600。
不递归chmod、不修改父安装目录、/root/系统树或未知子树、不改owner，不读取电视凭据内容。

根的启动接线可显式绑定：

```js
const dir = join(__dirname, '.state');
const privateState = createPrivateState({dir, trustedDir:dir});
const permissionReport = await privateState.repair();
const control = new DirectConnection({dir, config, privateState});
await control.load();
```

DirectConnection默认也创建同一边界；load先repair并安全读取两份状态，安全拒绝不能
被当作首次启动吞掉，不会接着覆盖device-id。两份读取完成后才应用账号config；普通
缺文件/小型格式错误继续原来的首次启动或ID恢复行为。save和device-id写入使用相同
私有原子发布流程，session格式和nasPublicRsa原字符串合同不变。

## POSIX / Linux 约束

目标必须与trustedDir相同，绝对路径无点段/多余分隔形式、canonical路径一致，所有
路径分量不是symlink。根、系统树、用户home、当前工作目录、安装根`.service`拒绝。
只创建最后一层；不会顺带创建/修复未知父目录。目标目录必须是当前UID所有的真实目录。

目录用O_NOFOLLOW/O_DIRECTORY/O_NONBLOCK打开，lstat/fstat inode相同后才fchmod。
持有目录FD，并用`/proc/self/fd/<fd>/leaf`（或可用的/dev/fd）锚定后续文件操作；
没有这个能力则报PRIVATE_STATE_CAPABILITY，不退回假称安全的纯路径操作。
每次操作前后重核原canonical路径和目录inode；观察到替换则拒绝。

文件必须是普通文件、不是symlink、nlink=1、owner=currentUID；用O_NOFOLLOW和
O_NONBLOCK打开并核lstat/fstat。Fchmod只作用于已经确认的FD，随后重核路径inode和
完整权限位（含special bits），读取采用有界FD read并重核size/mtime/ctime，默认最多128KiB。
元数据/权限错误使用安全PrivateStateError，不含文件内容或原始路径。

这在Linux上把文件IO锚在已经打开的原目录，避免父目录被改名后跟到另一个树；普通
Node API仍没有原子“比较inode再unlink”的syscall。文件名操作使用观测重核和进程内
串行锁；不声称抵抗已控制同UID或root的并发任意修改。独立UID在目录0700后无权遍历。

## 原子写入和回滚

新临时文件独占创建、验证owner/type/nlink、fchmod0600、写入和fsync，最后检查旧
目标版本再rename。现有状态通过同一已验证FD有界读取成**独立0600 inode**备用副本，
不创建hardlink，避免进程中断留下nlink=2导致以后拒绝正常会话。

发布后验证新inode/mode并fsync目录才成功；失败且目标仍属于本次发布时，用私有
备用副本原子恢复原内容。如果检测到目标已经被换成未知inode，绝不覆盖它，保留
原内容的私有备用副本，向调用者报告失败。只清理当前操作确定持有的临时inode；
中断留下的其他文件不被glob删除。Direct commit失败沿原规则恢复内存账号，旧内容
也得到上述保留；正常写入没有会话缺失窗口。

迁移可复用 `readVersioned(name,{encoding:'buffer'})` 返回原始bytes和inode/时间版本，
以及 `remove(name,version)`：源已变化则拒绝删除。`names()`仅列固定目录的文件名供
严格白名单筛选，不递归、不自动读未知内容。原子更新也串行；跨进程的同UID写者不在
应用层互斥承诺内。

## Windows

Windows执行固定路径/白名单、regular file、hardlink和inode重核、有界IO和原子替换
语义；因为没有当前POSIX UID及相同的O_NOFOLLOW/目录FD/mode机制，返回
`posixProtected:false`、mode:null，不chmod伪装成POSIX权限，也不声称建立ACL保护。

## 验证与设备边界

真实WSL Linux原生fs验证包括0775修复、其他UID在修复前可读/修复后被拒、symlink、
hardlink、错owner、FIFO换入、目录/文件替换、锚定、原子失败和原内容回滚。
Windows将真正POSIX用例明确skip，仍测合法读写、链接拒绝、替换检测及Direct兼容。
独立复审确认并修复了中断hardlink备用造成nlink=2的回归。

```powershell
node --test test/private-state.test.mjs test/direct.test.mjs test/nas-public-rsa.test.mjs test/ugreenlink.test.mjs test/ugos.test.mjs
```

原生agent只读元数据确认当前安装的.state/session/device-id为0775、owner5567；
另一个probe UID验证了/proc/self/fd可用，不能冒充main UID已验。根仍需新包在main
实际UID下验证load/save后的inode、owner、0700/0600及账户保持；本模块没有登入、
读取真实电视文件内容、切换输入或部署，也没有归因权限被谁改宽。

## 官方路径和Keymanager后续建议

LG的[JS Service Usage](https://webostv.developer.lge.com/develop/guides/js-service-usage)
描述service jail的固定UID隔离，并建议服务数据存放到/media/internal。把账号状态放在
独立于安装根的本App/UID目录，是可验证的后续迁移方向；该文没有承诺任意目录永远
不被升级/卸载改变，必须检查真实写入、应用升级和账号读回再正式切换，不能在本补丁
里直接搬旧会话或改共享媒体目录权限。

官方[Keymanager3](https://webostv.developer.lge.com/develop/references/keymanager3)
从webOS TV24提供TEE保护，生成的key归创建应用使用，支持AES等操作，emulator不
支持。它是后续加密token的候选，尚未验证本App/service可调用性、同App跨升级key
存续或真实设备恢复路径；页面没有给出这些升级保证。实现前需独立验证调用身份、
IV/AAD管理和begin后的finish/abort生命周期。当前只修POSIX file modes，不生成key、
不迁移加密格式、不改ACG、不用软件内硬编码key声称TEE保护。
