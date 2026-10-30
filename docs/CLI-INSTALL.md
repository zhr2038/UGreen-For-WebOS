# 用命令行安装到 LG webOS 电视

图形安装方法见 [README](../README.md#second-tv)。以下使用 Windows PowerShell 和 LG 官方 CLI。

## 1. 准备

在电视开启 Developer Mode、完成重启，并打开 Key Server。保持页面打开。

电脑安装 [Node.js 24](https://nodejs.org/en/download)，打开一个新的 PowerShell：

```powershell
node --version
npm.cmd --version
npm.cmd install -g @webos-tools/cli@3.2.6
```

## 2. 添加第二台电视

将 TV_IP 替换为这台电视页面显示的 IP，设备名称 lg-living-room 可以自己更换：

```powershell
$env:ARES_PROFILE='tv'
ares-setup-device.cmd --add lg-living-room --info host=TV_IP --info port=9922 --info username=prisoner
ares-novacom.cmd --device lg-living-room --getkey
```

出现 input passphrase: 时输入该电视的 Passphrase，区分大小写。检查连接：

```powershell
ares-device.cmd --system-info --device lg-living-room
```

能看到型号和固件版本就可以继续。

## 3. 安装并启动

从 [Releases](https://github.com/zhr2038/UGreen-For-WebOS/releases/latest)下载 .ipk，进入下载目录后执行：

```powershell
cd "$env:USERPROFILE\Downloads"
ares-install.cmd --device lg-living-room .\top.hrhome.nascinema_0.2.0_all.ipk
ares-launch.cmd --device lg-living-room top.hrhome.nascinema
```

随后按 README 的[获取 NAS 配对码和电视配对步骤](../README.md#second-tv)连接 NAS。

添加其他电视时，使用新的设备名称和它自己的 IP / Passphrase，重复添加和安装步骤即可，NAS 服务无需复制部署。

macOS/Linux 使用相同 ares 命令并去掉 .cmd；设置环境变量使用 export ARES_PROFILE=tv。

参考：[LG CLI 安装](https://webostv.developer.lge.com/develop/tools/cli-installation)、[LG CLI 开发指南](https://webostv.developer.lge.com/develop/tools/cli-dev-guide)、[LG Developer Mode](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)。
