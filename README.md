# 云映 · UGreen For WebOS

在 LG 电视上使用绿联 NAS 的影视中心和相册：海报墙、影片资料、收藏、继续观看、照片浏览和幻灯片。

**v0.3.0 支持 UGREENlink 直接登录，NAS 不需要安装 Docker 容器。** 输入 UGREENlink ID 和 NAS 用户名、密码，或用手机「绿联云」App 扫码确认。

**[下载安装包](https://github.com/zhr2038/UGreen-For-WebOS/releases/tag/v0.3.0) · [安装到另一台 LG 电视](#second-tv) · [登录说明](#login) · [旧版 NAS 服务教程](docs/LEGACY-BRIDGE.md)**

个人使用的非官方客户端，与绿联、LG 没有官方合作关系。项目使用未公开 UGOS 接口，固件或手机 App 升级后可能需要适配。

## 现在需要安装什么

| 设备 | 需要做的事 |
| --- | --- |
| 每台 LG 电视 | 开启 Developer Mode，安装一个 `.ipk` |
| 绿联 NAS | 开启 UGREENlink；已有影视中心和相册索引即可 |
| 手机 | 选择扫码登录时，用绿联云 App 扫码确认 |
| 电脑 | 用于安装；平时播放时可以关机 |

与 0.2.x 不同，登录、接口访问、海报缓存、视频转发和播放记录同步都由电视 App 随附的 JS 服务完成。**无需 NAS 兼容服务地址，也无需六位 NAS 配对码。**

当前直连实现走绿联官方的 **UGREENlink HTTPS 中继**。电视和 NAS 可以不在同一局域网，无需在路由器上手动映射 8780 端口。本项目没有部署自己的公网中继，也没有实现官方客户端的原生 P2P 加速；远程原画播放的流畅度取决于带宽和绿联中继能力。

<a id="second-tv"></a>
## 给另一台 LG 电视安装

### 1. 下载电视安装包

在电脑打开 [v0.3.0 下载页](https://github.com/zhr2038/UGreen-For-WebOS/releases/tag/v0.3.0)，下载：

```text
CloudFrame.ipk
```

安装包文件名为 **CloudFrame.ipk**，电视首页的中文应用名为 **云映**。使用 UGREENlink 登录时不需要下载服务端 ZIP，也不需要编译源码。

已实机验证 LG C5（OLED42C5PCA.ACNQLJD，固件 43.21.96、webOS SDK 11.2.0、Node.js 20.12.2）。直连服务以 Node.js 16 为最低构建目标，建议 webOS 24 及以上；其他型号尚未逐台验证。旧电视可尝试[旧版兼容服务模式](docs/LEGACY-BRIDGE.md)。本项目不是 Android APK，不支持 NetCast 电视。

### 2. 在电视开启 Developer Mode

使用电视遥控器操作：

1. 按 **Home / 主页**，进入电视的 **Apps / 应用商店**。
2. 搜索并安装 LG 提供的 **Developer Mode**。
3. 打开 Developer Mode，使用自己的 [LG 开发者账号](https://webostv.developer.lge.com/login)登录。
4. 打开 **Dev Mode Status**，按提示选择 **Restart** 重启电视。
5. 重启后再次打开 Developer Mode，打开 **Key Server**。
6. 记下页面上的 **IP Address** 和 **Passphrase**，后面连接电视时使用。

Passphrase 区分大小写。安装时电脑与电视需要能通过局域网互相访问。可对照 [LG 官方图文教程](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)。

### 3. 用 webOS Dev Manager 安装

1. 在电脑下载并打开 [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop/releases/latest)。Windows 用户选择适合自己电脑的安装包。
2. 添加电视：地址填写上一步的电视 IP；用户名为 **prisoner**，SSH 端口为 **9922**。
3. 按软件引导获取开发密钥，输入电视 Developer Mode 页显示的 **Passphrase**。
4. 连接成功后进入 **Apps**，点击 **Install**，选择下载好的 `.ipk` 文件。
5. 安装完成后在电视主页打开 **云映**。

安装包已经包含电视端通信服务，不需要另装一个服务包。同一台 NAS 的第二台电视也是以上步骤，然后单独登录。

偏好命令行的用户可使用 [官方 CLI 安装方式](docs/CLI-INSTALL.md)。

### 4. 保持开发者模式有效

开发者模式有剩余时间限制，请在到期前续期。可在 Developer Mode 内延长，或使用 Dev Manager 提供的续期功能。续期方式以当前版本界面为准；开发者模式失效可能导致侧载 App 无法使用，需要重新开启并安装。

<a id="login"></a>
## 登录绿联 NAS

先确认 NAS 的 **控制面板 → 设备连接 → UGREENlink 远程访问** 已开启，并记下 UGREENlink ID。官方说明：[UGREENlink 远程访问](https://support.ugnas.com/detail/article/zh-CN/86)。

### 账号密码登录

在云映选择 **账号密码**，填写：

- **UGREENlink ID**：例如 `myNAS123`；也接受 `https://ug.link/myNAS123`。
- **NAS 用户名、密码**：NAS 上创建的本地账号。

点击 **登录**。这里使用 NAS 账号；LG 开发者账号用于安装，绿联云手机号账号用于手机云服务，三者用途不同。

### 手机扫码登录

1. 在电视云映选择 **扫码登录**。
2. 打开手机 **绿联云** App，使用它的 **扫一扫** 扫描电视上当前显示的二维码。
3. 在手机选择需要连接的 NAS，并确认登录。
4. 电视自动进入影视中心。

扫码与手机确认是两个状态；看到“已扫码，请在手机上确认登录”时，继续在手机完成确认。二维码过期后使用 **刷新二维码**。若手机已经确认但网络交接失败，可先选择 **重试登录**。

登录确认查询由电视后台服务负责，暂时切换输入源不会仅因网页计时器暂停而丢失确认。退出 App 或取消扫码会取消当前流程。

NAS 密码不会保存；登录会话保存在电视自己的服务目录。扫码使用临时 RSA 密钥解密手机授权的会话，项目不保存绿联云的云账号访问令牌。卸载 App、清除数据或部分安装环境中的更新操作可能需要重新登录。

## 功能与遥控器

- **影视**：首页、海报墙、媒体库、电影 / 电视剧、搜索、详情、收藏、最近播放、续播、选集 / 版本及播放记录同步。
- **播放按钮区**：左右键移动焦点；上键进入进度条，再用左右键快退 / 快进 10 秒；下键返回按钮区。控制栏隐藏时，左右键可直接快退 / 快进。
- **相册**：时间线、已有相册、已有收藏、照片 / 视频筛选、排序；全屏左右翻页、旋转、放大、幻灯片。相册仅浏览，不上传、删除或重建 NAS 照片库。
- **内存控制**：电视端缓存上限 24 MiB，限制同时读取图片的数量，并释放离开可视区域的海报。相册使用 NAS 生成的预览图。

当前为 **原画直放**，没有实时转码、独立内嵌字幕提取或外挂字幕加载。音视频编码、DTS / TrueHD、杜比视界 Profile 和高码率兼容性仍由电视决定；UGREENlink 登录成功也不等于任意 4K 原画都能流畅播放。

## 从 0.2.x 升级

安装新版 `.ipk` 后，默认提供 UGREENlink 登录。如果之前选择过旧版模式，可以在连接设置中选择 **使用 UGREENlink 直接登录**。

NAS 上原来的 `lg-nas-cinema` 容器可以先保留，供仍使用旧版的电视连接；新版 UGREENlink 模式不使用它。确认家中电视均已切换直连后，再按自己的需要停用旧服务。

**使用旧版 NAS 服务** 入口保留原来的服务地址＋六位配对码方式。相关部署、端口、证书和配对教程见 [旧版指南](docs/LEGACY-BRIDGE.md)。

## 常见问题

**UGREENlink ID 无法连接？**

确认 ID 拼写正确、NAS 在线且已开启远程访问。可以先在手机绿联云中通过相同 ID 连接。电视和 NAS 都需要能访问绿联服务。

**扫码后没有进入影视中心？**

确认手机已经完成 NAS 选择和登录确认，使用的是当前二维码。已扫码但未确认时不会登录。网络交接失败先重试；过期或取消后刷新二维码。

**出现 NAS 登录过期？**

进入连接设置重新登录。NAS 重启、会话撤销、账号权限变化和系统登录策略可能使已有会话失效。

**能浏览但播放失败、无声或远程卡顿？**

先尝试 H.264 / AVC＋AAC 的普通 MP4。原画播放不改变编码，也不降低码率；远程中继带宽不足或电视不支持音轨 / 封装时，本项目不会自动转码补救。

**电视也是电脑显示器，测试会遮住电脑吗？**

开发调试可以从电脑连接电视后台服务，登录和接口验证无需切换输入源。实际电视画面、声音及遥控器验证仍需要打开电视 App。LG 多画面有应用组合和高刷新率限制，不能保证 HDMI 与侧载 App 可同时显示。

## 开发与验证

```powershell
npm ci
npm test
npm run test:ui
npm run package:tv
```

`package:tv` 会构建二维码资源和电视 JS 服务，并将二者与界面一起打入 `dist` 的 `.ipk`。服务使用纯 JavaScript 和 Node 核心模块，不携带 `sharp` 或其他 C/C++ 扩展，也不需要 root 电视。

服务测试、模拟界面测试与真实电视验证的范围见 [v0.3.0 变更与验证记录](docs/CHANGELOG-0.3.0.md)。界面设计见 [Figma](https://www.figma.com/design/CcZn2Sp9cpxc9JPf1eNoZV?node-id=14-51)。

旧版可选 Docker 服务仍保留源码，供兼容模式使用。开发调试脚本、原始 Android APK、个人 NAS 地址、账号密码、会话、电视开发密钥和照片均不应提交到仓库或打进发布包。
