# 0.4 电视服务运行时核对

本次结论：0.4以 **Node20.12.2 / webOS TV26** 为电视服务基线，不能因此前构建target=node16
就声明支持webOS24/25。没有加入全局polyfill、取消helper或兼容重构，也没有电视操作。
构建target只转换语法，不提供缺失的运行时API。

LG的[官方JS Service Basics](https://webostv.developer.lge.com/develop/guides/js-service-basics)
给出的平台映射为：

| webOS TV | Node |
| --- | --- |
| 26 | 20.12.2 |
| 25 | 16.20.2 |
| 24 | 16.19.1 |
| 23 / 22 | 12.22.2 / 12.21.0 |

应核对实际固件平台和service Node版本，不能只从电视型号/年份推断。

## 实际本地探针

在隔离WSL Linux临时目录使用以下官方linux-x64归档，运行前把下载SHA256与对应官方
SHASUMS256.txt匹配；不是Windows主机Node模拟版本。

| 归档 | SHA-256 |
| --- | --- |
| [node-v16.20.2-linux-x64.tar.xz](https://nodejs.org/dist/v16.20.2/node-v16.20.2-linux-x64.tar.xz) | 874463523f26ed528634580247f403d200ba17a31adf2de98a7b124c6eb33d87 |
| [node-v20.12.2-linux-x64.tar.xz](https://nodejs.org/dist/v20.12.2/node-v20.12.2-linux-x64.tar.xz) | 595272130310cbe12301430756f23d153f7ab95d00174c02adc11a2e3703d183 |

校验来源：[16.20.2 SHASUMS](https://nodejs.org/dist/v16.20.2/SHASUMS256.txt)、
[20.12.2 SHASUMS](https://nodejs.org/dist/v20.12.2/SHASUMS256.txt)。

| 检查 | 实际Node16.20.2 | 实际Node20.12.2 |
| --- | --- | --- |
| global DOMException | undefined | function |
| AbortSignal.any | undefined | function |
| AbortController / signal.reason | 可用 | 可用 |
| Object.hasOwn / Array.at / replaceAll / crypto.randomUUID | 可用 | 可用 |
| Readable.iterator | 可用 | 可用 |
| inflateRawSync maxOutputLength硬上限 | 实测生效 | 实测生效 |
| 真实PhotoVideoSession.describe({signal})，假NAS | TypeError，NAS请求0次 | 成功，NAS请求1次 |

最后一项直接导入当前photo-video/playback/ugos模块，创建source id=1，传入真实
AbortController.signal；唯一NAS request被本地内存stub替代，没有网络或真实身份。

## 源码定位与发布范围

已静态核对service与lib。相册取消链中photo-video、photos、photo-http、
photo-collections使用AbortSignal.any；photo-video/photo-http/photos还直接创建
DOMException。这些执行路径在上述Node16没有所需API，已有真实失败证据。
不是仅有“可能不兼容”的语法推测。

没有把所有lib都视为电视service依赖：电视使用NativeThumbnails；PC用的images/sharp
和浏览器轨道模块属于其他执行环境。未修改私有P2P/native agent、app/photos或发布文案。
Node12未实跑，也不在本次支持范围内；没有为它回移较新的取消、stream等API。

此短探针验证了所列API及一条具体相册调用，**没有完成完整Node20版本回归、启动真实
webos-service或建立所有LG机型兼容证据**。本版采用
明确Node20/webOS26边界。以后若要支持Node16，应集中实现可dispose、无监听器泄漏的
取消组合适配，覆盖请求/流的完整生命周期，再用实际Node16做独立回归后扩大范围。
