import { ExpoConfig, ConfigContext } from 'expo/config';

const IS_DEV = process.env.APP_VARIANT === 'development';
const IS_PRODUCTION = process.env.APP_VARIANT === 'production';

export default ({ config }: ConfigContext): ExpoConfig => {
  const plugins: ExpoConfig['plugins'] = [
    'expo-router',
    'expo-asset',
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
    [
      '@config-plugins/ffmpeg-kit-react-native',
      { package: 'min' },
    ],
    // iOS-only: override CocoaPods trunk resolution of ffmpeg-kit-ios-min
    // with our self-hosted podspec (mirrors the Android Maven self-host).
    // Required post arthenica sunset — see plugins/with-ffmpeg-ios-pod-source.js.
    './plugins/with-ffmpeg-ios-pod-source.js',
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
          enableProguardInReleaseBuilds: true,
          allowBackup: false, // Prevent unencrypted backup extraction
          minSdkVersion: 24, // Required by ffmpeg-kit-react-native
          extraProguardRules: '-dontwarn expo.modules.core.interfaces.services.KeepAwakeManager',
          extraMavenRepos: ['https://homeless-pets-foundation.github.io/ffmpeg-kit-maven'],
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
  }

  // Only include dev-client in development builds
  if (IS_DEV) {
    plugins.push('expo-dev-client');
  }

  return {
    ...config,
    name: 'Captivet',
    slug: 'vetsoap-mobile',
    scheme: 'captivet',
    version: '1.10.1',
    orientation: 'default',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    splash: {
      image: './assets/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#ffffff',
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.captivet.mobile',
      usesAppleSignIn: true,
      infoPlist: {
        NSMicrophoneUsageDescription:
          'Captivet needs microphone access to record veterinary appointments.',
        NSFaceIDUsageDescription:
          'Allow Captivet to use Face ID to secure your account.',
        // Pre-declare export compliance: app only uses standard HTTPS/TLS,
        // which is exempt. Skips the per-build ASC prompt for TestFlight.
        ITSAppUsesNonExemptEncryption: false,
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
      package: 'com.captivet.mobile',
      adaptiveIcon: {
        backgroundColor: '#0d8775',
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
      permissions: [
        'android.permission.USE_BIOMETRIC',
        'android.permission.USE_FINGERPRINT',
      ],
      blockedPermissions: [
        // Explicitly block permissions we don't need
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.CAMERA',
      ],
      versionCode: 1,
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
      isProduction: IS_PRODUCTION,
    },
    experiments: {
      typedRoutes: true,
    },
  };
};
