import { ExpoConfig, ConfigContext } from 'expo/config';

const IS_DEV = process.env.APP_VARIANT === 'development';
const IS_PRODUCTION = process.env.APP_VARIANT === 'production';

export default ({ config }: ConfigContext): ExpoConfig => {
  const plugins: ExpoConfig['plugins'] = [
    'expo-router',
    [
      'expo-av',
      {
        microphonePermission:
          'Allow VetSOAP to access your microphone to record appointments.',
      },
    ],
    'expo-secure-store',
    [
      'expo-local-authentication',
      {
        faceIDPermission:
          'Allow VetSOAP to use Face ID to secure your account.',
      },
    ],
    // Android: disable cleartext (HTTP) traffic in production,
    // enable backup encryption, and configure iOS hardening
    [
      'expo-build-properties',
      {
        android: {
          usesCleartextTraffic: IS_DEV, // Only allow HTTP in dev
          enableProguardInReleaseBuilds: true,
          allowBackup: false, // Prevent unencrypted backup extraction
        },
        ios: {
          deploymentTarget: '15.1', // Drop support for older insecure iOS
        },
      },
    ],
  ];

  // Only include dev-client in development builds
  if (IS_DEV) {
    plugins.push('expo-dev-client');
  }

  return {
    ...config,
    name: 'VetSOAP Mobile',
    slug: 'vetsoap-mobile',
    scheme: 'vetsoap-mobile',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    splash: {
      image: './assets/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#0d8775',
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.vetsoap.mobile',
      infoPlist: {
        NSMicrophoneUsageDescription:
          'VetSOAP needs microphone access to record veterinary appointments.',
        NSFaceIDUsageDescription:
          'Allow VetSOAP to use Face ID to secure your account.',
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
      package: 'com.vetsoap.mobile',
      adaptiveIcon: {
        backgroundColor: '#0d8775',
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
      permissions: [
        'android.permission.RECORD_AUDIO',
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
    },
    experiments: {
      typedRoutes: true,
    },
  };
};
