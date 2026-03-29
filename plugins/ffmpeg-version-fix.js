const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Fix ffmpeg-kit-react-native Maven artifact version.
 *
 * The bundled gradle.properties sets ffmpegKit.android.lts.version=6.0-2,
 * but com.arthenica:ffmpeg-kit-min:6.0-2.LTS doesn't exist on Maven Central.
 * The correct version is 6.0 (resolves to com.arthenica:ffmpeg-kit-min:6.0.LTS).
 *
 * This plugin patches the module's own gradle.properties during prebuild.
 */
module.exports = function ffmpegVersionFix(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const gradlePropsPath = path.join(
        config.modRequest.projectRoot,
        'node_modules',
        'ffmpeg-kit-react-native',
        'android',
        'gradle.properties'
      );

      if (fs.existsSync(gradlePropsPath)) {
        let content = fs.readFileSync(gradlePropsPath, 'utf8');
        content = content.replace(
          /ffmpegKit\.android\.main\.version=.*/,
          'ffmpegKit.android.main.version=6.0'
        );
        content = content.replace(
          /ffmpegKit\.android\.lts\.version=.*/,
          'ffmpegKit.android.lts.version=6.0'
        );
        fs.writeFileSync(gradlePropsPath, content);
      }

      return config;
    },
  ]);
};
