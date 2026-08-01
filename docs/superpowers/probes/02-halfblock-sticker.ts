// Proof that Telegram stickers can be rendered in Alacritty with no image
// protocol: decode -> resize -> Unicode half-blocks in truecolor.
// Each cell prints "▀" with fg = top pixel, bg = bottom pixel => 2px per cell.
import sharp from "sharp";

const BG = { r: 0x08, g: 0x08, b: 0x08 }; // devglow sage BACKGROUND

// A stand-in "sticker": transparent PNG/WebP with soft gradients and curves,
// which is the hard case for half-block rendering.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
  <defs>
    <radialGradient id="face" cx="42%" cy="34%" r="72%">
      <stop offset="0%"  stop-color="#F5D98B"/>
      <stop offset="62%" stop-color="#EBC17A"/>
      <stop offset="100%" stop-color="#B5894A"/>
    </radialGradient>
    <radialGradient id="cheek" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#D68C8C" stop-opacity=".85"/>
      <stop offset="100%" stop-color="#D68C8C" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <circle cx="200" cy="205" r="165" fill="url(#face)"/>
  <ellipse cx="118" cy="242" rx="38" ry="26" fill="url(#cheek)"/>
  <ellipse cx="282" cy="242" rx="38" ry="26" fill="url(#cheek)"/>
  <ellipse cx="148" cy="168" rx="19" ry="26" fill="#181818"/>
  <ellipse cx="252" cy="168" rx="19" ry="26" fill="#181818"/>
  <circle cx="155" cy="158" r="7" fill="#FFFFFF"/>
  <circle cx="259" cy="158" r="7" fill="#FFFFFF"/>
  <path d="M132 252 Q200 320 268 252" stroke="#7A4A32" stroke-width="15"
        fill="none" stroke-linecap="round"/>
  <path d="M150 250 Q200 300 250 250" fill="#924653" opacity=".55"/>
</svg>`;

// Round-trip through real WebP: that is the actual on-the-wire sticker format.
const webp = await sharp(Buffer.from(svg)).webp({ lossless: true }).toBuffer();
console.log(`encoded test sticker as WebP: ${webp.length} bytes\n`);

async function renderHalfBlocks(buf: Buffer, cols: number): Promise<string> {
  const meta = await sharp(buf).metadata();
  const aspect = (meta.height ?? 1) / (meta.width ?? 1);
  // Terminal cells are ~2x taller than wide; half-blocks give 2 rows of pixels
  // per cell, so a square image maps to cols x cols pixel rows.
  const rows = Math.max(2, Math.round(cols * aspect));
  const { data } = await sharp(buf)
    .resize(cols, rows * 2, { fit: "fill", kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const px = (x: number, y: number) => {
    const i = (y * cols + x) * 4;
    const a = data[i + 3] / 255;
    // Composite over the terminal background so transparency looks right.
    return {
      r: Math.round(data[i] * a + BG.r * (1 - a)),
      g: Math.round(data[i + 1] * a + BG.g * (1 - a)),
      b: Math.round(data[i + 2] * a + BG.b * (1 - a)),
    };
  };

  let out = "";
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = px(x, y * 2);
      const b = px(x, y * 2 + 1);
      out += `\x1b[38;2;${t.r};${t.g};${t.b}m\x1b[48;2;${b.r};${b.g};${b.b}m▀`;
    }
    out += "\x1b[0m\n";
  }
  return out;
}

for (const cols of [16, 24, 34]) {
  console.log(`\x1b[38;2;125;185;182m── ${cols} cells wide ──\x1b[0m`);
  console.log(await renderHalfBlocks(webp, cols));
}
