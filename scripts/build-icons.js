// Dev-only build helper: rasters the brand SVGs into the shipped PNG icons.
// Not bundled and not shipped (excluded via .vscodeignore). Run with: npm run icons:build
//
// Alpha discipline: every raster from a transparent-corner SVG MUST stay RGBA with
// genuinely transparent corners. We therefore NEVER call .flatten() (which composites
// alpha against a background and drops it); we set a fully-transparent resize background
// and force RGBA out via .ensureAlpha() before encoding.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const mediaDir = path.join(repoRoot, 'media');

const DENSITY = 384;

/**
 * Raster an SVG to a square PNG preserving transparency. The mark fills the square;
 * any region the SVG leaves transparent (e.g. outside a rounded tile) stays alpha-0.
 */
async function rasterTransparent(svgBuf, size, outPath) {
  await sharp(svgBuf, { density: DENSITY })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(`wrote ${path.relative(repoRoot, outPath)} (${size}x${size}, RGBA)`);
}

async function main() {
  // --- Color rounded-tile icon (transparent corners) ---
  const colorSvg = fs.readFileSync(path.join(mediaDir, 'icon-color.svg'));
  await rasterTransparent(colorSvg, 128, path.join(mediaDir, 'icon-128.png'));
  await rasterTransparent(colorSvg, 512, path.join(mediaDir, 'icon.png'));

  // --- Monochrome glyph (transparent background) ---
  // The shipped SVG uses currentColor so VS Code can theme it. For the raster we ink it
  // a fixed dark (#1E1E1E) by substituting the color token in memory only (the source file
  // is left untouched). Same alpha-preserving pipeline, so corners stay transparent.
  const monoSvgText = fs.readFileSync(path.join(mediaDir, 'icon-mono.svg'), 'utf8');
  const monoInked = Buffer.from(monoSvgText.split('currentColor').join('#1E1E1E'), 'utf8');
  await rasterTransparent(monoInked, 32, path.join(mediaDir, 'icon-mono-32.png'));

  // --- Full-bleed color variant (no transparent corners) ---
  // The source SVG paints the entire square, so the SAME alpha-preserving pipeline yields
  // opaque gradient corners (alpha 255) naturally — no flatten needed. The result is RGBA
  // but fully opaque, which is correct for this variant.
  const fullbleedSvg = fs.readFileSync(path.join(mediaDir, 'icon-color-fullbleed.svg'));
  await rasterTransparent(fullbleedSvg, 128, path.join(mediaDir, 'icon-128-fullbleed.png'));
  await rasterTransparent(fullbleedSvg, 512, path.join(mediaDir, 'icon-512-fullbleed.png'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
