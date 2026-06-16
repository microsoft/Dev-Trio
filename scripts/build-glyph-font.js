// Dev-only build helper: bakes the Dev-Trio triad-loop mark into a single-glyph icon font
// (media/dev-trio-icons.ttf) so the status bar can render the SAME logo the Activity Bar uses.
// Not bundled and not shipped (scripts/** is excluded via .vscodeignore); only the .ttf ships.
// Run with: npm run icons:font
//
// Why a font at all: VS Code status bar text can only show registered icons via the $(id)
// syntax — it cannot point at an .svg. The Activity Bar accepts an SVG (media/icon-mono.svg),
// the status bar does not. Registering this glyph through contributes.icons lets us use
// $(dev-trio-logo) anywhere codicons are allowed, themed to the foreground like a codicon.
//
// The mark is rebuilt here as FILLS ONLY (icon-font glyphs ignore strokes). Geometry mirrors
// media/icon-mono.svg: a ring, three node dots on the ring, a center hub, and three spokes.
// The ring's small motion gap is dropped — at status-bar size a clean ring reads better.
const fs = require('fs');
const path = require('path');
const SVGPath = require('svgpath');
const svg2ttf = require('svg2ttf');

const repoRoot = path.join(__dirname, '..');
const outPath = path.join(repoRoot, 'media', 'dev-trio-icons.ttf');

// --- Mark geometry, authored in a 0..200 Y-down space (same coordinates as icon-mono.svg) ---
const C = { x: 100, y: 100 }; // center hub
const NODES = [
  { x: 100, y: 22 }, // top
  { x: 168, y: 139 }, // lower-right
  { x: 32, y: 139 } // lower-left
];
const RING_R = 78; // ring centerline radius
const RING_W = 11; // ring + spoke stroke width in the original
const NODE_R = 20; // node dot radius
const HUB_R = 15; // center hub radius

const half = RING_W / 2;
const ringOuter = RING_R + half; // 83.5
const ringInner = RING_R - half; // 72.5

/** A filled circle as a 2-arc subpath. sweep 0 = "solid" winding; sweep 1 = opposite ("hole"). */
function circle(cx, cy, r, sweep) {
  return (
    `M${cx - r},${cy} a${r},${r} 0 1,${sweep} ${2 * r},0 ` +
    `a${r},${r} 0 1,${sweep} ${-2 * r},0 Z`
  );
}

/** A filled rectangle (the spoke) from the hub to a node, width RING_W, wound to match solids. */
function spoke(node) {
  const dx = node.x - C.x;
  const dy = node.y - C.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  // Screen perpendicular; vertex order chosen so the spoke's winding matches the solid circles
  // (so overlaps reinforce under the nonzero fill rule instead of cancelling).
  const px = -uy * half;
  const py = ux * half;
  const p = (x, y) => `${round(x)},${round(y)}`;
  // Vertex order (hub side first) is chosen so the spoke's winding matches the solid circles
  // (sweep 0). Same winding => overlaps reinforce under the nonzero fill rule instead of
  // punching white notches where a spoke meets a node, the hub, or the ring.
  return (
    `M${p(C.x - px, C.y - py)} L${p(C.x + px, C.y + py)} ` +
    `L${p(node.x + px, node.y + py)} L${p(node.x - px, node.y - py)} Z`
  );
}

function round(n) {
  return Math.round(n * 1e4) / 1e4;
}

/** The triad mark as one fills-only path string in 0..200 Y-down space (nonzero fill rule). */
function buildRawD() {
  const subpaths = [
    circle(C.x, C.y, ringOuter, 0), // ring outer edge (solid)
    circle(C.x, C.y, ringInner, 1), // ring inner edge (hole)
    circle(C.x, C.y, HUB_R, 0), // center hub
    ...NODES.map((n) => circle(n.x, n.y, NODE_R, 0)), // node dots
    ...NODES.map((n) => spoke(n)) // spokes
  ];
  return subpaths.join(' ');
}

const EM = 1000;

function main() {
  const rawD = buildRawD();

  // --- Map the 0..200 Y-down art into the em, Y-up, centred with ~10% padding ---
  const PAD = 0.1;
  // Tight bounding box of the mark in art space (node dot tops/bottoms dominate vertically).
  const bbox = { minX: 12, maxX: 188, minY: 2, maxY: ringOuter + C.y };
  const artW = bbox.maxX - bbox.minX;
  const artH = bbox.maxY - bbox.minY;
  const scale = (EM * (1 - 2 * PAD)) / Math.max(artW, artH);
  const artCx = (bbox.minX + bbox.maxX) / 2;
  const artCy = (bbox.minY + bbox.maxY) / 2;
  // scale + flip Y, then translate the scaled art centre to the em centre.
  const tx = EM / 2 - artCx * scale;
  const ty = EM / 2 - -artCy * scale;
  const glyphD = SVGPath(rawD).scale(scale, -scale).translate(tx, ty).round(2).toString();

  // --- Wrap as an SVG font and convert to TTF ---
  const ascent = EM;
  const descent = 0;
  const svgFont =
    `<?xml version="1.0" standalone="no"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg"><defs>` +
    `<font id="dev-trio" horiz-adv-x="${EM}">` +
    `<font-face font-family="dev-trio" units-per-em="${EM}" ascent="${ascent}" descent="${descent}"/>` +
    `<missing-glyph horiz-adv-x="0"/>` +
    `<glyph glyph-name="dev-trio-logo" unicode="&#xE900;" horiz-adv-x="${EM}" d="${glyphD}"/>` +
    `</font></defs></svg>`;

  const ttf = svg2ttf(svgFont, { description: 'Dev-Trio icon font', version: '1.0' });
  fs.writeFileSync(outPath, Buffer.from(ttf.buffer));
  console.log(`wrote ${path.relative(repoRoot, outPath)} (${Buffer.from(ttf.buffer).length} bytes)`);
}

// Exposed so the geometry can be previewed/validated from the same source of truth.
module.exports = { buildRawD, EM };

if (require.main === module) {
  main();
}
