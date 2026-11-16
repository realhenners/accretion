// Renders the app icon from the real shader: the black hole alone, transparent around it.
// Run from the project folder:  npx electron tools/make-icon.js
// Writes icon.png (512 px) and icon.ico (16-256 px).
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const N = 512;

async function render(bg) {
  const w = new BrowserWindow({
    width: N, height: N, useContentSize: true, show: false, frame: false,
    backgroundColor: bg === 'white' ? '#ffffff' : '#000000',
    webPreferences: { preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false },
  });
  await w.loadFile(path.join(ROOT, 'index.html'), { query: { icon: bg, size: '1.35', tilt: '14' } });
  await new Promise(r => setTimeout(r, 1500));
  const img = await w.webContents.capturePage();
  w.destroy();
  return img.resize({ width: N, height: N }).toBitmap();   // BGRA
}

app.on('window-all-closed', () => {});   // the first render's window closing must not end the app
app.whenReady().then(async () => {
  // Rendered over black and over white: wherever the two differ, you're seeing the background, so the
  // difference is how transparent that pixel is. What's left is the hole and its disk, with true soft edges.
  const black = await render('black'), white = await render('white');
  const rgba = Buffer.alloc(N * N * 4);   // BGRA, premultiplied (what nativeImage bitmaps are)
  for (let i = 0; i < N * N; i++) {
    const o = i * 4;
    const seen = ((white[o] - black[o]) + (white[o + 1] - black[o + 1]) + (white[o + 2] - black[o + 2])) / (3 * 255);
    // The glowing gas adds light rather than covering what's behind it, so a pixel is at least as opaque as its
    // brightest channel. Premultiplied, its colour is then exactly the light seen over black.
    const a = Math.max(Math.min(Math.max(1 - seen, 0), 1), Math.max(black[o], black[o + 1], black[o + 2]) / 255);
    // The icon is framed on the shadow and inner disk; the outer disk fades away toward the corners
    // instead of being cut off by the square, so small sizes still read as a black hole.
    const dx = (i % N) / (N / 2) - 1, dy = ((i / N) | 0) / (N / 2) - 1, r = Math.hypot(dx, dy * 1.35);
    const v = 1 - Math.min(Math.max((r - 0.55) / 0.42, 0), 1) ** 1.5;
    for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(black[o + c] * v);
    rgba[o + 3] = Math.round(a * v * 255);
  }
  const icon = nativeImage.createFromBitmap(rgba, { width: N, height: N });
  fs.writeFileSync(path.join(ROOT, 'icon.png'), icon.toPNG());

  // .ico: a directory of PNG images, one per size.
  const sizes = [256, 128, 64, 48, 32, 24, 16];
  const pngs = sizes.map(s => icon.resize({ width: s, height: s, quality: 'best' }).toPNG());
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, k) => {
    const e = 6 + 16 * k;
    head.writeUInt8(s >= 256 ? 0 : s, e); head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[k].length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += pngs[k].length;
  });
  fs.writeFileSync(path.join(ROOT, 'icon.ico'), Buffer.concat([head, ...pngs]));
  console.log('icon.png and icon.ico written');
  app.quit();
});
