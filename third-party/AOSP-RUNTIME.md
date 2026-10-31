# Seven-file AOSP runtime provenance and distribution scope

The candidate public runtime consists only of these seven existing, checked
Android ARMv7 files: `linker`, `libc.so`, `libdl.so`, `libm.so`, `liblog.so`,
`libz.so`, `libstdc++.so`. Their exact sizes/hashes and original system paths are
recorded in [AOSP-RUNTIME-PROVENANCE.json](AOSP-RUNTIME-PROVENANCE.json).
No binaries were copied to this repository by this audit.

The official [Google system-image metadata](https://dl.google.com/android/repository/sys-img/android/sys-img2-1.xml)
identifies `system-images;android-24;default;armeabi-v7a`, revision7,
`armeabi-v7a-24_r07.zip`,283677512bytes, SHA1
`3454546b4eed2d6c3dd06d47757d6da9f4176033`, license ref `android-sdk-license`.
The previously verified archive and read-only ext4 extraction supplied the
seven files. Matching zip/system `build.prop` SHA256 is
`0f666c0c03d2f0fbc7e4df5e8ea2d6e28f44c4c649e08a4f9c654e1144e0f779`;
fingerprint is `Android/sdk_phone_armv7/generic:7.0/NYC/3245079:userdebug/test-keys`.
The original build metadata remains private local research, containing no NAS
identity, while these public build facts are retained in the provenance file.

## Actual notices

[AOSP-RUNTIME-NOTICES.txt](AOSP-RUNTIME-NOTICES.txt) preserves byte-for-byte all
six matching notice groups from that image's original NOTICE,345480bytes,SHA256
`4a6fc73769dee5ed3c2740633c19a2666161caca03bb56b2e3b56300bd33a0d5`.
The grouped libc notice also covers libstdc++. No GPL terms were found in these
selected groups; they contain BSD-style/other permissive notices, Apache terms,
and zlib terms. Keep the complete associated text, including all copyright,
redistribution, attribution, non-endorsement and other conditions; a one-line
“AOSP/Apache2” label does not preserve those notices.

| Runtime files | Source family / notice group |
| --- | --- |
| libc.so, libstdc++.so | Bionic and its upstream components; original notice group55 |
| linker | Bionic linker, group63 |
| libdl.so | Bionic libdl, group82 |
| libm.so | Bionic/libm and math upstreams, group91 |
| liblog.so | platform/system/core liblog, group19 |
| libz.so | platform/external/zlib, group56 |

The [AOSP Bionic README](https://android.googlesource.com/platform/bionic/+/android-7.0.0_r1/)
identifies its libc/libdl/libm/linker and C++ ABI library. This `libstdc++.so`
is the Bionic ABI-support component. The actual per-file image notices, not the
library basename, determine the license material to accompany it.

Google's [SDK terms](https://developer.android.com/studio/terms) restrict the SDK
generally; section3.5 says open-source components are governed by their own
open-source licenses. This audit narrows the candidate packaging scope to the
seven explicitly notice-mapped components. It does not grant redistribution of
the entire system image, Google add-ons or the proprietary UGREEN/PeerGine SDK.

## Root packaging/source-build recommendations

If publishing these seven unmodified candidates, pin the seven provenance
hashes, preserve this notice/provenance pair in the IPK/source release, and make
the corresponding third-party material accessible with the release. Retain
every condition in the actual notices and mark any later modifications. Do not
bundle `libugagentsdk.so`, `libpgJniTunnel.so` or the130MB APK; those two libraries
are provisioned locally from the fixed official URL and checked separately.

The exact source manifest/revision behind the NYC3245079 prebuilt was not
provided in the checked archive metadata. `android-7.0.0_r1` was the earlier
source-review baseline for Bionic startup/headers; it is **not** proved to be
the exact source of these r07 binaries. Preserve that gap rather than claiming
byte-reproducible source provenance.

For a source-built public runtime, select an explicit AOSP7.0 manifest/tag,
record `repo manifest -r`, toolchain and product configuration, and build only
the ARM32 Bionic linker/libc/libdl/libm/libstdc++, system/core liblog and external
zlib modules with the applicable complete notices. Publish the resulting
manifest/hashes and build instructions. Then re-run symbol/version closure and
the isolated C5 offline initialization gate against the new hashes before using
that build. Do not substitute NDK link-time stub libraries as a runtime.

This audit changed no runtime binary, TV file, worker or package. Exact source
revision recovery and public-package integration remain separate root tasks.
