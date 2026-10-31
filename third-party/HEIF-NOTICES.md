# HEIF decoder third-party notices and corresponding source

The optional HEIF decoder uses these separate, replaceable LGPL components:

| Component | Version | License / source |
| --- | --- | --- |
| libheif-js npm packaging | 1.23.5 | LGPL-3.0; [repository and build packaging](https://github.com/catdad-experiments/libheif-js), [npm archive](https://registry.npmjs.org/libheif-js/-/libheif-js-1.23.5.tgz) |
| libheif | 1.23.5, upstream commit 413e2a8 | LGPL-3.0-or-later; [tagged source](https://github.com/strukturag/libheif/tree/v1.23.5), [source archive](https://github.com/strukturag/libheif/archive/refs/tags/v1.23.5.tar.gz) |
| libde265 HEVC decoder | 1.0.15 | LGPL-3.0; [tagged source](https://github.com/strukturag/libde265/tree/v1.0.15), [corresponding source archive](https://github.com/strukturag/libde265/releases/download/v1.0.15/libde265-1.0.15.tar.gz) |

License texts are included alongside this notice:

- [libheif-js LGPL](libheif-js-LGPL-3.0.txt)
- [libheif COPYING, including LGPL/GPL](libheif-COPYING.txt)
- [libde265 COPYING, including LGPL/GPL](libde265-COPYING.txt)

The application adapter/worker is in `app-src/heif-core.mjs`,
`app-src/heif-worker.mjs`, `app/heif-client.js`; build and replacement instructions
are in `docs/HEIF-DECODER.md`. The library loader and WASM are copied byte for byte
from the pinned npm archive. The optional source-script packaging escapes those
same loader bytes and WASM into a separately replaceable asset; it does not modify
the library implementation. Source may be modified, and the application rebuilt
with an interface-compatible modified library for debugging those modifications.

To regenerate the decoder, obtain libheif's tagged source plus libde265's matching
source, an Emscripten toolchain, and run the tagged upstream
[`build-emscripten.sh`](https://github.com/strukturag/libheif/blob/v1.23.5/build-emscripten.sh)
with `USE_WASM=1`, `ENABLE_LIBDE265=1`, `LIBDE265_VERSION=1.0.15`, `ENABLE_AOM=0`.
The [packaging install script](https://github.com/catdad-experiments/libheif-js/blob/master/scripts/install.js)
shows the ES2019 transform and archive layout. The reproducible precompiled
[release](https://github.com/catdad-experiments/libheif-emscripten/releases/tag/v1.23.5)
and [its source](https://github.com/catdad-experiments/libheif-emscripten/tree/v1.23.5)
bind the selected libheif commit. Replace the two vendor assets and rebuild the
optional source-script asset, then rebuild/install the IPK using the repository's
installation instructions. The app adapter pins a wasm32 ABI/version; upgrading
to a different upstream ABI requires updating the openly supplied adapter too.

When publishing a binary/IPK, distribute this notice and the included license
texts with it and make the corresponding library/build/application source
archives available alongside the release, so users can rebuild with modified
libraries. No reverse-engineering restriction is imposed for debugging such
modifications. This decoder is provided without warranty under the accompanying
licenses. The test HEIF color charts are separately authored CC0 fixtures;
the x265 encoder used to generate them is not included in the runtime decoder.
