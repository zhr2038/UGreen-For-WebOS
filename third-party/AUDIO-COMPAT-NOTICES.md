# TV-Built-In MKV Audio Compatibility Notices

`assets/audio-compat/audio-compat.wasm` is compiled from unmodified upstream FFmpeg
(`ffmpeg-7.1.1`) configured strictly under **LGPL-2.1** (`--disable-gpl --disable-nonfree`)
together with `native/audio-compat.c`.

- Upstream source: https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz
- License text: [FFMPEG-LGPL-2.1.txt](FFMPEG-LGPL-2.1.txt)
- Reproducible build script: `native/build-audio-wasm.sh`
- Included components: `matroska` demuxer, `mpegts` muxer, `hevc_mp4toannexb`/`h264_mp4toannexb` bitstream filters, audio decoders (`dca`, `truehd`, `mlp`, `flac`, `alac`, `pcm_*`, `vorbis`, `opus`), and `eac3`/`ac3` encoders + `libswresample`.
