# UGreen For WebOS

在 LG 电视上浏览和播放绿联 NAS「影视中心」里的电影、电视剧，沿用已有海报、影片资料、收藏和观看进度，并浏览 NAS 现有相册。

**当前发布版 v0.2.1：影视＋相册，修复遥控器导航与播放生命周期问题。** 相册功能需要电视 App 与 NAS 兼容服务均至少为 0.2.0；已有 0.2.0 NAS 服务时，第二台电视只需安装 App 并配对。

### 相册功能（0.2.0）

- 左侧导航进入「相册」，可切换照片时间线、已有相册、喜欢的照片，按照片 / 视频筛选，以及拍摄时间、添加时间排序。
- 每页 48 项；全屏左右切换可跨页读取。下键进入操作栏，返回恢复照片列表并保留当前照片焦点。
- 照片可旋转、放大，并以 5 / 10 / 15 秒间隔播放幻灯片；图片加载后才开始计时，视频结束后继续。加载失败停止，切换到后台暂停。
- 读取 NAS 现有相册索引，不上传、删除或重建照片库。「喜欢」仅浏览已有收藏；实况照片显示静态画面。
- NAS 预览图转换为最多 1920×1080 的 WebP，最多两张图片并行处理，缓存上限 24 MiB。视频原画直放，编码兼容性取决于电视；尚未提供原图 4K、AI 人物 / 地点分类、相册编辑或背景音乐。
- 本地安装包：`dist/top.hrhome.nascinema_0.2.1_all.ipk`；服务端包：`dist/lg-nas-cinema-server-v0.2.1.zip`。

