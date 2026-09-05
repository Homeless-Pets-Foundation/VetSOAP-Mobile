// Expo config plugin: set android:largeHeap="true" on <application>.
//
// Why: the production fleet is Samsung Galaxy Tab A7 Lite tablets (SM-T220 /
// T225N / T227U — Mediatek MT8768WT, 4 GB RAM, Sentry device.class "low"). The
// Android OS was killing the app mid-recording, which produces no crash event
// anywhere (see reportPriorProcessKill in src/lib/durableAudio/durableRecovery.ts
// for why Sentry cannot see this). Sentry showed the process starved instead:
// slow_phase_fetchUser at 14 456 ms against a 10 000 ms threshold, repeated cold
// starts 17 minutes apart, and init_watchdog_fired.
//
// Without largeHeap the Java heap is capped at the vendor default (~192-256 MB on
// these devices) while Hermes, the RN new architecture, MediaCodec and FFmpeg's
// native allocations all compete for it. largeHeap raises that ceiling, which
// makes the low-memory killer reach for us later. It is not a fix on its own —
// it buys headroom alongside freezeOnBlur, the lazy FFmpeg import and the
// serialized startup sweeps.
//
// expo-build-properties has no largeHeap option, so this edits the manifest
// directly. Written as a plugin rather than by hand because android/ is not
// committed (EAS managed build).
//
// Note largeHeap does NOT help native/off-heap allocations (FFmpeg, MediaCodec
// buffers); those are bounded by the process address space, not the Java heap.

const { withAndroidManifest } = require('expo/config-plugins');

const withAndroidLargeHeap = (config) =>
  withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults?.manifest?.application?.[0];
    if (!application) {
      throw new Error('with-android-large-heap: no <application> node in AndroidManifest.xml');
    }
    application.$ = application.$ ?? {};
    application.$['android:largeHeap'] = 'true';
    return cfg;
  });

module.exports = withAndroidLargeHeap;
