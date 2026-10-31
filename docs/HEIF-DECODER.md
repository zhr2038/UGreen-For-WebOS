# 离线 HEIF / HEIC 解码适配

实现文件为 `app-src/heif-core.mjs`、`app-src/heif-worker.mjs`、`app/heif-client.js`；没有修改 photos、UHD pipeline、index、package 或主 build 脚本。factory 建立时不加载库、不启动 Worker。传入完整原图 Blob 才启动单次 Worker，成功、失败、取消和超时均 terminate，释放整个已增长的 WASM heap。

## 统一回调

```js
const heif = window.createPhotoHeifDecoder(); // 惰性，读取可选 CloudFrameHeifConfig。
const decodeImage = (blob, options) => heif.decode(blob, options);
const result = await decodeImage(originalBlob, {
  signal, expectedWidth, expectedHeight, targetWidth:3840, targetHeight:2160,
});
// result.image: caller-owned ImageBitmap，最多3840×2160，不放大。
// result.sourceWidth/sourceHeight: 真正主图经过方向校正后的原始尺寸。
// result.orientationApplied === true; result.scaled 表示中间bitmap曾缩小。
draw(result.image);
result.close(); // 幂等；也可由 pipeline 直接 image.close()。
heif.cancel();  // 取消当前解码，新的decode也会先取消旧任务，最多一个Worker。
heif.dispose();
```

只接受 Blob，不接受 URL，工厂不会请求 NAS 原图或覆盖既有预览。expected 尺寸可与方向交换前的 NAS 尺寸匹配；真实文件/解码尺寸不符则拒绝，不用小预览冒充原图。主图通过 libheif primary handle 读取，不取图片数组第一项或缩略图。HEIF 的 irot/imir/crop 由 libheif 实际解码应用；仅没有 irot/imir 时解析有界 EXIF IFD0 的1–8方向并补旋转/镜像，避免双重旋转。source axes 与最终bitmap方向一致，缩放取整误差小于1px。

返回额外诊断：`codedWidth/Height`、`decodedWidth/Height`、`width/height`、`wasmHeapBytes`、`decodeMs`、`originalDecoded:true`、`decoder`。输出为8-bit sRGB，明确 `hdrPreserved:false`；没有声称保留 HEIF HDR、照片原生色深或物理UHD。`stats()` 仅给数字/布尔计数，不记录文件名、URL或cap。

## 内存和取消边界

默认16MP，完整Blob最多32MiB，单边最多20000，输出最多3840×2160，不放大。maxPixels可收紧；硬上限50MP，不能因为API允许就把C5默认提高到48MP。libheif context 启用原安全限制，并收紧像素面积、tile/items、profile、单块和总内存预算（默认256MiB，配置上限512MiB）。绑定的原始 C API / wasm32 struct ABI 固定 libheif1.23.5；库版本或安全结构版本不同会拒绝，升级需重新核对。

完整原图先在WASM解码，若大于目标，使用 `heif_image_scale_image` 在WASM内缩放并释放原图 image，然后只复制目标RGBA。始终按**实际 decoded plane 尺寸和 stride**读数据，校验声明/解码尺寸一致、plane边界和stride，避免依赖旧 wrapper 的声明尺寸拷贝。不会创建完整16/50MP的第二份JS RGBA。成功后先释放 heif image/handle/context，再交付 ImageBitmap/transferable RGBA；主线程RGBA fallback只处理已缩小的结果。

总内存预算是 libheif 记账限制，不是整个浏览器进程的硬上限；JS Blob、codec及GPU/encoder仍有开销。桌面12MP合成图实测4032×3024→2880×2160，WASM heap 101,974,016bytes，返回RGBA24,883,200bytes，Chrome完整worker约139ms。这只是桌面证据；C5上的时间、峰值和可接受上限仍需实机测。超时默认30秒、最多60秒；主线程始终能 terminate 阻塞的 Worker。外部signal、后来的decode或dispose均立即取消，不等同步WASM自己响应。

## 精确依赖和资源

