# Native P2P integration contract

The independent modules are **offline-built and default disabled**. Existing service, adaptive transport and TV package entry points do not import them. The private UID5059 probe proved one real 4096-byte authenticated read over SDK LINK4, but this new generic worker has not run under the production application UID. Neither WAN traversal nor sustained movie throughput has been accepted.

## Ownership and selection

`createNativeManager({account, enabled:false, prepareSdk, prepareRuntime, acquireActivity})` owns one immutable account copy. `account` contains canonical HTTPS relay origin, alias, token/staticToken/authMode/clientId and the original NAS `nasPublicRsa`. Missing original RSA returns `NAS_PUBLIC_RSA_MISSING` before any SDK start or key discovery. No conversion from password encryption keys or client public keys is supported.

The service supplies these callbacks; none is an HTTP/UI argument:

* `prepareSdk({signal})` calls the existing pinned official SDK provisioner. Proprietary SDK libraries are downloaded to UID-owned private storage and never bundled in Git/IPK.
* `prepareRuntime({sdk,signal})` calls `prepareNativeWorkerRuntime({dir,assetDir,workerDir,sdkDir,runtimeManifest,workerManifest,signal})`. `dir` is the owning state volume's `native-runtime` child; asset/worker directories are the packaged `native-assets` directory. The fixed runtime manifest is `AOSP-RUNTIME-PROVENANCE.json`, and own worker pin is `worker-manifest.json`. Files are hash-checked, canonical UID-owned directory mode0700, normal files0600 and linker/worker0700. Corrupt, symlinked, hardlinked or unexpected files fail closed.
* `acquireActivity({signal,maximumMs})` returns an idempotent release function after a bounded, nonpersistent/nonexplicit Activity is confirmed. It must not relaunch a callback/schedule or override global idle timeout. The application visibility/subscription owns the manager; hide/logout/reset/service quit call its cleanup. Activity completion acknowledgments belong to the service integration.

`await manager.select({signal})` returns either `{client, route, summary, close, retain}` or `{summary}` with a finite reason. Prefer verified LAN first. Invoke native selection only when LAN is unavailable; preserve HTTPS relay when native remains unverified. There is no automatic retry loop. Optional `mediaPath` performs an explicit bounded 4KiB media validation; ordinary connection selection does not read speculative files.

Routes require relay TLS/identity/backend/alias proof, LINK4/5, SDK listen-GOT safety check, own-loopback listener proof, matching unauthenticated NAS handshake and same-socket authenticated alias proof. LINK2 is relay and cannot become P2P. `summary` distinguishes authenticated/verified route from `mediaReadVerified`; metadata does not count as media. WAN remains false. Current becomes false on route change, worker exit, reset or visibility loss.

`NativeNasClient` allows GET/HEAD only, at most four owned concurrent sockets. Every newly opened socket independently verifies unauthenticated NAS identity and same-socket authenticated alias before the requested operation. NAS's existing internal token/ugk query protocol is retained, but no credential-bearing local URL is returned to the UI, route descriptor or log. Only internally recognized raw-media response bytes can update media evidence. Mutations must remain on the existing relay client and must never be blindly retried after an unknown outcome.

`retain()` returns an idempotent snapshot lease release. `releaseOwner()` releases the owning view while active snapshots retain the immutable account. `reset()`/`close()` force-revoke all sockets and child work, including snapshots, for logout/account changes. Never attach a new account to an old manager/client.

## Explicit production limits

Approved limits are maximum 6-hour process wall lifetime, cumulative CPU3600s, AS256MiB, FSIZE0/core0, finite combined stdout/stderr64KiB, selection10s, optional media proof4096B and graceful stop1s then own-child SIGKILL. The C loop and parent wall timer are independently bounded. SDK state output is change-only; duplicate callbacks are suppressed and total frame/output limits still fail closed. UID must be nonroot and match the child process; parent PID is checked before/after parent-death SIGKILL setup. Identity is one stdin frame only. AF_INET/6 only, no AF_UNIX/file-write/process fork-exec/io_uring, loopback-only listening and readonly SDK GOT checks remain. SDK logs are discarded. Diagnostic FPE/divzero observers, stack/register/operand dumps and CPU substitutions are absent.

These ceilings are resource contracts, not a promise of six hours of playback. Throughput, CPU consumption, renewal at lifetime expiry and main-UID/device behavior require separately authorized bounded physical verification. There is no transparent respawn or retry at expiry.

## Offline build and packaging

Run `native/build-worker.sh` from the repository root using an already installed Zig compiler (`CF_ZIG=/absolute/local/zig`). It compiles only; never runs the ARM worker. Then `node tools/audit-native-worker.mjs --record` records binary/source/header hashes. Subsequent `node tools/audit-native-worker.mjs` verifies them, ELF32 ARM PIE interpreter/dependencies/guard exports and absence of diagnostic exports.

`packageNativeAssets(serviceDirectory)` from `tools/package-native-assets.mjs` is an explicit build helper with no import-time copying. It verifies and copies only seven AOSP runtime binaries, NOTICE/provenance, own worker and its manifest. It rejects extra files, including proprietary SDK libraries. Existing `package-tv.mjs` is deliberately not wired yet.

Own worker SHA256: `44ea50a713656afd2e1955ade4c52305f410420d3d3fafa4e0a1f21fb7ec00b6`.

Validation: 31 meaningful fake-only worker/listener/client/manager tests pass. Tests cover default gating, unknown RSA, exact owner/frame/ELF/listen guards, no credential argv/env/log, LINK2 denial, NAS/socket mismatch before auth write, metadata/media separation, cancellation during preparation, immutable leases, route revocation, visibility cleanup, bounded concurrent connection reservations, stale handle isolation and old/new Activity release isolation. No production worker execution, device operation or credential-bearing network request occurred in this integration step.
