#!/usr/bin/env node
/**
 * Generates all app icon, splash, and branding assets from the source logo.
 *
 * Usage: node scripts/generate-icons.mjs
 * Requires: sharp (npm install --save-dev sharp)
 */
import sharp from 'sharp';
import { Buffer } from 'node:buffer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const SOURCE_LOGO = path.join(ROOT, 'docs', 'Captivet Logo.png');

const TEAL = '#0d8775';

// Bold "C" lettermark SVG — matches the Captivet wordmark style
function lettermarkSvg(size, color = '#ffffff') {
  const fontSize = Math.round(size * 0.55);
  return Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle"
        font-family="Arial, Helvetica, sans-serif" font-weight="bold"
        font-size="${fontSize}" fill="${color}">C</text>
</svg>`);
}

async function generateIcon() {
  // 1024x1024 teal square with white "C"
  const bg = sharp({
    create: { width: 1024, height: 1024, channels: 4, background: TEAL },
  }).png();

  const cOverlay = lettermarkSvg(1024);
  const icon = await bg.composite([{ input: cOverlay, blend: 'over' }]).png().toBuffer();
  await sharp(icon).toFile(path.join(ASSETS, 'icon.png'));
  console.log('  icon.png (1024x1024)');
  return icon;
}

async function generateFavicon(iconBuf) {
  await sharp(iconBuf).resize(48, 48).toFile(path.join(ASSETS, 'favicon.png'));
  console.log('  favicon.png (48x48)');
}

async function generateSplashIcon() {
  // Trim the source logo, then place on a 1024x1024 white square
  const trimmed = await sharp(SOURCE_LOGO).trim().toBuffer();
  const meta = await sharp(trimmed).metadata();

  // Scale to fit within 80% of 1024 = ~820px wide
  const maxDim = 820;
  let resizeW, resizeH;
  if (meta.width >= meta.height) {
    resizeW = maxDim;
    resizeH = Math.round((meta.height / meta.width) * maxDim);
  } else {
    resizeH = maxDim;
    resizeW = Math.round((meta.width / meta.height) * maxDim);
  }

  const resized = await sharp(trimmed).resize(resizeW, resizeH).toBuffer();

  await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: '#ffffff' },
  })
    .png()
    .composite([{ input: resized, gravity: 'centre' }])
    .toFile(path.join(ASSETS, 'splash-icon.png'));
  console.log('  splash-icon.png (1024x1024)');
}

async function generateAdaptiveIcons() {
  // Foreground: white "C" on transparent, in 66% safe zone (512x512, letter in ~338px center)
  const fgSize = 512;
  const letterSize = Math.round(fgSize * 0.66);
  const offset = Math.round((fgSize - letterSize) / 2);

  const cSvg = lettermarkSvg(letterSize, '#ffffff');
  const cBuf = await sharp(cSvg).resize(letterSize, letterSize).png().toBuffer();

  await sharp({
    create: { width: fgSize, height: fgSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .composite([{ input: cBuf, left: offset, top: offset }])
    .toFile(path.join(ASSETS, 'android-icon-foreground.png'));
  console.log('  android-icon-foreground.png (512x512)');

  // Background: solid teal
  await sharp({
    create: { width: fgSize, height: fgSize, channels: 4, background: TEAL },
  })
    .png()
    .toFile(path.join(ASSETS, 'android-icon-background.png'));
  console.log('  android-icon-background.png (512x512)');

  // Monochrome: white "C" on transparent (Android tints it)
  const monoSize = 432;
  const monoLetterSize = Math.round(monoSize * 0.66);
  const monoOffset = Math.round((monoSize - monoLetterSize) / 2);
  const monoCSvg = lettermarkSvg(monoLetterSize, '#ffffff');
  const monoCBuf = await sharp(monoCSvg).resize(monoLetterSize, monoLetterSize).png().toBuffer();

  await sharp({
    create: { width: monoSize, height: monoSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .composite([{ input: monoCBuf, left: monoOffset, top: monoOffset }])
    .toFile(path.join(ASSETS, 'android-icon-monochrome.png'));
  console.log('  android-icon-monochrome.png (432x432)');
}

async function generateWordmarks() {
  const trimmed = await sharp(SOURCE_LOGO).trim().toBuffer();
  const meta = await sharp(trimmed).metadata();
  const aspect = meta.width / meta.height;

  // 3x: ~1800w (based on 600 * 3)
  const w3x = 1800;
  const h3x = Math.round(w3x / aspect);
  await sharp(trimmed).resize(w3x, h3x).toFile(path.join(ASSETS, 'logo-wordmark@3x.png'));
  console.log(`  logo-wordmark@3x.png (${w3x}x${h3x})`);

  // 2x: ~1200w
  const w2x = 1200;
  const h2x = Math.round(w2x / aspect);
  await sharp(trimmed).resize(w2x, h2x).toFile(path.join(ASSETS, 'logo-wordmark@2x.png'));
  console.log(`  logo-wordmark@2x.png (${w2x}x${h2x})`);

  // 1x: ~600w
  const w1x = 600;
  const h1x = Math.round(w1x / aspect);
  await sharp(trimmed).resize(w1x, h1x).toFile(path.join(ASSETS, 'logo-wordmark.png'));
  console.log(`  logo-wordmark.png (${w1x}x${h1x})`);
}

async function main() {
  console.log('Generating app assets from:', SOURCE_LOGO);
  console.log('');

  console.log('App icon:');
  const iconBuf = await generateIcon();

  console.log('Favicon:');
  await generateFavicon(iconBuf);

  console.log('Splash screen:');
  await generateSplashIcon();

  console.log('Android adaptive icons:');
  await generateAdaptiveIcons();

  console.log('Wordmark variants:');
  await generateWordmarks();

  console.log('');
  console.log('Done! All assets written to assets/');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