选择 npm 官方 `libheif-js@1.23.5`，LGPL-3.0；包版本和构建引用由[官方安装脚本](https://github.com/catdad-experiments/libheif-js/blob/master/scripts/install.js)及[对应预编译发布](https://github.com/catdad-experiments/libheif-emscripten/releases/tag/v1.23.5)核对。包没有运行时 npm dependencies。此次核对的 npm integrity 为：

```text
sha512-umXZPthnWZtF3iG/5mQG+AZ2V6i0UeYpo3z2CkggTEgL8dKmIIwJT6TDuAMuabXa1yTW8uJ1ZAgR+CxNTklYYw==
```

| 资源 | 字节 | SHA-256 |
| --- | ---: | --- |
| `libheif-wasm/libheif.js` | 91,255 | `376c0bb483c23ac458cd22d718074693748ea75eddc3e4929353d4153e365a2e` |
| `libheif-wasm/libheif.wasm` | 1,463,506 | `184d3d20f8323877f13e9f5254f9c6a0ce272c9a3a2f823b0b2bcd2ee9f73f80` |
| 官方 inline `libheif-bundle.mjs`（备选，不使用） | 2,043,959 | — |

root需要添加精确版本 `"libheif-js":"1.23.5"` 并更新lock。只复制上述分离loader/WASM及许可证；不用打包3.19MB asm.js或两个额外bundle。官方[build-emscripten.sh](https://github.com/strukturag/libheif/blob/v1.23.5/build-emscripten.sh)默认 libde2651.0.15、禁用AOM/多线程、WASM=1，所以不需要SAB/COOP/COEP，不是HEVC WebCodecs包装。该构建不能假定支持所有HEIF容器可能携带的VVC/JPEG/AV1；AVIF继续使用已有原生decoder。

## A：固定loopback资源，带当前clientcap

root建立允许的三个固定资源入口（不能接受任意文件名或路径），都验证当前clientcap。client用Blob bootstrap，避免Worker(file:)和跨origin new Worker(url)假设：

```js
window.CloudFrameHeifConfig = {
  workerUrl: 'http://127.0.0.1:PORT/api/heif-assets/worker.js?client=CAP',
  loaderUrl: 'http://127.0.0.1:PORT/api/heif-assets/libheif.js?client=CAP',
  wasmUrl: 'http://127.0.0.1:PORT/api/heif-assets/libheif.wasm?client=CAP',
};
```

cap只在当前内存配置/请求中，不能生成进仓库或落盘。换连接/账号时 root 销毁旧decoder并更新配置，或提供每次计算当前URL的loadAssets。

构建/复制的等价Node代码（由root并入现有build，不是本模块自动运行）：

```js
await build({entryPoints:['app-src/heif-worker.mjs'],outfile:'app/heif-worker.js',
  bundle:true,format:'iife',platform:'browser',target:'chrome87',minify:true});
await mkdir('app/vendor/libheif-1.23.5',{recursive:true});
await copyFile('node_modules/libheif-js/libheif-wasm/libheif.js',
  'app/vendor/libheif-1.23.5/libheif.js');
await copyFile('node_modules/libheif-js/libheif-wasm/libheif.wasm',
  'app/vendor/libheif-1.23.5/libheif.wasm');
```

Worker按需importScripts(loaderUrl)，有界WASM资源经fetch读取；loader、WASM保持官方原字节，不跟自有代码合并。根固定服务资源应设置正确 JS / application/wasm MIME，不返回NAS/浏览器任意路径。没有提供认证资源时不要默认请求CDN。

## B：file应用惰性script源码包，无file fetch

root可生成一个只含**公共程序资源**的 `app/heif-assets.js`，常规 `<script src=file...>` 可以加载后，再造Blob worker。源码包在桌面验证约2,052,195bytes：

```js
const workerSource = await readFile('app/heif-worker.js','utf8');
const loaderSource = await readFile('app/vendor/libheif-1.23.5/libheif.js','utf8');
const wasmBase64 = (await readFile('app/vendor/libheif-1.23.5/libheif.wasm')).toString('base64');
await writeFile('app/heif-assets.js','window.CloudFrameHeifAssets='+
  JSON.stringify({workerSource,loaderSource,wasmBase64})+';');
```

配置 `loadAssets({signal})` 只在第一次HEIF解码时加载这个script，完成后返回 `window.CloudFrameHeifAssets`（根可缓存公共资源Promise）。普通JPEG浏览不加载它。script的onerror/abort应移除节点并reject；迟到成功由client gate丢弃，不启动Worker：

```js
window.CloudFrameHeifConfig = { loadAssets: ({signal}) => lazyLoadHeifAssetScript(signal) };
```

loadAssets也可返回 `{workerSource,loaderSource,wasmBinary:ArrayBuffer|Uint8Array}`，或动态 `{workerUrl,loaderUrl,wasmUrl}`。library源码拼在Blob worker的自有源码之前，不eval；WASM复制约1.4MiB后transfer给Worker，不detach根持有的公共asset缓存。模式B不执行fetch(file:)或importScripts(file:)；真实Chrome file:页面已验证成功，仍要单独验C5。root可以用相同小样分别A/B测，不先臆测电视file权限。

## 许可、源码和替换

完整 LGPL/GPL 及上游COPYING已放在 `third-party/`，组件、对应源码和替换步骤见 [HEIF-NOTICES](../third-party/HEIF-NOTICES.md)。出IPK前root应将这些notice/license随包复制并可在源码仓库找到，release提供对应libheif/libde265及构建脚本的源码归档，不能仅剩一个不透明WASM文件。A模式可替换独立loader/WASM；B模式从替换后的同接口库重新生成heif-assets.js。没有签名hash阻止用户改库；版本/ABI检查的自有源码也可重建。

## 实测回归

```powershell
node --test test/heif-core.test.mjs
node test/run-heif-ui.mjs
# 仅重新生成自有色块图：需Pillow+pillow-heif，不访问用户照片。
python tools/make-heif-fixtures.py --large
```

14项 core 回归使用真实HEVC合成文件；8项真实浏览器验证两个加载模式、bitmap/RGBA两种transfer、16MP/尺寸拒绝、原预览保留、取消/超时/单并发、12MP主图实际缩放。tiny EXIF1–8、双方向属性和第二张为primary都核对实际像素颜色。WASM未安装时core只会明确skip缺失依赖，已安装的损坏/错误模块会失败；本次14项没有skip。没有真实个人照片或真实NAS写入测试，没有声称C5 HEIF输出已验收。
