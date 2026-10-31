# 可选开发工具

日常电视安装按主 [README](../README.md#second-tv)进行，不需要本页的调试工具。

| 工具 | 用途 |
| --- | --- |
| package-tv.mjs | 构建二维码资源和电视 JS 服务，连同界面打入一个 IPK；不要只打包 app 目录 |
| build-assets.mjs | 从开源二维码库构建本地前端资源 |
| configure-nas.mjs | 交互式配置 NAS 登录；Docker 运行依赖中已包含 |
| pair-code.mjs | 生成 15 分钟有效的新配对码；不中断已有电视 |
| package-server.py | 用 Python 标准库生成不包含运行凭据的服务端 ZIP |
| import-session.mjs | 导入本地开发时已取得的 NAS 会话，依赖开发者自己的私有 .local 文件 |
| deploy-nas.py | 通过 SSH 更新指定 NAS 上的独立服务目录，需要 Python paramiko，以及 NAS_HOST / NAS_USER / NAS_PASSWORD 环境变量 |
| tv-control.py | 已配对电视的遥控调试，需要 Python aiowebostv 和私有 .local/lg-tv.json |
| tv-eval.mjs | 对本项目电视 App 执行调试脚本，需要先用 ares-inspect 打开 Inspector，并通过 TV_INSPECTOR_PORT 指定其端口 |

tv-control.py 不会替用户自动完成首次遥控配对；日常安装不需要建立它的私有 JSON。tv-eval.mjs 只选择 URL 属于 top.hrhome.nascinema 的调试目标。

所有真实 NAS 会话、电视密钥、配对令牌以及调试脚本应留在被忽略的 .local/ 或 state/ 目录，不包含在公开仓库与安装包里。
