const { withGradleProperties } = require('expo/config-plugins');

/**
 * Fix ffmpeg-kit-react-native Maven artifact version.
 *
 * The bundled gradle.properties sets ffmpegKit.android.lts.version=6.0-2,
 * but com.arthenica:ffmpeg-kit-min:6.0-2.LTS doesn't exist on Maven Central.
 * The correct version is 6.0 (resolves to com.arthenica:ffmpeg-kit-min:6.0.LTS).
 */
module.exports = function ffmpegVersionFix(config) {
  return withGradleProperties(config, (config) => {
    // Override the ffmpeg-kit version properties
    const props = config.modResults;

    // Remove any existing ffmpegKit version properties
    config.modResults = props.filter(
      (p) => p.type !== 'property' ||
        (p.key !== 'ffmpegKit.android.main.version' && p.key !== 'ffmpegKit.android.lts.version')
    );

    // Add corrected versions
    config.modResults.push(
      { type: 'property', key: 'ffmpegKit.android.main.version', value: '6.0' },
      { type: 'property', key: 'ffmpegKit.android.lts.version', value: '6.0' }
    );

    return config;
  });
};
