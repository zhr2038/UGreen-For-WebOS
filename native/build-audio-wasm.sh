#!/usr/bin/env bash
# Reproducible LGPL-2.1 FFmpeg 7.1.1 -> STANDALONE_WASM build for CloudFrame TV audio compat.
# Runs in WSL2 / Linux using /tmp/cloudframe-audio-build; writes output into repo assets/ and third-party/.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="${BUILD_ROOT:-$HOME/.cache/cloudframe-audio-build}"
EMSDK_DIR="${EMSDK_DIR:-$HOME/.cache/cloudframe-emsdk}"
FFMPEG_VERSION="7.1.1"
FFMPEG_SHA256="733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1"
TARBALL="$BUILD_ROOT/ffmpeg-$FFMPEG_VERSION.tar.xz"
SRC_DIR="$BUILD_ROOT/ffmpeg-$FFMPEG_VERSION"
OBJ_DIR="$BUILD_ROOT/ffmpeg-build"
PREFIX="$BUILD_ROOT/ffmpeg-prefix"

mkdir -p "$BUILD_ROOT" "$REPO_ROOT/assets/audio-compat" "$REPO_ROOT/third-party"

if [ ! -d "$EMSDK_DIR/.git" ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi
"$EMSDK_DIR/emsdk" install 3.1.74 >/dev/null
"$EMSDK_DIR/emsdk" activate 3.1.74 >/dev/null
# shellcheck source=/dev/null
source "$EMSDK_DIR/emsdk_env.sh"

if [ ! -f "$TARBALL" ]; then
  curl -fL --retry 3 "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o "$TARBALL.tmp"
  mv "$TARBALL.tmp" "$TARBALL"
fi
ACTUAL_TAR_SHA256="$(sha256sum "$TARBALL" | awk '{print $1}')"
echo "FFmpeg tarball sha256: $ACTUAL_TAR_SHA256"
[ "$ACTUAL_TAR_SHA256" = "$FFMPEG_SHA256" ]

rm -rf "$SRC_DIR" "$OBJ_DIR" "$PREFIX"
tar -xf "$TARBALL" -C "$BUILD_ROOT"

CONFIGURE_FLAGS=(
  "--prefix=$PREFIX"
  "--target-os=none"
  "--arch=x86_32"
  "--enable-cross-compile"
  "--cc=emcc"
  "--cxx=em++"
  "--ar=emar"
  "--ranlib=emranlib"
  "--nm=emnm"
  "--extra-cflags=-O3 -msimd128 -D_POSIX_C_SOURCE=200809L"
  "--disable-gpl"
  "--disable-nonfree"
  "--disable-programs"
  "--disable-doc"
  "--disable-debug"
  "--disable-pthreads"
  "--disable-w32threads"
  "--disable-os2threads"
  "--disable-network"
  "--disable-autodetect"
  "--disable-asm"
  "--disable-inline-asm"
  "--disable-avdevice"
  "--disable-swscale"
  "--disable-avfilter"
  "--disable-everything"
  "--enable-avcodec"
  "--enable-avformat"
  "--enable-swresample"
  "--enable-avutil"
  "--enable-protocol=file"
  "--enable-demuxer=matroska"
  "--enable-muxer=mpegts"
  "--enable-bsf=hevc_mp4toannexb,h264_mp4toannexb"
  "--enable-parser=hevc,h264,dca,mlp,flac,ac3,aac,mpegaudio,vorbis,opus"
  "--enable-decoder=dca,truehd,mlp,flac,alac,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f64le,pcm_bluray,pcm_dvd,vorbis,opus"
  "--enable-encoder=eac3,ac3"
)

mkdir -p "$OBJ_DIR"
(
  cd "$OBJ_DIR"
  "$SRC_DIR/configure" "${CONFIGURE_FLAGS[@]}"
  grep -q "#define CONFIG_GPL 0" config.h
  grep -q "#define CONFIG_NONFREE 0" config.h
  make -j"$(nproc)"
  make install
)

OUT_WASM="$REPO_ROOT/assets/audio-compat/audio-compat.wasm"
emcc -O3 -msimd128 \
  -I"$PREFIX/include" \
  "$REPO_ROOT/native/audio-compat.c" \
  "$PREFIX/lib/libavformat.a" \
  "$PREFIX/lib/libavcodec.a" \
  "$PREFIX/lib/libswresample.a" \
  "$PREFIX/lib/libavutil.a" \
  -lm \
  -sSTANDALONE_WASM=1 \
  --no-entry \
  -sINITIAL_MEMORY=33554432 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sMAXIMUM_MEMORY=134217728 \
  -sEXPORTED_FUNCTIONS=_ca_transcode_gop \
  -Wl,--allow-undefined \
  -o "$OUT_WASM"

cp "$SRC_DIR/COPYING.LGPLv2.1" "$REPO_ROOT/third-party/FFMPEG-LGPL-2.1.txt"

cat > "$REPO_ROOT/third-party/AUDIO-COMPAT-NOTICES.md" <<'EOF'
# TV-Built-In MKV Audio Compatibility Notices

`assets/audio-compat/audio-compat.wasm` is compiled from unmodified upstream FFmpeg
(`ffmpeg-7.1.1`) configured strictly under **LGPL-2.1** (`--disable-gpl --disable-nonfree`)
together with `native/audio-compat.c`.

- Upstream source: https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz
- License text: [FFMPEG-LGPL-2.1.txt](FFMPEG-LGPL-2.1.txt)
- Reproducible build script: `native/build-audio-wasm.sh`
- Included components: `matroska` demuxer, `mpegts` muxer, `hevc_mp4toannexb`/`h264_mp4toannexb` bitstream filters, audio decoders (`dca`, `truehd`, `mlp`, `flac`, `alac`, `pcm_*`, `vorbis`, `opus`), and `eac3`/`ac3` encoders + `libswresample`.
EOF

SOURCE_SHA="$(sha256sum "$REPO_ROOT/native/audio-compat.c" | awk '{print $1}')"
WASM_SHA="$(sha256sum "$OUT_WASM" | awk '{print $1}')"
WASM_SIZE="$(wc -c < "$OUT_WASM")"
SCRIPT_SHA="$(sha256sum "$REPO_ROOT/native/build-audio-wasm.sh" | awk '{print $1}')"

cat > "$REPO_ROOT/assets/audio-compat/AUDIO-WASM-PROVENANCE.json" <<EOF
{
  "format": "cloudframe.audio-compat-wasm.v1",
  "license": "LGPL-2.1",
  "ffmpegVersion": "$FFMPEG_VERSION",
  "ffmpegTarballSha256": "$ACTUAL_TAR_SHA256",
  "emsdkVersion": "3.1.74",
  "sourceSha256": "$SOURCE_SHA",
  "buildScriptSha256": "$SCRIPT_SHA",
  "wasmSha256": "$WASM_SHA",
  "wasmBytes": $WASM_SIZE,
  "gplEnabled": false,
  "nonfreeEnabled": false
}
EOF

echo "Built $OUT_WASM ($WASM_SIZE bytes, sha256=$WASM_SHA)"
