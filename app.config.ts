import { ExpoConfig, ConfigContext } from 'expo/config';
import r2ProductionDestination from './contracts/r2-production-destination-v1.json';

const IS_DEV = process.env.APP_VARIANT === 'development';
const IS_PRODUCTION = process.env.APP_VARIANT === 'production';
const IS_LOCAL_TEST = process.env.APP_VARIANT === 'local-test';
const IS_IOS_EAS_BUILD = process.env.EAS_BUILD_PLATFORM === 'ios';
const IS_EAS_BUILD =
  process.env.EAS_BUILD_PLATFORM === 'android' || IS_IOS_EAS_BUILD;

export const CANONICAL_PRODUCTION_R2_BUCKET_HOSTNAME =
  r2ProductionDestination.environments.production.virtualHost;

export function requireProductionR2BuildConfig(): void {
  if (!IS_EAS_BUILD || !IS_PRODUCTION) return;

  if (
    process.env.EXPO_PUBLIC_R2_BUCKET_HOSTNAME !==
    CANONICAL_PRODUCTION_R2_BUCKET_HOSTNAME
  ) {
    throw new Error(
      'Invalid EXPO_PUBLIC_R2_BUCKET_HOSTNAME for a production EAS build. ' +
        'Set the production EAS environment to the canonical Captivet virtual bucket hostname.',
    );
  }
}