**[下载安装包](https://github.com/zhr2038/UGreen-For-WebOS/releases/latest) · [第二台电视安装教程](#second-tv) · [首次部署 NAS](#nas-setup) · [常见问题](#faq)**

个人使用的非官方客户端，与绿联、LG 没有官方合作关系。当前为**原画直放**，尚未实现实时转码、独立的内嵌字幕提取或外挂字幕加载。

## 先看这里

| 部分 | 安装位置 | 作用 |
| --- | --- | --- |
| 云影视 `.ipk` | 每台 LG 电视 | 海报墙、选片、播放、相册和遥控器操作 |
| NAS 兼容服务 | 绿联 NAS，部署一次 | 连接原影视中心、提供封面和视频、同步播放记录 |

**如果第一台电视已经能用同一台 NAS，第二台只需安装电视 App 并重新配对，无需再部署 NAS 服务。**

电脑只在安装时使用，平时看电影不用开机。电视、NAS 和 NAS 兼容服务需要运行，并能在局域网中互相访问；项目没有外网中继。

已实机验证 LG C5（OLED42C5PCA.ACNQLJD，固件 43.21.96、webOS SDK 11.2.0）。其他 webOS 型号尚未逐一验证，老版本不能保证兼容。这不是 Android APK，也不适用于 NetCast 电视。

<a id="second-tv"></a>
## A. 给第二台电视安装——已有 NAS 服务

### 1. 下载电视安装包，确认 NAS 地址

在电脑打开 [Releases](https://github.com/zhr2038/UGreen-For-WebOS/releases/latest)，下载：

```text
top.hrhome.nascinema_0.2.1_all.ipk
```

直接下载 .ipk 即可，不需要编译，也不需要下载源码。

找到你的 NAS 局域网 IP。后文的 **NAS_IP 都要替换成真实地址**，例如 192.168.1.100。在电脑浏览器先访问：

```text
http://NAS_IP:8780/health
```

看到类似下面的内容，表示服务可以连接：

```json
{"ok":true,"name":"LG NAS Cinema","version":"0.2.1"}
```

旧版 0.1.0 / 0.1.1 服务可继续提供影视功能；相册需要升级到 0.2.0 服务。访问失败时先看[连接问题](#faq)；尚未部署服务则先完成 [B 部分](#nas-setup)。

### 2. 在第二台电视开启 Developer Mode

使用**电视遥控器**进入电视自己的主页：

1. 按 **Home/主页**，打开电视的 **Apps/应用商店**。
2. 搜索 **Developer Mode**，安装 LG 提供的这个应用。
3. 打开它，登录你自己的 **LG 开发者账号**。账号入口：[LG webOS 开发者网站](https://webostv.developer.lge.com/login)。
4. 打开 **Dev Mode Status**。出现重启提示时选择 **Restart**，等电视重启。
5. 重启后再次打开 Developer Mode，打开 **Key Server**。
6. 保持该页面打开，记下 **IP Address** 和 **Passphrase**。

Passphrase 区分大小写。电脑和电视要在可以互通的网络中。也可对照 [LG 官方图文教程](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)。

### 3. 用电脑上的图形工具安装（推荐）

1. 打开 [webOS Dev Manager 下载页](https://github.com/webosbrew/dev-manager-desktop/releases/latest)。
2. Windows 64 位电脑下载名称类似 **webOS.Dev.Manager_版本号_x64_en-US.msi** 的安装程序；macOS 下载 .dmg。
3. 安装并打开 webOS Dev Manager，选择添加设备，连接方式选择 **Developer Mode**。
4. 按提示填写：

| 字段 | 内容 |
| --- | --- |
| 设备名称 | 自己起名，例如“客厅 LG” |
| IP / Host | **第二台电视** Developer Mode 页面上的 IP |
| SSH 端口（如果询问） | 9922 |
| SSH 用户名（如果询问） | prisoner |
| Passphrase | **第二台电视**页面上的 Passphrase |

5. 连接后进入 **Apps/应用**页面，点击 **Install/安装**。
6. 选择刚下载的 .ipk，等待安装成功。
7. 在列表中找到 **云影视**，点击 **Launch/启动**。以后从电视 Home 主页打开即可。

工具不同版本的按钮名称可能略有变化，项目说明见 [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop)。它不要求安装 LG SDK。也可使用[命令行安装方法](docs/CLI-INSTALL.md)。

### 4. 从 NAS 获取配对码

这是连接 NAS 的**六位数字码**，与电视 Developer Mode 的 Passphrase 不同。

在 NAS 的 Docker 应用找到 **lg-nas-cinema** 容器，打开容器终端，选择 **/bin/sh**。

**NAS 服务是 0.1.1 或更新版本：**

在容器终端执行：

```sh
node tools/pair-code.mjs
```

会显示一个六位数字码，有效 15 分钟。生成新码不会重启服务，已经配对的电视不受影响。NAS SSH 终端中的等价命令：

```sh
sudo docker exec lg-nas-cinema node tools/pair-code.mjs
```

**NAS 服务仍是 0.1.0：**

旧版码在服务启动后的 15 分钟内有效。如果已过期，先暂停其他电视上的播放，在 NAS Docker 界面**重新启动 lg-nas-cinema 容器**，然后在容器终端执行：

```sh
cat /state/pair-code
```

NAS SSH 终端中的等价命令：

```sh
sudo docker restart lg-nas-cinema
sudo docker exec lg-nas-cinema cat /state/pair-code
```

重启旧服务会短暂中断当前播放，但会保留已有电视的配对。新服务启动后，也可直接读取 /state/pair-code 获取启动配对码。

### 5. 在电视 App 中配对

打开「云影视」，填写：

| 字段 | 内容 |
| --- | --- |
| 影视服务地址 | http://NAS_IP:8780，替换为真实 NAS IP |
| 配对码 | 上一步从 NAS 获得的六位数字 |

选择 **连接**。成功后会出现 NAS 名称、原有媒体库、海报和最近播放记录。

App 会在这台电视记住连接信息。每台电视单独配对，使用同一套 NAS 服务即可；同一 NAS 账号下的观看进度共享。

## 账号、端口和两种码的区别

| 名称 | 用途 / 来源 |
| --- | --- |
| LG 开发者账号 | 登录电视的 Developer Mode，使用自己的 LG 账号 |
| NAS 本地账号 | NAS 服务登录影视中心，使用自己的 NAS 用户名和密码 |
| 电视 Passphrase | 电脑连接电视、安装 App；在每台电视的 Developer Mode 页面查看 |
| NAS 配对码 | 电视「云影视」连接 NAS；在 NAS 容器中生成，15 分钟有效 |
| NAS 管理地址 | 首次配置 NAS 服务时填写，通常是 https://NAS_IP:9443，以实际设置为准 |
| 影视服务地址 | 电视「云影视」里填写 http://NAS_IP:8780 |

<a id="nas-setup"></a>
## B. 第一次部署 NAS 服务

已有服务的用户直接执行 [A 部分](#second-tv)，不需要重复部署。

### 1. 前提

- 绿联 NAS 已有「影视中心」，在原绿联客户端中可以看到并播放媒体库。
- NAS 支持 Docker，以下命令使用 Docker Compose。
- 一个允许访问目标媒体库的 NAS 本地账号。配置工具当前未实现账号二次验证登录。
- 可以通过 SSH 登录 NAS，或在 NAS 上执行 Docker 命令。

### 2. 下载服务端

从 [Releases](https://github.com/zhr2038/UGreen-For-WebOS/releases/latest)下载：

```text
lg-nas-cinema-server-v0.2.1.zip
```

在电脑解压，把里面的 **lg-nas-cinema** 文件夹上传到 NAS 的 Docker 项目目录。下面以 /volume1/docker/lg-nas-cinema 为例；目录不同就替换它，配置较适合放在 SSD 存储池。

### 3. 构建并配置 NAS 登录

在 NAS SSH 终端依次执行：

```sh
cd /volume1/docker/lg-nas-cinema
sudo docker compose build
sudo docker compose run --rm --no-deps lg-nas-cinema node tools/configure-nas.mjs
```

工具依次询问：

1. **NAS 管理地址**，例如 https://NAS_IP:9443，填写原绿联管理页面的实际地址。
2. HTTPS 证书指纹。确认地址是自己的 NAS 后输入 **yes**，后续连接会校验该指纹。
3. **NAS 本地用户名、密码**。密码不回显，也不会保存到配置文件。

出现“配置成功”后，登录会话已写入挂载的 **state/nas.json**。这是私有运行数据，应保留在 NAS，不要上传 GitHub。

已有 NAS 配置时，此步骤会替换这个服务使用的 NAS 账号，影响连接这套服务的所有电视。

### 4. 启动服务

```sh
sudo docker compose up -d
sudo docker compose ps
```

在电脑访问 http://NAS_IP:8780/health，确认返回 ok=true，然后完成 [A 部分](#second-tv)的电视安装与配对。

首次构建需要下载 Node.js 镜像和运行依赖；NAS 无法访问镜像仓库或 npm 时，构建会失败。

### 5. 日后维护

```sh
# 查看日志
sudo docker compose logs --tail=100 lg-nas-cinema

# 生成新配对码，不中断现有电视
sudo docker compose exec lg-nas-cinema node tools/pair-code.mjs

# 修改 NAS 登录配置后，重启服务使配置生效
sudo docker compose run --rm --no-deps lg-nas-cinema node tools/configure-nas.mjs
sudo docker compose restart lg-nas-cinema
```

升级时保留原 **state** 目录，替换程序文件后运行 sudo docker compose up -d --build。state/clients.json 保存已有电视配对，state/nas.json 保存 NAS 登录会话。

## v0.2.1 修复内容

修复播放控制栏左右键无法导航、弹出菜单被透明层遮挡、专用播放/暂停键反转、加载中暂停误报故障、退出时等待网络、迟到播放和搜索请求覆盖页面、列表返回丢失页码/焦点、配对失败污染当前 NAS 地址、相册失效链接重试、视频幻灯片暂停等问题。[详细记录](docs/BUGFIX-0.2.1.md)。

## 遥控器操作

| 按键 | 行为 |
| --- | --- |
| 上下左右 | 移动焦点 |
| 确定 | 进入、播放、执行选中操作 |
| 控制栏按钮区左 / 右 | 在播放、列表、设置、信息等按钮间移动 |
| 进度条上左 / 右，或控制栏隐藏时左 / 右 | 快退 / 快进 10 秒 |
| 按钮区上键 / 进度条下键 | 在进度条与按钮区切换 |
| 播放时下键 | 显示控制栏并选择按钮 |
| 排序 / 筛选选择框 | 按确定打开选项，上下选择，确定应用，返回取消 |
| 返回 | 关闭菜单、返回影片、返回首页 |
| 首页连续两次返回 | 退出 App |

进度通常每 15 秒以及暂停、返回时同步。控制栏提供暂停、选集、倍速、比例，以及电视直接暴露的音轨和字幕轨道切换；这不代表已经支持提取所有内嵌字幕。

## Developer Mode 续期

开发模式有有效期。**到期前**打开电视 Developer Mode，联网后使用 **Extend Session Time / EXTEND** 续期。到期后可能需要重新开启并安装 App，按 [LG 官方说明](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app#extending-developer-mode-time)操作。

两台电视各自有自己的期限，需要分别查看。清除 App 数据或卸载重装后，可能需要重新配对 NAS。

<a id="faq"></a>
## 常见问题

**电脑连接的就是 LG 电视，为什么鼠标点不了电视应用商店？**

HDMI 显示的是电脑桌面。Home、应用商店、Developer Mode 属于电视自己的系统，使用电视遥控器进入；“输入源 → 对应 HDMI”可回到电脑画面。

**webOS Dev Manager 连不上电视？**

检查电视已开机、Dev Mode Status 和 Key Server 已开启，填的是电视 IP，Passphrase 大小写正确，用户名 prisoner、端口 9922。电脑和电视要互通；访客 Wi-Fi、无线隔离或电视 IP 改变都可能导致失败。

**云影视连接超时？**

先在电脑访问 http://NAS_IP:8780/health。电脑也连不上时检查容器、端口映射 8780:8780 和 NAS IP；电脑可以访问而电视不行时，检查电视与 NAS 的网络。电视 App 填的是影视服务的 8780 地址。

**配对码错误或过期？**

在 15 分钟内输入 NAS 生成的六位数字，不是电视 Passphrase。多次错误输入会临时限流，等待 15 分钟再试。旧 0.1.0 服务按 A 部分的旧版步骤获取新码。

**新 App 能连接旧 NAS 服务吗？**

0.2.x 电视 App 可连接 0.1.0 / 0.1.1 NAS 服务观看电影，但相册要求 0.2.0 NAS 服务。升级时按 B 部分保留 state 目录并重新构建。新配对码工具从 0.1.1 服务端开始提供；0.1.0 服务仍需在码过期后通过重启生成新码。

**有海报，但视频黑屏、无声音或打不开？**

原画直放需要电视自身支持容器、视频编码、音轨、杜比视界 Profile 和码率。可以先用 H.264/AVC + AAC 的 MP4 排查。项目没有实时转码，不能保证任意 DTS、TrueHD 或 Dolby Vision 片源都兼容。

**为什么没有字幕？**

当前只显示电视 HTML 播放器直接暴露的字幕。独立的内嵌 SRT/ASS/PGS 提取、外挂字幕加载和烧录尚未实现；原 Android App 能显示的字幕在这里也可能不显示。

**NAS 登录过期 / HTTPS 证书变化？**

已配对电视可在设置中重新登录 NAS。证书更换导致指纹不匹配时，在 NAS 重新运行配置工具，核实新指纹后保存并重启服务。

## 开发与验证

需要 Node.js 22+，已使用 Node.js 24：

```sh
npm ci
npm test
npm run test:ui
npm run package:tv
```

界面回归检查使用 Playwright CLI，需要已安装 Google Chrome；测试使用模拟 NAS 和媒体事件，不能代替电视解码验收。

打包结果位于 dist。使用 python tools/package-server.py 生成服务端 ZIP。GitHub Actions 在 Windows/Linux 测试，并构建电视安装包和 Docker 镜像。

目录：app 为电视端，lib 和 server.mjs 为 NAS 服务，tools 为配置/部署/调试工具，test 为测试。私有配置、令牌、开发日志和分析用的原 App 安装包不包含在仓库或 Release。

2026-10-30 实机验证：C5 上的 4K HEVC 片源播放，现场确认画面与声音；1080p AVC/AAC 断点续播；暂停、遥控快进、进度回写。未独立测量 HDR 输出参数、声道格式或所有片源兼容性。新增配置与配对工具由模拟 NAS 测试覆盖，其他电视型号仍需实机验证。

界面参考绿联 Android TV 1.21.0 的影视页面；[Figma 设计稿](https://www.figma.com/design/CcZn2Sp9cpxc9JPf1eNoZV?node-id=5-5)为设计参考，尚未逐屏进行像素对照。使用未公开 UGOS 接口，NAS 固件升级后可能需要适配。
