# 电视私有状态迁移

`service/index.mjs` 已在启动时依次调用 `checkWritable()`、`migrate()` 和
`DirectConnection.load()`。`lib/tv-state.mjs` 提供惰性 `createTvState`，默认新目录为：

```text
/media/internal/top.hrhome.nascinema.service.uid-<process.getuid()>
```

App ID固定，POSIX必须是当前UID，不能指定另一个UID。只创建这个最后一层私有子目录，
不创建或chmod `/media/internal` 本身、不修改安装根。新目录与所有状态操作复用
`private-state.mjs` 的canonical/无symlink/当前owner/regular+nlink1/FD锚定/0600约束。
baseDir/trustedBaseDir覆盖仅供本地临时fixture或另行验证的明确配置，不能来自API用户输入。

## 启动顺序

```js
const tvState = createTvState({legacyDir:join(__dirname,'.state')});
await tvState.checkWritable(); // 新私有子目录里写/读/fsync非secret nonce，再按版本删除。
await tvState.migrate();       // 显式调用才复制/清理旧凭据。
const control = new DirectConnection({dir:tvState.dir,config});
await control.load();
```

`prepare()`仅准备并检查私有子目录，`checkWritable()`使用固定storage-check格式，
不会复制旧凭据；构造工厂本身无IO。启动不通过其他路径静默覆盖、改变账号或重新登录。

迁移报告只含ready/complete/posixProtected及copied/removed/quarantined/retained计数，
没有token、内容或旧路径。新目录从工厂私有dir属性交给DirectConnection，不应把整个
内部存储对象发给普通API。

## 白名单和优先规则

正常状态只处理：session.json、device-id、clients.json、movie-preferences.json。
只识别旧Direct.save代码确有的 `session-<UUID>.tmp` 作为临时凭据，不将其当登录会话。
这些文件进入新目录的独立0700 quarantine，保留原始bytes（包括不完整/非UTF8片段），
校验后才删对应旧版本。未知文件、未知临时模式、子目录和内容不递归搬、不删、不改mode。

已经存在的有效新session优先，旧账号不会覆盖它。此时不读取或删除旧账号，旧副本
明确保留；集成时可先用mode helper收紧仍由本UID拥有的旧.state，再采用新state。
若新目录有不同的、不完整或无效状态，不覆盖它，报告冲突并保留两边。旧session
格式无效也不自动修复、截断或从tmp猜一个账号。

旧目录在参与迁移时必须通过owner、路径、symlink、hardlink等检查；不合格就拒绝，
不能用probe/installer/root身份替自有service修复其他UID。只有新目录已独立建立有效
会话而根选择优先使用它时，旧树才完全不被读取/采用，不能将此报告当旧副本已清理。

DirectConnection正式退出时保存的**空对象 `{}`** 是明确登出状态，也可按原bytes迁移。
它不符合活跃session定义，不会因此认证或恢复账号；device-id仍保留。仅Object.keys为空的
普通JSON对象接受为登出，null、数组、token:null及其他畸形非空对象不接受。新目录的{}
配合已complete的receipt会继续保持登录页，绝不从旧目录复活账号；没有对应receipt时，
不同旧账号与新{}之间仍按目标冲突拒绝覆盖。

## 崩溃重跑和删除条件

1. 先安全读取旧白名单、验证格式及所有新目标冲突；旧内容不转换、不改账号。
2. 私有state-migration.json记录app/UID、旧固定路径的hash、每个文件的hash/size和阶段，
   没有凭据或原路径。该receipt原子写入并fsync后才开始发布状态。
3. 单独stage/copy、原子写入、读取回验hash/size。身份与附属状态先发布，session最后发布。
4. 全部目的文件验证、fsync完成后，receipt进入copied。再次预检全部旧内容；发现来源
   已变化则先停止清理，全部旧文件保留。
5. 只按新鲜inode/mtime/ctime版本删除对应旧文件并fsync旧目录。版本变了就拒删，
   不覆盖未知替换。未知内容和旧目录本身始终留下。
6. 标complete。中断后，匹配receipt的已有目的文件直接验证并复用，不重复覆盖；
   缺失项补齐后继续清理。新目标已被独立换成另一个有效账号时，该账号优先，旧迁移
   不继续写入它。正常完成重复调用不再复制/删除。

文件系统不能提供跨多个文件的一次事务；因此中断可以留下已验证的新副本和尚未删的
旧副本，但任何旧文件删除前，对应目的完整副本都已安全写入、验证和fsync。改变内容、
inode或发生IO故障时宁可保留重复状态，不为追求“完成”丢旧会话。新helper内部备用副本
是独立inode，不会用hardlink破坏正常状态nlink1约束。

## 验证与明确未做的工作

```powershell
node --test test/tv-state.test.mjs test/private-state.test.mjs test/nas-public-rsa.test.mjs
```

迁移13项回归覆盖精确bytes、quarantine、未知内容保留、新会话优先、无效receipt、
目标冲突、部分copy/全部fsync后中断重跑、来源变化拒删、错owner/链接/路径以及媒体根
mode不变。真实WSL Linux与Windows语义测试均通过；Windows不冒充POSIX安全证明。
另包含明确{}登出、设备ID保持、complete receipt不复活旧账号及畸形对象拒绝。
相关Linux测试共46项、0 skip，含实际另一UID在0775时能读、修复后被拒的复现及
新增3项登出回归；Windows迁移/Direct/RSA相关27项也全部通过。

LG官方[JS Service Usage](https://webostv.developer.lge.com/develop/guides/js-service-usage)
建议服务数据在/media/internal，并描述固定jail UID隔离。把状态与安装目录分离有官方
方向依据；“以后升级不会再次改mode”仍是待实机验证的推断，不是文档承诺。
已在 C5 主应用真实服务 UID 验证新目录可写、按白名单迁移、原会话读回和主页加载；
随后升级到本地 0.4.0 候选包后，仍保留登录及主页访问。数据目录与安装目录分离，
但卸载、系统清理、开发者模式失效等情形仍可能需要重新登录。没有重新加密会话；
[Keymanager3](https://webostv.developer.lge.com/develop/references/keymanager3)
的TEE只列为后续独立方案，未生成key、未改ACG或旧会话格式。
