// Renders the preview pictures for Settings -> Unlocked looks (looks/<id>.png): each effect on a plain hole,
// in front of a dark grid so the bending shows. Run after changing an effect:
//   node_modules\electron\dist\electron.exe tools\make-previews.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'looks');
const N = 360;   // rendered size; saved at half
const IDS = ['none', 'jets', 'debris', 'photon', 'hawking', 'companion', 'ripples', 'pixel', 'spiral', 'clumpy', 'banded', 'warped',
             'magnetic', 'glitch', 'white', 'wormhole', 'inverted', 'dust', 'stars', 'snow'];
// Effects that read best seen more from above, or that need a moment to get going.
const TILT = { jets: 18, debris: 24, companion: 24, spiral: 40, clumpy: 34, banded: 34, warped: 22, magnetic: 34 };
const WAIT = { ripples: 2600, dust: 2200, snow: 3000 };

async function render(id, only) {
  const w = new BrowserWindow({
    width: N, height: N, useContentSize: true, show: false, frame: false, backgroundColor: '#000000',
    webPreferences: { preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false },
  });
  const errors = [];
  w.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/Security Warning/.test(msg)) errors.push(msg); });
  const pet = { fx: id === 'none' ? [] : [id], spin: 0.8 };
  await w.loadFile(path.join(ROOT, 'index.html'), { query: { icon: 'black', bg: 'grid', demo: '1', size: '0.62', tilt: String(TILT[id] || 12), pet: JSON.stringify(pet) } });
  await new Promise(r => setTimeout(r, WAIT[id] || 1600));
  const img = await w.webContents.capturePage();
  w.destroy();
  fs.writeFileSync(path.join(OUT, `${id}.png`), img.resize({ width: N / 2, height: N / 2, quality: 'best' }).toPNG());
  console.log(id, errors.length ? `ERRORS: ${errors.join(' | ').slice(0, 2000)}` : 'ok');
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const only = process.argv.slice(2).filter(a => IDS.includes(a));
  for (const id of only.length ? only : IDS) await render(id);
  app.quit();
});
