#!/bin/sh
# Local cross-compilation only. CF_ZIG names an already installed Zig compiler.
# Run from repository root. Does not download or execute the ARM worker.
set -eu
"${CF_ZIG:-zig}" cc -target arm-linux-musleabi -marm -ffreestanding -fno-builtin \
 -fno-stack-protector -fno-omit-frame-pointer -Os -g -nostdlib -fPIE -pie \
 -Wl,-e,_start -Wl,--dynamic-linker,./linker -Wl,--export-dynamic \
 native/worker.c -Lassets/native-runtime-armv7 -Wl,--no-as-needed \
 -l:libc.so -l:libdl.so -o assets/native-worker-armv7/p2p-connect-worker