function requireGoogleIosBuildConfig(): void {
  if (!IS_IOS_EAS_BUILD || IS_DEV) return;

  const missing = [
    'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
    'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID',
    'EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME',
  ].filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing Google Sign-In iOS build config: ${missing.join(', ')}. ` +
        'Set these in the EAS environment before building iOS.',
    );
  }
}

export default ({ config }: ConfigContext): ExpoConfig => {
  requireGoogleIosBuildConfig();
  requireProductionR2BuildConfig();

  const plugins: ExpoConfig['plugins'] = [
    'expo-router',
    'expo-asset',
    [
      'expo-splash-screen',
      {
        backgroundColor: '#ffffff',
        image: './assets/logo-wordmark@3x.png',
        imageWidth: 320,
        resizeMode: 'contain',
        android: {
          // Android 12+ masks launch icons, which clips a wide wordmark. Keep
          // the native frame background-only and let SplashGate render the
          // same full-size wordmark used throughout React/auth loading.
          backgroundColor: '#fafaf9',
          image: './assets/android-splash-placeholder.png',
          imageWidth: 1,
          dark: {
            backgroundColor: '#161412',
            image: './assets/android-splash-placeholder.png',
          },
        },
      },
    ],
    // Build-time font embed (variable Inter). Synchronous availability, no
    // runtime useFonts/splash-gate (rules 1/24). The plugin needs explicit
    // .ttf paths — it does not expand globs. Family registers as "Inter";
    // font-medium/semibold/bold keep working via fontWeight on the wght axis.
    ['expo-font', { fonts: ['./assets/fonts/Inter-Variable.ttf'] }],
    [
      'expo-audio',
      {
        microphonePermission:
          'Allow Captivet to access your microphone to record appointments.',
        enableBackgroundRecording: true,
      },
    ],
    'expo-secure-store',
    [
      'expo-local-authentication',
      {
        faceIDPermission:
          'Allow Captivet to use Face ID to secure your account.',
      },
    ],
    // Sentry — native crash reporting + source map upload.
    // DSN injected at runtime via EXPO_PUBLIC_SENTRY_DSN; the plugin itself
    // configures native SDKs + source-map upload during EAS build.
    '@sentry/react-native/expo',
    // FFmpeg for on-device audio trimming and waveform extraction
    ['@config-plugins/ffmpeg-kit-react-native', { package: 'min' }],
    // iOS-only: override CocoaPods trunk resolution of ffmpeg-kit-ios-min
    // with our self-hosted podspec (mirrors the Android Maven self-host).
    // Required post arthenica sunset — see plugins/with-ffmpeg-ios-pod-source.js.
    './plugins/with-ffmpeg-ios-pod-source.js',
    // Native share sheet for generated PDF exports.
    'expo-sharing',
    // Native Apple Sign-In (iOS only at runtime; plugin adds the capability).
    'expo-apple-authentication',
    // Android: disable cleartext (HTTP) traffic in production,
    // enable backup encryption, and configure iOS hardening.
    // extraMavenRepos: Gradle 9 ignores project-level repos declared by
    // ffmpeg-kit-react-native — must redeclare Maven Central at settings level.
    [
      'expo-build-properties',
      {
        android: {
          usesCleartextTraffic: IS_DEV, // Only allow HTTP in dev
          enableMinifyInReleaseBuilds: true, // R8 code shrinking (replaces deprecated enableProguardInReleaseBuilds)
          enableShrinkResourcesInReleaseBuilds: true, // strip unreferenced res/ entries (requires minify)
          allowBackup: false, // Prevent unencrypted backup extraction
          minSdkVersion: 24, // Required by ffmpeg-kit-react-native
          extraProguardRules:
            '-dontwarn expo.modules.core.interfaces.services.KeepAwakeManager',
          extraMavenRepos: [
            'https://homeless-pets-foundation.github.io/ffmpeg-kit-maven',
          ],
          useLegacyPackaging: false, // Required for 16 KB memory page alignment (Android 15+)
        },
        ios: {
          deploymentTarget: '15.1', // Drop support for older insecure iOS
        },
      },
    ],
  ];

  // Native Google Sign-In — iOS URL scheme required; skip plugin when not configured
  // (Android dev sessions don't need the iOS URL scheme registration).
  // iosUrlScheme is the reversed iOS client ID from Google Cloud Console,
  // set at EAS build time via EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME.
  if (process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME) {
    plugins.push([
      '@react-native-google-signin/google-signin',
      { iosUrlScheme: process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME },
    ]);
    // GoogleSignIn 9.x → AppCheckCore (Swift) requires modular headers on its
    // non-modular transitive deps (GoogleUtilities, RecaptchaInterop) to
    // integrate under the static-library framework build. Scoped here so
    // non-Google builds don't pull those pods in. See the plugin for details.
    plugins.push('./plugins/with-ios-modular-headers.js');
  }

  // Only include dev-client in development builds
  if (IS_DEV) {
    plugins.push('expo-dev-client');
  }

  return {
    ...config,
    name: IS_LOCAL_TEST ? 'Captivet Local' : 'Captivet',
    slug: 'vetsoap-mobile',
    scheme: IS_LOCAL_TEST ? 'captivet-local' : 'captivet',
    version: '1.13.16',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'automatic',
    ios: {
      supportsTablet: true,
      bundleIdentifier: IS_LOCAL_TEST
        ? 'com.captivet.mobile.local'
        : 'com.captivet.mobile',
      usesAppleSignIn: true,
      infoPlist: {
        NSMicrophoneUsageDescription:
          'Captivet needs microphone access to record veterinary appointments.',
        NSFaceIDUsageDescription:
          'Allow Captivet to use Face ID to secure your account.',
        // Pre-declare export compliance: app only uses standard HTTPS/TLS,
        // which is exempt. Skips the per-build ASC prompt for TestFlight.
        ITSAppUsesNonExemptEncryption: false,
        // Allow the microphone to keep capturing when the screen locks or the
        // app is backgrounded. Clinicians set the phone down during exam tasks
        // (bandaging, injections, restraint) and the recording must continue.
        UIBackgroundModes: ['audio'],
        // Enforce App Transport Security: require HTTPS for all connections
        NSAppTransportSecurity: IS_DEV
          ? undefined // Use Expo defaults in dev (allows localhost)
          : {
              NSAllowsArbitraryLoads: false,
              NSAllowsLocalNetworking: false,
            },
      },
    },
    android: {
      // Local release APKs install beside the Play-signed app so testing never
      // requires uninstalling production or wiping its recordings/session.
      package: IS_LOCAL_TEST ? 'com.captivet.mobile.local' : 'com.captivet.mobile',
      adaptiveIcon: {
        backgroundColor: '#0d8775',
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
      permissions: [
        'android.permission.USE_BIOMETRIC',
        'android.permission.USE_FINGERPRINT',
        // Background audio recording: expo-audio's foreground service keeps
        // the recorder alive when the screen locks. Requires the generic
        // FOREGROUND_SERVICE plus the microphone-typed permission (Android 14+),
        // POST_NOTIFICATIONS for the persistent service notification (API 33+),
        // and WAKE_LOCK so the CPU doesn't sleep mid-capture.
        'android.permission.FOREGROUND_SERVICE',
        'android.permission.FOREGROUND_SERVICE_MICROPHONE',
        'android.permission.POST_NOTIFICATIONS',
        'android.permission.WAKE_LOCK',
      ],
      blockedPermissions: [
        // Explicitly block permissions we don't need
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.CAMERA',
        // Google Play rejected versionCode 45 under the photo/video
        // permissions policy. expo-screen-capture (still installed but now
        // unused — screen-capture prevention was removed; see CLAUDE.md
        // APP_VARIANT note) autolinks and declares READ_MEDIA_IMAGES for its
        // addScreenshotListener API (Android 13 only), which we never call.
        // VIDEO is blocked pre-emptively in case any transitive Android dep
        // adds it later.
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.READ_MEDIA_VIDEO',
      ],
      versionCode: 83,
    },
    web: {
      favicon: './assets/favicon.png',
    },
    plugins,
    extra: {
      eas: {
        projectId: 'ec4f66b0-2608-4d2a-82dd-8cc9bcfd0e23',
      },
      router: {},
      isProduction: IS_PRODUCTION || IS_LOCAL_TEST,
    },
    experiments: {
      typedRoutes: true,
    },
  };
};
