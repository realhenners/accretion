const { app, BrowserWindow, screen, ipcMain, globalShortcut, Menu, Tray, nativeImage, shell, systemPreferences, nativeTheme, dialog, powerMonitor,
        clipboard, desktopCapturer, session, net, crashReporter } = require('electron');
// Crash dumps are kept on this PC only (never uploaded); see also crash-reports\ (Settings -> Help).
crashReporter.start({ uploadToServer: false });
const zlib = require('zlib');
const os = require('os');
const { readModel, zipEntries, MODEL } = require('./contents');
// Laptops with two GPUs: run on the fast one (the ray tracing is all GPU work).
app.commandLine.appendSwitch('force_high_performance_gpu');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Opening Accretion again doesn't start a second app: it adds another black hole to this one (see 'second-instance'),
// so the holes share one simulation and can pull on each other.
if (!app.requestSingleInstanceLock()) app.exit(0);
else app.whenReady().then(start);

// How long a full evaporation runs (EVAPORATE + BURST in index.html), plus slack, before quitting regardless.
const DEATH_MS = 4750;
const PRELOAD = path.join(__dirname, 'preload.js');
const ICON = path.join(__dirname, 'icon.ico');   // rendered from the shader by tools/make-icon.js
// Installed, the helper lives next to the app's resources (it can't run from inside the app archive).
const HELPER = app.isPackaged ? path.join(process.resourcesPath, 'capture', 'ScreenCapture.exe') : path.join(__dirname, 'capture', 'ScreenCapture.exe');

// --- log file: %APPDATA%\Accretion\logs\accretion.log (one previous file kept as .old) ---
let logFile = null;
function log(level, ...parts) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${parts.map(p => p instanceof Error ? p.stack : String(p)).join(' ')}\n`;
  (level === 'error' ? process.stderr : process.stdout).write(line);
  if (!logFile) return;
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1_000_000) fs.renameSync(logFile, logFile + '.old');
    fs.appendFileSync(logFile, line);
  } catch { /* logging must never take the app down */ }
}

// --- crash reports: kept on this PC only, never sent anywhere (Settings -> Help shows them) ---
function crashReport(what, details) {
  try {
    const dir = path.join(app.getPath('userData'), 'crash-reports');
    fs.mkdirSync(dir, { recursive: true });
    let tail = '';
    try { tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-80).join('\n'); } catch { }
    fs.writeFileSync(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.txt`),
      `Accretion crash report\n\nWhat: ${what}\nWhen: ${new Date().toString()}\nVersion: ${app.getVersion()} (Electron ${process.versions.electron}, Windows ${os.release()})\n\nDetails:\n${typeof details === 'string' ? details : JSON.stringify(details, null, 2)}\n\nLast lines of the log:\n${tail}\n`);
    for (const f of fs.readdirSync(dir).sort().slice(0, -30)) fs.unlinkSync(path.join(dir, f));   // keep the latest 30
  } catch { /* never let a crash report cause another */ }
}

// --- settings, remembered between launches ---
const DEFAULTS = {
  look: 'classic',        // classic | quiet | thin | blazing
  size: 1,                // overall scale
  diskColor: '#ff280a',
  diskTemp: 0.5,          // 0 cool and dim .. 1 hot and bright
  thickness: 0.06,        // disk scale height H/r: real thin disks are about 0.01-0.1
  tilt: 7,                // degrees the disk is tipped toward you
  spinSpeed: 1,           // how fast the disk orbits
  bhSpin: 0.7,            // black hole spin a/M (0 = Schwarzschild, 0.99 = near-extremal Kerr)
  bloom: 0.5,             // glow around bright light, like a camera lens
  motionBlur: true,
  einsteinStar: true,     // a distant star exactly behind each hole, lensed into an Einstein ring
  sound: true,
  volume: 0.5,
  idle: 'slow',           // when nothing moves: 'slow' (low frame rate) or 'freeze'
  captureRate: 60,        // desktop grabs per second
  looks: {},              // saved looks, by name
  quality: 'auto',        // render resolution: auto | high | balanced | performance
  lastHoles: null,        // holes at last exit: position, mass, their own settings
  retroSkin: false,       // (old) the pixel-art look; now 'pixel' in fx
  fx: [],                 // unlocked effects switched on (index.html FX), for every hole unless one has its own
  danceToMusic: true,     // dance to music playing on the PC
  startWithWindows: false,
  achievements: {},       // id -> when it was earned
  counters: {},           // things counted toward achievements
  grade: 'natural',       // colour grade of the light: natural | filmic | warm | falsecolor | mono
  dopplerColor: true,     // gas coming toward you looks bluer, going away redder
  soundTheme: 'hum',      // hum | sonification
  evaporate: false,       // unfed for days, it slowly shrinks (Hawking radiation, sped up)
  playWithWindows: true,  // bored, it bats small windows a few pixels (and back)
  reduceMotion: false,    // no wobble, sway, ripples or stutter
  largeLabels: false,     // bigger, higher-contrast mood tags and messages
  profiles: {},           // saved sets of settings, by name
  monitorRules: {},       // display id -> { allow: false } to keep black holes off it
  journal: {},            // hole uid -> { 'YYYY-MM-DD': what it did that day }
  tourDone: false,        // the first-launch tour has been seen
  castShadow: true,       // a soft shadow under the disk on whatever is behind
  blueprint: false,       // draw the light paths around each hole, like a technical drawing
  compactSettings: false, // the Settings window, smaller
  autoUpdate: true,       // installed copies check GitHub Releases for updates
  memories: {},           // hole uid -> { label, v }: the biggest thing it ate (its picture is in userData\memories)
};
const LOOK_KEYS = ['look', 'diskColor', 'diskTemp', 'thickness', 'tilt', 'spinSpeed', 'bhSpin', 'bloom', 'einsteinStar', 'retroSkin', 'fx', 'grade', 'dopplerColor', 'castShadow'];
const GRADES = ['natural', 'filmic', 'warm', 'falsecolor', 'mono'];
const RARES = ['albino', 'twin', 'speedy', 'ringed', 'glimmer'];
const FX_IDS = ['jets', 'debris', 'photon', 'hawking', 'companion', 'ripples', 'pixel', 'spiral', 'clumpy', 'banded', 'warped',
                'magnetic', 'glitch', 'white', 'wormhole', 'inverted', 'dust', 'stars', 'snow'];
// What makes a hole itself, kept between launches and carried in share codes (index.html newHole reads them).
const PET_KEYS = ['name', 'born', 'spin', 'appetite', 'uid', 'trait', 'pinned', 'bonds', 'parentUid', 'baby', 'lineage', 'children', 'trophies', 'stats', 'trust',
                  'lastFed', 'lastTouch', 'sulking', 'rare', 'tastes', 'rivals', 'fear', 'hobby'];
const TRAITS = ['greedy', 'shy', 'lazy', 'playful', 'clingy'];
// Achievements. Hidden ones show as ??? until someone stumbles on them.
const ACH = [
  { id: 'first', name: 'First bite', desc: 'Feed it anything.' },
  { id: 'big', name: 'Big appetite', desc: 'Feed it a window bigger than 2560 × 1440.' },
  { id: 'hundred', name: 'Bottomless', desc: 'Feed it 100 things.' },
  { id: 'tde', name: 'Star eater', desc: 'Let it tear a star apart (Shift + double-click).' },
  { id: 'merger', name: 'Two become one', desc: 'Merge two black holes.' },
  { id: 'baby', name: 'It’s a hole!', desc: 'A big meal leaves a little one behind.' },
  { id: 'grown', name: 'All grown up', desc: 'A baby grows up.' },
  { id: 'friends', name: 'Best friends', desc: 'Two black holes become friends.' },
  { id: 'purr', name: 'Purr', desc: 'Pet it for a whole minute, all told.' },
  { id: 'spin', name: 'Maximum spin', desc: 'Spin one up to 0.99 by feeding it.' },
  { id: 'heavy', name: 'Supermassive', desc: 'Grow one as big as it gets.' },
  { id: 'week', name: 'One week old', desc: 'Keep one for a week.' },
  { id: 'adopted', name: 'Long-distance', desc: 'Add a black hole from a share code.' },
  { id: 'shared', name: 'Show-off', desc: 'Make a share card.' },
  { id: 'night', name: 'Midnight snack', desc: 'Feed it between 2 and 4 in the morning.', hidden: true },
  { id: 'recycle', name: 'Nothing is lost', desc: 'Feed it the Recycle Bin twice.', hidden: true },
  { id: 'shaken', name: 'Motion sickness', desc: 'Shake it hard.', hidden: true },
  { id: 'self', name: '...no.', desc: 'Try to feed it itself.', hidden: true },
  { id: 'retro', name: 'Up, up, down, down', desc: 'You know the one.', hidden: true },
  { id: 'dance', name: 'Disco', desc: 'Let it dance to music for five minutes.', hidden: true },
  { id: 'season', name: 'Cold snap', desc: 'Have Accretion running in winter (November to February).' },
  { id: 'rare', name: 'Rare find', desc: 'A black hole is born with a rare trait.' },
  { id: 'rivals', name: 'Rivals', desc: 'Two black holes steal from each other so often they fall out.', hidden: true },
  { id: 'picture', name: 'Worth a thousand words', desc: 'Feed it a picture.' },
  { id: 'shakedown', name: 'Shakedown', desc: 'Turn it upside down and shake until something falls out.' },
  { id: 'hobby', name: 'A hobby', desc: 'A black hole takes up a hobby.' },
  { id: 'jealous', name: 'Green with envy', desc: 'Pet one black hole while another one watches.' },
  { id: 'grooming', name: 'Grooming', desc: 'Two friends tidy each other\'s disks.' },
  { id: 'majortom', name: 'Lift-off', desc: 'It heard a certain song about space.', hidden: true },
  { id: 'horizon', name: 'Point of no return', desc: 'Type the words.', hidden: true },
  { id: 'nothing', name: 'Something', desc: 'Feed it nothing.', hidden: true },
  { id: 'hello', name: 'Hello', desc: 'Say it.', hidden: true },
  { id: 'syzygy', name: 'Syzygy', desc: 'Line two black holes up.', hidden: true },
  { id: 'cousin', name: 'Family resemblance', desc: 'Show it a picture of one of its own.', hidden: true },
  { id: 'bred', name: 'Matchmaker', desc: 'Breed a baby from two share codes.' },
  { id: 'eddington', name: 'Eddington limit', desc: 'Feed it so much, so fast, that its own light blows the rest back out.', hidden: true },
  { id: 'thief', name: 'Thief', desc: 'One black hole steals another\'s meal.', hidden: true },
];
let settings = structuredClone(DEFAULTS);
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); }
  catch (e) { if (e.code !== 'ENOENT') log('warn', 'settings unreadable, using defaults:', e.message); }
}
function saveSettingsNow() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) { log('error', 'could not save settings:', e.message); }
}
let saveTimer;
const saveSettings = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveSettingsNow, 400); };

// A queue of incoming bytes that can be read in exact amounts without re-copying everything on every chunk.
class ByteQueue {
  constructor() { this.chunks = []; this.length = 0; }
  push(b) { this.chunks.push(b); this.length += b.length; }
  read(n) {
    const out = Buffer.allocUnsafe(n);
    let o = 0;
    while (o < n) {
      const c = this.chunks[0], k = Math.min(c.length, n - o);
      c.copy(out, o, 0, k); o += k;
      if (k === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(k);
    }
    this.length -= n;
    return out;
  }
  peekInt32(off) {   // little-endian int32 at offset off (only ever called with off + 4 <= length)
    const b = Buffer.alloc(4);
    let i = 0, pos = 0;
    for (const c of this.chunks) {
      for (let j = 0; j < c.length && i < 4; j++, pos++) if (pos >= off) b[i++] = c[j];
      if (i === 4) break;
    }
    return b.readInt32LE(0);
  }
}

function start() {
  fs.mkdirSync(path.join(app.getPath('userData'), 'logs'), { recursive: true });
  logFile = path.join(app.getPath('userData'), 'logs', 'accretion.log');
  log('info', `Accretion starting (Electron ${process.versions.electron}, ${os.release()})`);
  loadSettings();

  const wins = new Map();   // display id -> overlay window
  let leader = null;        // the overlay that runs the physics for every hole
  let lastState = null;     // its latest state, so a new leader or new monitor can pick up seamlessly
  let settingsWin = null, shareWin = null, tray = null;
  let dying = false, hidden = false, paused = false, lastStateAt = Date.now();
  const update = { state: app.isPackaged ? 'idle' : 'dev', version: null, percent: 0, error: null };   // see Updates, below
  let updater = null;
  let stats = { fps: 0, cpu: 0 }, holesSentAt = 0;

  const overlays = () => [...wins.values()].filter(w => !w.isDestroyed());
  const pages = () => [...overlays(), ...(shareWin && !shareWin.isDestroyed() ? [shareWin] : [])].map(w => w.webContents);
  const broadcast = (ch, ...a) => { for (const wc of pages()) wc.send(ch, ...a); };
  const cursor = () => screen.dipToScreenPoint(screen.getCursorScreenPoint());   // physical px
  const toLeader = msg => leader && !leader.isDestroyed() && leader.send('input', { ...msg, cursor: cursor() });
  const displaysInfo = () => {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map(d => ({
      id: d.id, primary: d.id === primary, scale: d.scaleFactor, hz: d.displayFrequency || 60,
      phys: screen.dipToScreenRect(null, d.bounds),
    }));
  };
  const originOf = w => { const r = screen.dipToScreenRect(w, w.getBounds()); return { x: r.x, y: r.y }; };

  // =====================  helpers (native)  =====================
  // Capture: pages ask for one region at a time; replies come back in order, so a queue says whose reply is next.
  // A reply is either the whole region, "unchanged", or just the rectangles that changed.
  let cap, waiting = [];
  function startCapture() {
    cap = spawn(HELPER);
    waiting = [];
    const q = new ByteQueue();
    let cpuMs = null;
    cap.stdout.on('data', d => {
      q.push(d);
      for (;;) {
        if (q.length < 20) return;
        const w = q.peekInt32(8), h = q.peekInt32(12), n = q.peekInt32(16);
        let need = 20;
        if (n === -1) need += w * h * 4;
        else for (let i = 0, o = 20; i < n; i++) {
          if (q.length < o + 16) return;
          const rw = q.peekInt32(o + 8), rh = q.peekInt32(o + 12);
          o += 16 + rw * rh * 4;
          need = o;
        }
        if (q.length < need) return;
        const msg = q.read(need);
        const entry = waiting.shift();
        const args = [msg.readInt32LE(0), msg.readInt32LE(4), w, h, n, msg.subarray(20)];
        if (!entry) continue;
        if (entry.cb) entry.cb(...args);
        else if (!entry.wc.isDestroyed()) entry.wc.send(entry.kind === 'shot' ? 'shot-frame' : 'frame', ...args);
      }
    });
    cap.stderr.on('data', d => {
      for (const line of String(d).split(/\r?\n/).filter(Boolean)) {
        const m = /^STAT (\d+)/.exec(line);
        if (m) { const ms = +m[1]; if (cpuMs !== null) stats.helperCpu = (ms - cpuMs) / 10 / os.cpus().length; cpuMs = ms; }
        else log('warn', '[capture]', line);
      }
    });
    cap.on('exit', code => {
      if (dying) return;
      log('error', `capture helper exited (${code}); restarting`);
      for (const e of waiting) if (e.cb) e.cb(0, 0, 0, 0, 0, Buffer.alloc(0));
      setTimeout(startCapture, 1000);
    });
  }
  startCapture();
  const capture = (x, y, w, h, force) => cap.stdin.write(`${force ? 'F' : ''}${x | 0} ${y | 0} ${w | 0} ${h | 0}\n`);
  // kind: 'lens' (changes only), 'full' (whole region, after a page lost track), 'shot' (whole region, for a screenshot)
  ipcMain.on('next-frame', (e, x, y, w, h, kind) => { waiting.push({ wc: e.sender, kind }); capture(x, y, w, h, kind !== 'lens'); });

  // Window control, for feeding windows to a hole. It restores every window it hid when it exits for any reason,
  // and the list is also kept on disk so a hard crash is undone on the next launch.
  let winctl, winReplies = [];
  function startWinctl() {
    // Detached, so that if the app is killed outright this helper survives it, sees its input close, and puts every
    // swallowed window back on its own.
    winctl = spawn(HELPER, ['--windows', String(process.pid), path.join(app.getPath('userData'), 'hidden-windows.txt')],
                   { detached: true, windowsHide: true });
    winReplies = [];
    let buf = '';
    winctl.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { log('warn', 'bad window helper reply', line); continue; }
        if (msg.t === 'moved') windowDropped(msg);   // unasked: you just let go of a window you were dragging
        else if (msg.t === 'mouse') mouseDragged(msg);   // unasked: the left button is held (or just let go)
        else if (msg.t === 'konami') konami(msg);        // unasked: up up down down left right left right B A
        else if (msg.t === 'typing') toLeader({ type: 'typing', n: msg.n | 0 });
        else if (msg.t === 'phrase' && msg.id === 'hello') { const c = cursor(); toLeader({ type: 'hello', x: c.x, y: c.y }); }
        else if (msg.t === 'phrase' && msg.id === 'event horizon') { broadcast('horizon'); achieve('horizon', undefined, 2600); log('info', 'event horizon'); }
        else if (msg.t === 'song') toLeader({ type: 'song', id: msg.id === 'space oddity' ? 'space oddity' : '' });   // keys pressed in the last second (just the count)
        else if (msg.t === 'fullscreen') { log('info', msg.rect ? `fullscreen app on [${msg.rect}]: parking` : 'fullscreen app gone'); toLeader({ type: 'fullscreen', rect: msg.rect }); }
        else winReplies.shift()?.(msg);
      }
    });
    winctl.stderr.on('data', d => log('warn', '[windows]', String(d).trim()));
    winctl.on('exit', code => { if (!dying) { log('error', `window helper exited (${code}); restarting`); setTimeout(startWinctl, 1000); } });
  }
  startWinctl();
  const win32 = cmd => new Promise(res => { winReplies.push(res); winctl.stdin.write(cmd + '\n'); });

  // =====================  overlays  =====================
  function makeWindow(d) {
    const win = new BrowserWindow({
      ...d.bounds,
      transparent: true, frame: false, resizable: false, skipTaskbar: true, hasShadow: false,
      focusable: false, show: false, icon: ICON,
      webPreferences: { preload: PRELOAD, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    // Win10 2004+: removes the overlay from screen capture, so we capture the desktop *behind* it (no feedback loop).
    win.setContentProtection(true);
    // Clicks pass through to the desktop; mouse moves are still forwarded so the page can tell when you hover a hole.
    win.setIgnoreMouseEvents(true, { forward: true });
    wirePage(win);
    win.webContents.on('did-finish-load', () => win.webContents.send('init', {
      leader: win.webContents === leader, state: lastState, displays: displaysInfo(),
      settings, origin: originOf(win), paused, boredAfter: +process.env.ACCRETION_BORED_S || 3600,
    }));
    win.webContents.on('render-process-gone', (_e, info) => {
      log('error', `overlay page crashed (${info.reason}); reloading`);
      if (info.reason !== 'clean-exit') crashReport('overlay page stopped', info);
      if (!win.isDestroyed()) win.reload();
    });
    const sendOrigin = () => !win.isDestroyed() && win.webContents.send('origin', originOf(win));
    win.on('move', sendOrigin);
    win.on('resize', sendOrigin);
    win.loadFile('index.html');
    if (!hidden) win.showInactive();
    // Windows trims new windows to the work area; setting the bounds again after showing lets it cover the taskbar.
    win.setBounds(d.bounds);
    win.setContentProtection(true);   // again once shown: set on a hidden window it doesn't stick
    return win;
  }
  function wirePage(win) {
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/Security Warning/.test(msg)) log(level >= 3 ? 'error' : 'warn', '[page]', msg); });
  }

  function pickLeader() {
    const prim = wins.get(screen.getPrimaryDisplay().id) || overlays()[0];
    if (!prim || prim.webContents === leader) return;
    leader = prim.webContents;
    for (const w of overlays()) w.webContents.send('role', w.webContents === leader, lastState);
  }

  // Monitors come and go: add/remove only the affected overlays, and keep the holes where they are.
  function syncWindows() {
    const ds = screen.getAllDisplays();
    for (const [id, w] of wins) {
      if (!ds.some(d => d.id === id)) {
        if (w.webContents === leader) leader = null;
        w.destroy();
        wins.delete(id);
      }
    }
    for (const d of ds) {
      const w = wins.get(d.id);
      if (!w) wins.set(d.id, makeWindow(d));
      else w.setBounds(d.bounds);
    }
    pickLeader();
    broadcast('displays', displaysInfo());
  }
  syncWindows();
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, syncWindows);

  // Other "always on top" windows (pop-ups, overlays from other apps) can land above ours; keep reclaiming the top
  // so new windows still fall under the black hole.
  setInterval(() => {
    if (hidden) return;
    for (const w of overlays()) { w.setAlwaysOnTop(true, 'screen-saver'); w.moveTop(); }
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.moveTop();
  }, 1500);

  // =====================  messages from the pages  =====================
  // An overlay catches the mouse when its page says the cursor is on a hole, or while something is being dragged
  // over a hole (so a dragged file can be dropped into it); otherwise clicks go straight through to the desktop.
  const pageOver = new WeakMap();
  let dropWin = null;
  const applyHit = w => { if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(!(pageOver.get(w) || dropWin === w), { forward: true }); };
  ipcMain.on('hit', (e, over) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) { pageOver.set(w, over); applyHit(w); } });
  function mouseDragged(m) {
    if (!m.down) {   // let go: stay catchable a moment, so a drop that's landing on a hole gets there
      const old = dropWin;
      dropWin = null;
      if (old) setTimeout(() => { if (dropWin !== old) applyHit(old); }, 500);
      return;
    }
    let target = null;
    for (const h of lastState?.holes || []) {
      if (h.deathAt) continue;
      const rs = (600 / 28) * h.mass * settings.size * h.dpr;   // Schwarzschild radius in px (as in index.html)
      if (Math.hypot(m.x - h.x, m.y - h.y) < 2.6 * rs * 2.5) {
        target = overlays().find(w => { const r = screen.dipToScreenRect(w, w.getBounds()); return m.x >= r.x && m.x < r.x + r.width && m.y >= r.y && m.y < r.y + r.height; }) || null;
        break;
      }
    }
    if (target === dropWin) return;
    const old = dropWin;
    dropWin = target;
    applyHit(old); applyHit(target);
  }
  ipcMain.on('input', (e, msg) => toLeader(msg));   // drag, wheel, feed...: the leader owns the physics
  let lastCur = null, lastCurAt = 0;
  setInterval(() => {
    if (hidden || paused || !leader) return;
    const p = cursor();
    if (lastCur && p.x === lastCur.x && p.y === lastCur.y && Date.now() - lastCurAt < 500) return;
    lastCur = p; lastCurAt = Date.now();
    toLeader({ type: 'cursor', p });
  }, 33);
  // The PC's sound, for dancing to music: the page asks for the screen's audio; give it the loopback, never a picker.
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then(s => cb({ video: s[0], audio: 'loopback' })).catch(() => cb({}));
  });
  // What the settings window shows about each hole (its "profile").
  const holeInfo = h => {
    const alive = (lastState?.holes || []).filter(o => o !== h && !o.deathAt);
    return { id: h.id, overrides: h.overrides, meals: h.meals.length, name: h.name, mood: h.mood, born: h.born,
             mass: h.massTarget ?? h.mass, spin: h.spin, appetite: h.appetite, trait: h.trait, pinned: h.pinned, baby: h.baby,
             lineage: h.lineage, children: h.children, trophies: h.trophies, stats: h.stats, uid: h.uid, rare: h.rare, sulking: h.sulking,
             memory: settings.memories[h.uid]?.label,
             favourite: (([k, n] = []) => n >= 3 ? k : null)(Object.entries(h.tastes || {}).sort((a, b) => b[1] - a[1])[0]),
             rivals: alive.filter(o => (h.rivals?.[o.uid] || 0) >= 3).map(o => o.name),
             fear: h.fear, hobby: h.hobby,
             rank: alive.length ? [h, ...alive].sort((a, b) => (b.massTarget ?? b.mass) - (a.massTarget ?? a.mass)).indexOf(h) + 1 : 0, of: alive.length + 1,
             parent: alive.find(o => o.uid === h.parentUid)?.name, friends: alive.filter(o => (h.bonds?.[o.uid] || 0) >= 1).map(o => o.name) };
  };
  const petOf = h => Object.fromEntries(PET_KEYS.map(k => [k, h[k]]));
  ipcMain.on('state', (e, s) => {
    if (e.sender !== leader) return;
    lastState = s;
    // Holes being closed drop out, except when they're all going (quitting): then the last ones stay saved, to come back.
    const alive = s.holes.filter(h => !h.deathAt);
    if (alive.length) settings.lastHoles = alive.map(h => ({ x: h.x, y: h.y, mass: h.massTarget, overrides: h.overrides, ...petOf(h), savedAt: Date.now() }));
    lastStateAt = Date.now();
    for (const wc of pages()) if (wc !== leader) wc.send('state', s);
    if (settingsWin && !settingsWin.isDestroyed() && Date.now() - holesSentAt > 500) {
      holesSentAt = Date.now();
      settingsWin.webContents.send('holes', s.holes.filter(h => !h.deathAt).map(holeInfo));
    }
    if (s.allGone) exitApp();
  });
  ipcMain.on('stats', (_e, s) => {
    const metrics = app.getAppMetrics().reduce((t, m) => t + (m.cpu?.percentCPUUsage || 0), 0) / os.cpus().length;
    stats = { ...stats, fps: s.fps, cpu: metrics + (stats.helperCpu || 0) };
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('stats', stats);
  });
  ipcMain.on('log', (_e, level, msg) => log(level, '[page]', msg));

  // --- feeding: windows and desktop icons ---
  // Keys name what was eaten: "w<hwnd>" for a window, "i<name>" for a desktop icon.
  // While you drag a hole, the leader asks what's under it; hold it still there, let go, and it eats it.
  ipcMain.on('probe', async (e, id, x, y) => {
    const r = await win32(`AT ${x | 0} ${y | 0}`);
    if (!e.sender.isDestroyed()) e.sender.send('probe-result', id, r);
  });
  const meals = new Map();   // key -> { holeId, rect: [x, y, w, h], px }: kept so the hole can spit it back out
  // Easter egg: it won't eat itself (a shortcut to Accretion, its launcher, its own folder).
  const appDir = path.resolve(__dirname).toLowerCase();
  function isSelf(p) {
    let t = p;
    if (/\.lnk$/i.test(p)) { try { t = shell.readShortcutLink(p).target || p; } catch { } }
    t = path.resolve(t).toLowerCase();
    return t === process.execPath.toLowerCase() || t === appDir || t.startsWith(appDir + path.sep);
  }
  const selfIcon = name => /^accretion(\.bat)?$/i.test(name)
    || desktops().some(d => ['.lnk', ''].some(ext => { const p = path.join(d, name + ext); return fs.existsSync(p) && isSelf(p); }));
  function refuse(holeId) {
    broadcast('toast', { holeId, text: '...no.' });
    toLeader({ type: 'refuse', id: holeId });
    achieve('self', holeId, 1500);
  }
  // Something went down: count it, and maybe it's a trophy.
  const COMMON = new Set('txt doc docx pdf jpg jpeg png gif bmp webp mp3 wav mp4 mov mkv avi zip rar 7z exe msi lnk url ini log csv xls xlsx ppt pptx html htm js json css md py ico svg'.split(' '));
  function ate(holeId, trophies) {
    const c = settings.counters;
    c.eaten = (c.eaten || 0) + 1;
    achieve('first', holeId, 2600);
    if (c.eaten >= 100) achieve('hundred', holeId, 2600);
    const hr = new Date().getHours();
    if (hr >= 2 && hr < 4) achieve('night', holeId, 2600);
    for (const tr of [{ kind: 'first', ...trophies[0], v: 0 }, ...trophies]) toLeader({ type: 'trophy', id: holeId, trophy: { at: Date.now(), ...tr } });
    saveSettings();
  }
  // Kinds of food, for favourites.
  const KINDS = [[/\.(png|jpe?g|gif|webp|bmp|heic|tiff?|psd|raw|cr2|nef|svg|ico)$/i, 'pictures'], [/\.(mp3|flac|wav|m4a|ogg|opus|aac|wma)$/i, 'music'],
    [/\.(mp4|mkv|mov|avi|webm|wmv)$/i, 'videos'], [/\.(pdf|docx?|odt|rtf|txt|md|pptx?|xlsx?|csv)$/i, 'documents'],
    [/\.(js|ts|py|cs|cpp|c|h|java|go|rs|rb|php|html?|css|json|sh|ps1|bat)$/i, 'code'], [/\.(zip|7z|rar|tar|gz|bz2|xz)$/i, 'archives'],
    [/\.(obj|stl|glb|gltf|fbx|blend)$/i, '3D models'], [/\.(exe|msi|lnk|url)$/i, 'programs']];
  const kindOf = (p, st) => st?.isDirectory() ? 'folders' : (KINDS.find(([re]) => re.test(p)) || [, 'files'])[1];

  // Food quality: big pictures, video and music are rich; empty folders and empty files are unsatisfying.
  const RICH = /\.(mp4|mkv|mov|avi|webm|mp3|flac|wav|m4a|ogg|png|jpe?g|webp|gif|psd|raw|cr2|nef|heic|tiff?)$/i;
  function qualityOfFile(p, st) {
    if (st.isDirectory()) { let n = 0; try { n = fs.readdirSync(p).length; } catch { } return n === 0 ? 'unsatisfying' : n > 50 ? 'hearty' : 'plain'; }
    if (st.size === 0) return 'unsatisfying';
    if (RICH.test(p) && st.size > 2e6) return 'rich';
    if (st.size > 50e6) return 'hearty';
    return st.size < 2e3 ? 'snack' : 'plain';
  }
  const qualityOfWindow = (w, h) => w * h > 1.5e6 ? 'rich' : w * h > 6e5 ? 'hearty' : w * h < 1.5e5 ? 'snack' : 'plain';

  // Memories: the biggest thing each hole has eaten, kept as a small picture it dreams about.
  const memDir = path.join(app.getPath('userData'), 'memories');
  function remember(holeId, px, w, h, label, v) {
    const hole = holeById(holeId);
    if (!hole?.uid || !px || !w || !h || (settings.memories[hole.uid]?.v || 0) >= v) return;
    try {
      const bmp = nativeImage.createFromBitmap(Buffer.from(px), { width: w, height: h }).resize({ width: 128, height: 80, quality: 'good' }).toBitmap();
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, hole.uid + '.bgra'), bmp);
      settings.memories[hole.uid] = { label: String(label).slice(0, 80), v };
      saveSettings();
      broadcast('dream', hole.uid, bmp);
    } catch (e) { log('warn', `could not remember ${label}: ${e.message}`); }
  }
  function sendDreams() {
    for (const h of lastState?.holes || []) {
      if (!h.uid || !settings.memories[h.uid]) continue;
      try { broadcast('dream', h.uid, fs.readFileSync(path.join(memDir, h.uid + '.bgra'))); } catch { }
    }
  }
  setTimeout(sendDreams, 4000);
  setInterval(sendDreams, 20000);   // (pages that reload or join later get them too)

  function eat(holeId, key, rect, title = '') {
    if (meals.has(key)) return;
    if (key[0] === 'i' && selfIcon(key.slice(1))) { refuse(holeId); return; }
    const [l, t, r, b] = rect;
    // Grab its pixels while it's still visible, then hide the real thing; the pages animate the copy falling in.
    waiting.push({ cb: async (x, y, w, h, n, px) => {
      const res = await win32(`HIDE ${key}`);
      if (!res.ok || n !== -1) {
        log('warn', `could not swallow ${key} "${title}" (${res.ok ? 'no capture' : key[0] === 'i' ? 'icons can\'t move: is Auto arrange on?' : 'not allowed to hide it'})`);
        if (res.ok) win32(`SHOW ${key}`);
        toLeader({ type: 'meal-failed', id: holeId, key });
        return;
      }
      log('info', `hole ${holeId} swallowed ${key} "${title}"`);
      if (/^irecycle bin$/i.test(key)) recycleBinEaten(holeId, key);
      if (key[0] === 'w' && w * h >= 2560 * 1440) achieve('big', holeId, 2600);
      ate(holeId, key[0] === 'w' ? [{ kind: 'biggest', label: title || 'A window', detail: `${w} × ${h}`, v: w * h }]
                                 : [{ kind: 'desk', label: key.slice(1), detail: 'off the desktop' }]);
      const quality = key[0] === 'w' ? qualityOfWindow(w, h) : 'plain';
      meals.set(key, { holeId, rect: [x, y, w, h], px: Buffer.from(px), title, quality });
      broadcast('meal', { holeId, key, rect: [x, y, w, h] }, px);
      toLeader({ type: 'meal', id: holeId, key, area: w * h, quality, cat: key[0] === 'w' ? 'windows' : 'desktop icons' });
      journalAte(holeId, title || key.slice(1), w * h);
      remember(holeId, px, w, h, title || key.slice(1), key[0] === 'w' ? w * h : 1);
    } });
    capture(l, t, r - l, b - t, true);
  }
  ipcMain.on('eat', (_e, holeId, key, rect, title) => eat(holeId, key, rect, title));

  // Files dragged onto a hole. The page took them as a "copy" and copies nothing, so the files never move: the hole
  // eats their icons. Something that's on the desktop loses its desktop icon too, until it's spat back out.
  // Mass goes with the size of the file, on a log scale (a 1 KB note and a 10 GB video shouldn't differ by 10^7).
  const desktops = () => [app.getPath('desktop'), path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop')].map(d => d.toLowerCase());
  // 3D models: the page draws the model's triangles as a wireframe, and that's what it eats.
  const pendingPics = new Map();
  let picN = 0;
  ipcMain.on('model-picture', (e, id, w, h, px) => {
    const done = pendingPics.get(id);
    if (!done || e.sender !== leader) return;
    pendingPics.delete(id);
    done(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 1024 && h <= 1024 && px?.length === w * h * 4 ? { w, h, px: Buffer.from(px) } : null);
  });
  function modelPicture(p) {
    const tris = readModel(p);
    if (!tris || !leader || leader.isDestroyed()) return Promise.resolve(null);
    return new Promise(res => {
      const id = ++picN;
      pendingPics.set(id, res);
      leader.send('draw-model', id, tris);
      setTimeout(() => { if (pendingPics.delete(id)) res(null); }, 4000);
    }).then(pic => pic && { ...pic, tris: tris.length / 9 });
  }
  // Zips burst open: after the zip falls in, its files (the biggest few) spill out around the hole as icons and follow.
  const iconCache = new Map();
  async function iconForName(name) {
    const ext = (path.extname(name).slice(1).toLowerCase().match(/^[a-z0-9]{1,10}$/) || [''])[0];
    if (iconCache.has(ext)) return iconCache.get(ext);
    let img = null;
    try {   // an empty stand-in file with that extension, just to ask Windows for its icon
      const dir = path.join(app.getPath('temp'), 'accretion-icons');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, 'file' + (ext ? '.' + ext : ''));
      if (!fs.existsSync(f)) fs.writeFileSync(f, '');
      img = await app.getFileIcon(f, { size: 'large' });
    } catch { }
    iconCache.set(ext, img);
    return img;
  }
  let zipN = 0;
  async function burstZip(holeId, p, entries, x, y, draw) {
    const pick = entries.slice().sort((a, b) => b.size - a.size).slice(0, 10), R = draw * 1.9;
    for (const [i, en] of pick.entries()) {
      const img = await iconForName(en.name);
      if (!img || img.isEmpty()) continue;
      const { width: w, height: hh } = img.getSize(), px = img.toBitmap(), a = i / pick.length * 2 * Math.PI + 0.4, s = Math.round(draw * 0.75);
      const key = `z${++zipN}-${i}`, rect = [Math.round(x + Math.cos(a) * R - s / 2), Math.round(y + Math.sin(a) * R - s / 2), s, s];
      setTimeout(() => {
        if (dying || !holeById(holeId)) return;
        meals.set(key, { holeId, rect, px, size: [w, hh], alpha: true, title: `${path.basename(en.name)} (from ${path.basename(p)})`, quality: 'snack' });
        broadcast('meal', { holeId, key, rect, size: [w, hh], alpha: true }, px);
        toLeader({ type: 'meal', id: holeId, key, mass: 0.004, quality: 'snack' });
      }, 1100 + i * 110);
    }
  }
  // Pictures are eaten as themselves, shrunk to fit a box.
  const IMAGE = /\.(png|jpe?g|gif|bmp|ico|webp)$/i;
  function picFrom(img, hole) {
    if (!img || img.isEmpty()) return null;
    const box = Math.round(220 * (hole?.dpr || 1));
    const { width, height } = img.getSize(), k = Math.min(1, box * 1.5 / Math.max(width, height));   // keep a little extra detail
    const small = k < 1 ? img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: 'good' }) : img;
    const s = small.getSize();
    return { px: small.toBitmap(), tw: s.width, th: s.height, box };
  }
  // Is this a picture of a black hole? A dark middle inside a bright ring (or a telling file name, above).
  function looksLikeBlackHole(px, w, h) {
    if (!px || w < 16 || h < 16) return false;
    const lum = (x, y) => { const i = (Math.round(y) * w + Math.round(x)) * 4; return (px[i + 2] * 0.3 + px[i + 1] * 0.59 + px[i] * 0.11) / 255; };
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2;
    let inner = 0, ring = 0, ni = 0, nr = 0;
    for (let a = 0; a < 6.283; a += 0.2) for (const f of [0.03, 0.08, 0.13]) { inner += lum(cx + Math.cos(a) * R * f, cy + Math.sin(a) * R * f); ni++; }
    for (let a = 0; a < 6.283; a += 0.1) { let best = 0; for (let f = 0.18; f <= 0.75; f += 0.04) best = Math.max(best, lum(cx + Math.cos(a) * R * f, cy + Math.sin(a) * R * f)); ring += best; nr++; }
    inner /= ni; ring /= nr;
    return inner < 0.2 && ring > 0.33 && ring - inner > 0.15 && inner < ring * 0.6;
  }
  function cousin(holeId) {
    setTimeout(() => broadcast('toast', { holeId, text: 'Cousin.' }), 2400);
    achieve('cousin', holeId, 4600);
  }
  let picN2 = 0;
  function feedPicture(holeId, x, y, img, title) {
    const hole = holeById(holeId), pic = picFrom(img, hole);
    if (!hole || !pic) { broadcast('toast', { holeId, text: 'It can\'t see that picture.', sub: 'That kind of image file can\'t be read.' }); return; }
    const { px, tw, th, box } = pic, [dw, dh] = tw >= th ? [box, Math.round(box * th / tw)] : [Math.round(box * tw / th), box];
    const key = `p${++picN2}-${Date.now()}`, rect = [Math.round(x - dw / 2), Math.round(y - dh / 2), dw, dh];
    meals.set(key, { holeId, rect, px, size: [tw, th], alpha: true, title: String(title || 'a picture').slice(0, 120), quality: tw * th > 2e5 ? 'rich' : 'plain' });
    broadcast('meal', { holeId, key, rect, size: [tw, th], alpha: true }, px);
    toLeader({ type: 'meal', id: holeId, key, mass: 0.03, quality: tw * th > 2e5 ? 'rich' : 'plain', cat: 'pictures' });
    remember(holeId, px, tw, th, title || 'a picture', 1);
    if (/black.?hole|m87|sgr.?a|gargantua|event.?horizon/i.test(String(title)) || looksLikeBlackHole(px, tw, th)) cousin(holeId);
    ate(holeId, [{ kind: 'desk', label: String(title || 'a picture').slice(0, 60), detail: 'a picture' }]);
    journalAte(holeId, title || 'a picture', tw * th);
    achieve('picture', holeId, 2600);
    log('info', `hole ${holeId} ate a picture (${tw}x${th})`);
  }
  // The bytes of a picture dragged out of another app (no file behind it).
  ipcMain.on('drop-image-data', (_e, holeId, x, y, bytes, name) => {
    if (dying || paused || !bytes || bytes.length > 20e6) return;
    feedPicture(holeId, x, y, nativeImage.createFromBuffer(Buffer.from(bytes)), name);
  });
  // A picture dragged from a web page: fetch it (only http(s) or an inline data: picture, at most 20 MB, 8 s).
  ipcMain.on('drop-image-url', async (_e, holeId, x, y, src, alt) => {
    if (dying || paused || typeof src !== 'string') return;
    try {
      if (/^data:image\//i.test(src)) return feedPicture(holeId, x, y, nativeImage.createFromDataURL(src), alt);
      if (!/^https?:\/\//i.test(src)) return;
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
      const res = await net.fetch(src, { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok || !/^image\//i.test(res.headers.get('content-type') || '')) throw new Error(`not a picture (${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 20e6) throw new Error('too big');
      feedPicture(holeId, x, y, nativeImage.createFromBuffer(buf), alt || decodeURIComponent(new URL(src).pathname.split('/').pop() || 'a picture'));
    } catch (e) {
      log('warn', `picture from the web failed: ${e.message}`);
      broadcast('toast', { holeId, text: 'It couldn\'t reach that picture.' });
    }
  });
  ipcMain.on('drop-files', async (_e, holeId, x, y, paths) => {
    if (dying || paused) return;
    const h = lastState?.holes.find(h => h.id === holeId);
    const draw = Math.round(64 * (h?.dpr || 1));
    for (const [n, p] of paths.slice(0, 16).entries()) {
      if (isSelf(p)) { refuse(holeId); continue; }
      let size = 0, st;
      try { st = fs.statSync(p); size = st.isDirectory() ? 0 : st.size; } catch { continue; }
      let img;
      try { img = await app.getFileIcon(p, { size: 'large' }); } catch (err) { log('warn', `no icon for ${p}: ${err.message}`); continue; }
      let { width: tw, height: th } = img.getSize(), px = img.toBitmap(), drawn = draw, modelTris = 0;
      // A picture: the picture itself, not its icon.
      let picture = false;
      if (IMAGE.test(p) && size < 60e6) {
        const pic = picFrom(nativeImage.createFromPath(p), h);
        if (pic) { ({ px, tw, th } = pic); drawn = pic.box; picture = true; }
      }
      if (MODEL.test(p)) {   // a 3D model: its wireframe, bigger than an icon
        const pic = await modelPicture(p);
        if (pic) { px = pic.px; tw = pic.w; th = pic.h; drawn = Math.round(170 * (h?.dpr || 1)); modelTris = pic.tris; }
      }
      const zipList = /\.zip$/i.test(p) ? zipEntries(p) : null;
      let key = 'f' + p;
      if (desktops().includes(path.dirname(p).toLowerCase())) {
        // The desktop shows shortcuts (and, depending on settings, other files) without their extension.
        for (const name of [path.basename(p), path.parse(p).name]) {
          if ((await win32(`HIDE i${name}`)).ok) { key = 'i' + name; break; }
        }
      }
      if (meals.has(key)) continue;
      const [dw, dh] = picture ? (tw >= th ? [drawn, Math.round(drawn * th / tw)] : [Math.round(drawn * tw / th), drawn]) : [drawn, drawn];
      const rect = [Math.round(x - dw / 2 + n * 14), Math.round(y - dh / 2 + n * 10), dw, dh];
      const food = pluginFood(path.basename(p));
      const quality = food?.quality || (modelTris ? 'hearty' : zipList?.length > 50 ? 'hearty' : qualityOfFile(p, st));
      meals.set(key, { holeId, rect, px, size: [tw, th], alpha: true, title: path.basename(p), quality });
      broadcast('meal', { holeId, key, rect, size: [tw, th], alpha: true }, px);
      toLeader({ type: 'meal', id: holeId, key, mass: size ? Math.min(0.03 + Math.log10(size + 1) * 0.012, 0.2) : 0.05, quality, cat: food?.kind || kindOf(p, st) });
      if (food?.say) setTimeout(() => broadcast('toast', { holeId, text: food.say }), 2200);
      // Easter eggs.
      if (/^nothing\.txt$/i.test(path.basename(p))) { setTimeout(() => broadcast('toast', { holeId, text: 'Something.' }), 2400); achieve('nothing', holeId, 4600); }
      if (picture && (/black.?hole|m87|sgr.?a|sagittarius.?a|gargantua|event.?horizon|cygnus.?x/i.test(path.basename(p)) || looksLikeBlackHole(px, tw, th))) cousin(holeId);
      if (/space.?oddity/i.test(path.basename(p)) && /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|weba|webm)$/i.test(p)) { toLeader({ type: 'song', id: 'space oddity' }); setTimeout(() => toLeader({ type: 'song', id: '' }), 5 * 60e3); }
      journalAte(holeId, path.basename(p), size);
      if (picture) achieve('picture', holeId, 2600);
      remember(holeId, px, tw, th, path.basename(p), 1);
      // Easter egg: feed it a song and it plays from inside, redshifted and muffled, with the disk pulsing to it.
      if (/\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|weba|webm)$/i.test(p)) toLeader({ type: 'music', id: holeId, key, url: require('url').pathToFileURL(p).href });
      log('info', `hole ${holeId} ate ${path.basename(p)} (${size} bytes${key[0] === 'i' ? ', off the desktop' : ''}${modelTris ? `, a model of ${modelTris} triangles` : ''}${zipList ? `, ${zipList.length} files inside` : ''})`);
      if (zipList?.length) burstZip(holeId, p, zipList, x, y, draw);
      const base = path.basename(p), ext = path.extname(p).slice(1).toLowerCase(), when = st.mtimeMs;
      ate(holeId, [
        ...(size ? [{ kind: 'heaviest', label: base, detail: size > 1e9 ? `${(size / 1e9).toFixed(1)} GB` : size > 1e6 ? `${(size / 1e6).toFixed(1)} MB` : `${Math.ceil(size / 1e3)} KB`, v: size }] : []),
        ...(when ? [{ kind: 'oldest', label: base, detail: `from ${new Date(when).getFullYear()}`, v: when }] : []),
        ...(ext && !COMMON.has(ext) && !st.isDirectory() ? [{ kind: 'oddest', label: base, detail: `a .${ext} file` }] : []),
        ...(modelTris ? [{ kind: 'model', label: base, detail: `${modelTris} triangles`, v: modelTris }] : []),
        ...(zipList?.length ? [{ kind: 'archive', label: base, detail: `${zipList.length} files inside`, v: zipList.length }] : []),
      ]);
    }
  });

  // Easter egg: feed it the Recycle Bin. It comes straight back out, because nothing is lost: by everything we
  // know, information that falls into a black hole isn't destroyed (the black hole information paradox).
  function recycleBinEaten(holeId, key) {
    settings.counters.recycle = (settings.counters.recycle || 0) + 1;
    if (settings.counters.recycle >= 2) achieve('recycle', holeId, 4200);
    setTimeout(() => broadcast('toast', { holeId, text: 'Nothing is lost.', sub: 'Not even in here.' }), 900);
    setTimeout(() => toLeader({ type: 'release-one', id: holeId, key }), 3200);
  }

  // Easter egg: the Konami code with the cursor on (or near) a black hole.
  function konami(m) {
    for (const h of lastState?.holes || []) {
      const rs = (600 / 28) * h.mass * settings.size * h.dpr;
      if (!h.deathAt && Math.hypot(m.x - h.x, m.y - h.y) < 2.6 * rs * 3) { log('info', 'up up down down left right left right B A'); toLeader({ type: 'retro', id: h.id }); achieve('retro', h.id, 1500); return; }
    }
  }

  // A bored hole (left alone for an hour) asks where the nearest window is, and drifts over to it.
  ipcMain.on('nearest', async (e, id, x, y) => {
    const r = await win32(`NEAREST ${x | 0} ${y | 0}`);
    if (!e.sender.isDestroyed()) e.sender.send('nearest-result', id, r);
  });

  // =====================  achievements  =====================
  function achieve(id, holeId, delay = 0) {
    const a = ACH.find(a => a.id === id);
    if (!a || settings.achievements[id]) return;
    settings.achievements[id] = Date.now();
    saveSettings();
    log('info', `achievement: ${a.name}`);
    setTimeout(() => broadcast('toast', { holeId: holeId ?? lastState?.holes[0]?.id, text: a.name, sub: 'Achievement' }), delay);
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings', settings);
  }
  ipcMain.handle('achievements', () => ACH.map(a => ({ ...a, desc: a.hidden && !settings.achievements[a.id] ? '' : a.desc })));
  // A path drawn with Ctrl + drag: see what's along it (every ~40 px), so the hole can eat what the path runs into.
  ipcMain.on('path', async (e, holeId, pts) => {
    if (!Array.isArray(pts) || pts.length < 2 || pts.length > 600 || !pts.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) return;
    const start = await win32(`AT ${pts[0][0] | 0} ${pts[0][1] | 0}`), skip = new Set([start?.key]), eats = [];
    let walked = 40;
    for (let i = 1; i < pts.length; i++) {
      walked += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (walked < 40 && i < pts.length - 1) continue;
      walked = 0;
      const r = await win32(`AT ${pts[i][0] | 0} ${pts[i][1] | 0}`);
      if (r?.key && !skip.has(r.key) && !meals.has(r.key) && !/^irecycle bin$/i.test(r.key)) { skip.add(r.key); eats.push({ key: r.key, rect: r.rect, title: r.title, at: i }); }
      if (eats.length >= 6) break;
    }
    toLeader({ type: 'path', id: holeId, pts, eats });
    log('info', `path of ${pts.length} points for hole ${holeId}${eats.length ? `, eating ${eats.length} thing(s) on the way` : ''}`);
  });

  // How bright the screen is under each hole with a fear of bright windows or of the dark (every few seconds).
  setInterval(() => {
    if (dying || paused || hidden) return;
    for (const h of (lastState?.holes || []).filter(h => !h.deathAt && (h.fear === 'bright windows' || h.fear === 'the dark'))) {
      const s = 120;
      waiting.push({ cb: (x, y, w, hh, n, px) => {
        if (n !== -1 || !px?.length) return;
        let sum = 0, c = 0;
        for (let i = 0; i < px.length; i += 16) { sum += px[i + 2] * 0.3 + px[i + 1] * 0.59 + px[i] * 0.11; c++; }
        toLeader({ type: 'light', id: h.id, v: sum / c / 255 });
      } });
      capture(h.x - s / 2, h.y - s / 2, s, s, true);
    }
  }, 4000);

  // Undo: spit out the last thing eaten (by that hole, from its menu; by any, from the shortcut or tray).
  function undoMeal(holeId) {
    const keys = [...meals.keys()].filter(k => holeId == null || meals.get(k).holeId === holeId);
    const key = keys.at(-1);
    if (!key) return false;
    toLeader({ type: 'release-one', id: meals.get(key).holeId, key });
    return true;
  }

  // =====================  journal  =====================
  // A diary for each hole: what it ate, how long it purred, danced and slept, and anything big that happened.
  function journalDay(uid) {
    const day = new Date().toISOString().slice(0, 10), j = (settings.journal[uid] ||= {});
    if (!j[day]) {
      j[day] = { ate: 0, best: '', bestV: 0, petS: 0, danceS: 0, sleepS: 0, notes: [] };
      for (const d of Object.keys(j).sort().slice(0, -60)) delete j[d];   // keep two months
    }
    return j[day];
  }
  function journalAte(holeId, label, v) {
    const uid = holeById(holeId)?.uid;
    if (!uid) return;
    const d = journalDay(uid);
    d.ate++;
    if (v >= d.bestV) { d.best = String(label).slice(0, 80); d.bestV = v; }
    saveSettings();
  }
  function journalNote(holeId, text) {
    const uid = holeById(holeId)?.uid;
    if (!uid || !text) return;
    const d = journalDay(uid);
    d.notes = [...d.notes, `${new Date().toTimeString().slice(0, 5)} ${String(text).slice(0, 100)}`].slice(-12);
    saveSettings();
  }
  ipcMain.on('journal', (e, list) => {
    if (e.sender !== leader || !Array.isArray(list)) return;
    for (const o of list.slice(0, 4)) {
      if (typeof o?.uid !== 'string') continue;
      const d = journalDay(o.uid);
      d.petS += Math.max(0, o.petS | 0); d.danceS += Math.max(0, o.danceS | 0); d.sleepS += Math.max(0, o.sleepS | 0);
    }
    saveSettings();
  });
  ipcMain.handle('journal-get', (_e, uid) => Object.entries(settings.journal[String(uid)] || {}).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 30));

  ipcMain.on('pet-event', (_e, ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.achieve || /forgives|rivals|baby|friends|stole|grown|rare/i.test(ev.text || '')) journalNote(ev.holeId, ev.text ? `${ev.text}${ev.sub ? ' ' + ev.sub : ''}` : ACH.find(a => a.id === ev.achieve)?.name);
    if (ev.text) broadcast('toast', { holeId: ev.holeId, text: String(ev.text), sub: ev.sub ? String(ev.sub) : undefined });
    if (ev.achieve) achieve(String(ev.achieve), ev.holeId, ev.text ? 3400 : 0);
  });

  // =====================  plugins  =====================
  // userData\plugins\*.json: extra looks and food rules. Data only (no code runs from them), and everything is checked.
  const plugDir = path.join(app.getPath('userData'), 'plugins');
  let plugins = { looks: [], foods: [], files: [], errors: [] };
  function loadPlugins() {
    plugins = { looks: [], foods: [], files: [], errors: [] };
    try {
      fs.mkdirSync(plugDir, { recursive: true });
      const readme = path.join(plugDir, 'README.txt');
      if (!fs.existsSync(readme)) {
        fs.writeFileSync(readme, 'Accretion plugins\r\n\r\nPut .json files here to add looks (in Settings -> Unlocks) and food rules.\r\nPlugins are data only: nothing in them runs as code. Rename example.json.off to example.json to try it,\r\nthen restart Accretion (or press Reload in Settings -> Help).\r\n');
        fs.writeFileSync(path.join(plugDir, 'example.json.off'), JSON.stringify({
          name: 'Example',
          looks: [{ name: 'Moonlight', desc: 'A pale, cool disk with jets.', look: { diskColor: '#bcd4ff', diskTemp: 0.7, thickness: 0.04, fx: ['jets', 'stars'] } }],
          foods: [{ match: '\\.psd$', kind: 'art', quality: 'rich', say: 'Layers!' }],
        }, null, 2));
      }
      for (const f of fs.readdirSync(plugDir).filter(f => /\.json$/i.test(f)).slice(0, 50)) {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(plugDir, f), 'utf8'));
          const name = typeof p.name === 'string' ? p.name.slice(0, 40) : f;
          for (const l of (Array.isArray(p.looks) ? p.looks : []).slice(0, 20))
            if (typeof l?.name === 'string' && l.look && typeof l.look === 'object') plugins.looks.push({ plugin: name, name: l.name.slice(0, 40), desc: typeof l.desc === 'string' ? l.desc.slice(0, 160) : '', look: cleanLook(l.look) });
          for (const r of (Array.isArray(p.foods) ? p.foods : []).slice(0, 50)) {
            if (typeof r?.match !== 'string' || r.match.length > 120) continue;
            plugins.foods.push({ re: new RegExp(r.match, 'i'), kind: typeof r.kind === 'string' ? r.kind.slice(0, 20) : undefined,
                                 quality: ['rich', 'hearty', 'plain', 'snack', 'unsatisfying'].includes(r.quality) ? r.quality : undefined,
                                 say: typeof r.say === 'string' ? r.say.slice(0, 80) : undefined });
          }
          plugins.files.push(f);
        } catch (e) { plugins.errors.push(`${f}: ${e.message}`); }
      }
      if (plugins.files.length) log('info', `plugins: ${plugins.files.join(', ')}`);
    } catch (e) { plugins.errors.push(e.message); }
  }
  const pluginFood = name => plugins.foods.find(r => r.re.test(name)) || null;
  ipcMain.handle('plugins', () => ({ dir: plugDir, files: plugins.files, errors: plugins.errors, looks: plugins.looks }));
  ipcMain.on('reload-plugins', loadPlugins);
  ipcMain.on('open-folder', (_e, which) => {
    const dir = { plugins: plugDir, crashes: path.join(app.getPath('userData'), 'crash-reports'), logs: path.dirname(logFile) }[which];
    if (dir) { fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir); }
  });
  ipcMain.handle('crash-reports', () => {
    try { return fs.readdirSync(path.join(app.getPath('userData'), 'crash-reports')).sort().reverse().slice(0, 10); } catch { return []; }
  });
  // About: versions and what's changed.
  ipcMain.handle('about', () => {
    let changelog = [];
    try { changelog = JSON.parse(fs.readFileSync(path.join(__dirname, 'changelog.json'), 'utf8')); } catch { }
    return { version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, windows: os.release(), changelog };
  });

  // =====================  share codes  =====================
  // A share code is the hole's look and life story, compressed: ACC1-<base64url of deflated JSON>.
  function shareCode(h) {
    const overrides = Object.fromEntries(Object.entries(h.overrides || {}).filter(([k]) => LOOK_KEYS.includes(k)));
    const pet = { v: 1, mass: h.massTarget, overrides, ...petOf(h) };
    delete pet.uid; delete pet.bonds; delete pet.parentUid; delete pet.pinned; delete pet.rivals;
    return 'ACC1-' + zlib.deflateRawSync(Buffer.from(JSON.stringify(pet))).toString('base64url');
  }
  // A code someone pasted: untrusted, so every field is checked, clamped or dropped.
  const RANGE = { diskTemp: [0, 1], thickness: [0, 0.3], tilt: [-20, 60], spinSpeed: [0, 3], bhSpin: [0, 0.99], bloom: [0, 1] };
  loadPlugins();   // (needs RANGE above)
  // A look from outside (a share code, a plugin): only known settings, of the right kind, in range.
  function cleanLook(o) {
    const out = {}, num = (v, lo, hi, d) => Number.isFinite(+v) ? Math.min(Math.max(+v, lo), hi) : d;
    if (!o || typeof o !== 'object') return out;
    for (const k of LOOK_KEYS) {
      if (!(k in o) || typeof o[k] !== typeof DEFAULTS[k]) continue;
      if (k === 'diskColor' && !/^#[0-9a-f]{6}$/i.test(o[k])) continue;
      if (k === 'look' && !['classic', 'quiet', 'thin', 'blazing'].includes(o[k])) continue;
      if (k === 'fx') { if (Array.isArray(o.fx)) out.fx = [...new Set(o.fx.filter(id => FX_IDS.includes(id)))]; continue; }
      if (k === 'grade' && !GRADES.includes(o[k])) continue;
      out[k] = RANGE[k] ? num(o[k], ...RANGE[k], DEFAULTS[k]) : o[k];
    }
    return out;
  }
  function readCode(code) {
    const m = /^ACC1-([A-Za-z0-9_-]{8,40000})$/.exec(String(code || '').replace(/\s+/g, ''));
    if (!m) throw new Error('That doesn\'t look like an Accretion share code.');
    let p;
    try { p = JSON.parse(zlib.inflateRawSync(Buffer.from(m[1], 'base64url'), { maxOutputLength: 1 << 17 }).toString()); }
    catch { throw new Error('That share code is damaged or cut short. Copy the whole thing.'); }
    if (!p || typeof p !== 'object') throw new Error('That share code is damaged.');
    const num = (v, lo, hi, d) => Number.isFinite(+v) && v !== null && v !== '' ? Math.min(Math.max(+v, lo), hi) : d;
    const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
    const node = (x, d) => x && typeof x === 'object' ? { n: str(x.n, 40), b: num(x.b, 0, Date.now(), Date.now()), p: d > 0 && Array.isArray(x.p) ? x.p.slice(0, 2).map(y => node(y, d - 1)).filter(Boolean) : [] } : null;
    const overrides = cleanLook(p.overrides);
    return {
      name: str(p.name, 40).trim() || 'Visitor', born: num(p.born, Date.UTC(2020, 0, 1), Date.now(), Date.now()),
      mass: num(p.mass, 0.3, 4, 1), spin: num(p.spin, 0, 0.998, 0.7), appetite: num(p.appetite, 0, 1, 0.3),
      trait: TRAITS.includes(p.trait) ? p.trait : undefined, rare: RARES.includes(p.rare) ? p.rare : null, baby: p.baby === true, trust: num(p.trust, 0, 3, 0), overrides,
      lineage: node(p.lineage, 4), children: (Array.isArray(p.children) ? p.children : []).slice(0, 12).map(c => node(c, 0)).filter(Boolean),
      trophies: (Array.isArray(p.trophies) ? p.trophies : []).slice(0, 12).filter(t => t && typeof t === 'object')
        .map(t => ({ kind: str(t.kind, 16), label: str(t.label, 80), detail: str(t.detail, 40), v: num(t.v, -1e15, 1e15, 0), at: num(t.at, 0, Date.now(), 0) })),
      tastes: Object.fromEntries(Object.entries(p.tastes && typeof p.tastes === 'object' ? p.tastes : {}).slice(0, 20).map(([k, v]) => [str(k, 20), num(v, 0, 1e7, 0)])),
      stats: { eaten: num(p.stats?.eaten, 0, 1e7, 0), petS: num(p.stats?.petS, 0, 1e9, 0), danceS: num(p.stats?.danceS, 0, 1e9, 0) },
    };
  }
  const holeById = id => lastState?.holes.find(h => h.id === id && !h.deathAt);
  function copyCode(id) {
    const h = holeById(id);
    if (!h) return '';
    const code = shareCode(h);
    clipboard.writeText(code);
    broadcast('toast', { holeId: id, text: 'Share code copied.', sub: 'Anyone with Accretion can add it in Settings.' });
    return code;
  }
  ipcMain.handle('share-code', (_e, id) => copyCode(id));
  ipcMain.handle('import-code', (_e, code) => {
    try {
      if ((lastState?.holes || []).filter(h => !h.deathAt).length >= 4) return { error: 'There are already four black holes, which is the most there can be. Close one first.' };
      const pet = readCode(code);
      toLeader({ type: 'adopt-pet', pet });
      log('info', `added ${pet.name} from a share code`);
      achieve('adopted', undefined, 1500);
      return { ok: true, name: pet.name };
    } catch (e) { return { error: e.message }; }
  });

  // =====================  share cards  =====================
  // A picture of the hole with its details, saved to Pictures\Accretion and copied to the clipboard.
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ageText = born => { const s = (Date.now() - born) / 1000; return s < 5400 ? `${Math.max(1, Math.round(s / 60))} minutes` : s < 129600 ? `${Math.round(s / 3600)} hours` : `${Math.round(s / 86400)} days`; };
  async function shareCard(id) {
    const h = holeById(id);
    if (!h) return;
    const look = { ...settings, ...h.overrides };
    const pw = new BrowserWindow({ width: 420, height: 420, useContentSize: true, show: false, frame: false, backgroundColor: '#000000',
                                   webPreferences: { preload: PRELOAD, backgroundThrottling: false } });
    try {
      const pet = { ...Object.fromEntries(LOOK_KEYS.map(k => [k, look[k]])), fx: look.fx || [], spin: h.spin, rare: h.rare || null, name: h.name };
      await pw.loadFile(path.join(__dirname, 'index.html'), { query: { icon: 'black', size: '1.0', tilt: String(Math.max(10, look.tilt)), pet: JSON.stringify(pet) } });
      await wait(1500);
      const portrait = (await pw.webContents.capturePage()).toDataURL();
      const data = {
        portrait, name: h.name, trait: h.trait, mood: h.mood, age: ageText(h.born), mass: (h.massTarget ?? h.mass).toFixed(2), spin: (h.spin ?? 0).toFixed(2),
        eaten: h.stats?.eaten || 0, trophies: (h.trophies || []).filter(t => t.kind !== 'first').slice(0, 3),
        family: [h.lineage?.p?.length ? `merged from ${h.lineage.p.map(x => x.n).join(' and ')}` : '', h.children?.length ? `${h.children.length} ${h.children.length > 1 ? 'babies' : 'baby'}` : ''].filter(Boolean).join(' · '),
        achievements: `${Object.keys(settings.achievements).length} of ${ACH.length} achievements`,
      };
      await pw.loadFile(path.join(__dirname, 'card.html'));
      pw.setContentSize(760, 400);
      pw.webContents.send('card', data);
      await wait(500);
      const img = await pw.webContents.capturePage();
      const dir = path.join(app.getPath('pictures'), 'Accretion');
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, `${h.name.replace(/[<>:"/\\|?*]+/g, '_')} card.png`);
      fs.writeFileSync(out, img.toPNG());
      clipboard.writeImage(img);
      shell.showItemInFolder(out);
      broadcast('toast', { holeId: id, text: 'Share card saved.', sub: 'In Pictures\\Accretion, and copied.' });
      achieve('shared', id, 3400);
      log('info', `share card saved: ${out}`);
    } catch (e) { log('error', `share card failed: ${e.stack || e}`); }
    finally { pw.destroy(); }
  }
  ipcMain.on('share-card', (_e, id) => shareCard(id));

  // =====================  live portraits (Settings)  =====================
  // Each hole as it looks right now (its own look and effects), rendered off-screen one at a time.
  let portraitQ = Promise.resolve();
  function portrait(id) {
    const job = portraitQ.then(async () => {
      const h = holeById(id);
      if (!h) return '';
      const look = { ...settings, ...h.overrides };
      const pw = new BrowserWindow({ width: 240, height: 240, useContentSize: true, show: false, frame: false, backgroundColor: '#000000',
                                     webPreferences: { preload: PRELOAD, backgroundThrottling: false } });
      try {
        const pet = { ...Object.fromEntries(LOOK_KEYS.map(k => [k, look[k]])), fx: look.fx || [], spin: h.spin, rare: h.rare || null, name: h.name };
        await pw.loadFile(path.join(__dirname, 'index.html'), { query: { icon: 'black', bg: 'grid', demo: '1', size: '0.45', tilt: String(/^gargantua$/i.test((h.name || '').trim()) ? 3 : look.tilt ?? 7), pet: JSON.stringify(pet) } });
        await wait(1300);
        return (await pw.webContents.capturePage()).toDataURL();
      } catch (e) { log('warn', `portrait failed: ${e.message}`); return ''; }
      finally { pw.destroy(); }
    });
    portraitQ = job.catch(() => {});
    return job;
  }
  ipcMain.handle('portrait', (_e, id) => portrait(id));

  // Text or a link dropped on a hole: the page drew a picture of it; eat that.
  let textN = 0;
  ipcMain.on('drop-text', (_e, holeId, x, y, w, h, px, label, kind, len) => {
    if (dying || paused || !Number.isInteger(w) || !Number.isInteger(h) || w < 8 || h < 8 || w > 1200 || h > 1200 || !px || px.length !== w * h * 4) return;
    const key = 't' + (++textN) + '-' + Date.now();
    const rect = [Math.round(x - w / 2), Math.round(y - h / 2), w, h], buf = Buffer.from(px), title = String(label || '').slice(0, 120);
    const quality = kind === 'tab' ? 'plain' : len > 600 ? 'hearty' : len < 12 ? 'snack' : 'plain';
    meals.set(key, { holeId, rect, px: buf, size: [w, h], alpha: true, title, quality });
    broadcast('meal', { holeId, key, rect, size: [w, h], alpha: true }, buf);
    toLeader({ type: 'meal', id: holeId, key, mass: kind === 'tab' ? 0.04 : Math.min(0.01 + (len | 0) / 20000, 0.08), quality, cat: kind === 'tab' ? 'browser tabs' : 'words' });
    journalAte(holeId, title, len | 0);
    ate(holeId, [kind === 'tab' ? { kind: 'tab', label: title, detail: 'a browser tab' } : { kind: 'words', label: title.slice(0, 60), detail: `${len | 0} characters` }]);
    remember(holeId, buf, w, h, title, 1);
    log('info', `hole ${holeId} ate ${kind === 'tab' ? 'a tab' : 'some text'} (${len | 0} chars)`);
  });
  // One hole stole another's meal mid-fall.
  ipcMain.on('steal', (e, key, toId, peck) => {
    if (e.sender !== leader) return;
    const m = meals.get(key);
    if (m) m.holeId = toId;
    broadcast('steal', key, toId);
    if (!peck) achieve('thief', toId, 3400);
  });
  // A bored hole batting a small window (the helper refuses anything big, maximised, or that you're using).
  ipcMain.on('nudge', (e, key, dx, dy) => {
    if (e.sender !== leader || !/^w\d+$/.test(key) || !Number.isInteger(dx) || !Number.isInteger(dy) || dying || paused || hidden) return;
    win32(`NUDGE ${key} ${dx} ${dy}`);
  });
  // What's inside a hole right now, with little pictures, for Settings.
  const thumbs = new Map();
  ipcMain.handle('stomach', (_e, holeId) => [...meals].filter(([, m]) => m.holeId === holeId).map(([key, m]) => {
    let thumb = thumbs.get(key);
    if (!thumb && m.px) {
      try {
        const [w, hh] = m.size || [m.rect[2], m.rect[3]];
        thumb = nativeImage.createFromBitmap(m.px, { width: w, height: hh }).resize({ height: 48 }).toDataURL();
        thumbs.set(key, thumb);
      } catch { thumb = ''; }
    }
    return { key, label: m.title || key.slice(1), quality: m.quality || 'plain', thumb };
  }));
  ipcMain.on('spit-one', (_e, holeId, key) => { if (meals.get(key)?.holeId === holeId) toLeader({ type: 'spit-one', id: holeId, key }); });

  // Breeding: two share codes (or one of yours, as "hole:<id>") make a baby with a bit of each.
  const trimTree = (n, d = 3) => n && { n: n.n, b: n.b, p: d > 0 ? (n.p || []).map(x => trimTree(x, d - 1)).filter(Boolean) : [] };
  ipcMain.handle('breed', (_e, a, b) => {
    try {
      if ((lastState?.holes || []).filter(h => !h.deathAt).length >= 4) return { error: 'There are already four black holes, the most there can be. Close one first.' };
      const parent = x => {
        const m = /^hole:(\d+)$/.exec(String(x || ''));
        if (!m) return readCode(x);
        const h = holeById(+m[1]);
        if (!h) throw new Error('That black hole is gone.');
        return { ...readCode(shareCode(h)), uid: h.uid };
      };
      const A = parent(a), B = parent(b);
      const words = s => s.name.split(/\s+/).filter(Boolean);
      let name = `${words(A)[0]} ${words(B).length > 1 ? words(B).at(-1) : 'Jr.'}`;
      if (name === A.name || name === B.name) name = `${words(B)[0]} ${words(A).length > 1 ? words(A).at(-1) : 'Jr.'}`;
      const hex = s => /^#[0-9a-f]{6}$/i.test(s || '') ? s : settings.diskColor;
      const ca = hex(A.overrides.diskColor), cb = hex(B.overrides.diskColor);
      const overrides = {};
      for (const k of LOOK_KEYS) { const src = Math.random() < 0.5 ? A : B; if (k in src.overrides) overrides[k] = src.overrides[k]; }
      overrides.diskColor = '#' + [1, 3, 5].map(i => Math.round((parseInt(ca.slice(i, i + 2), 16) + parseInt(cb.slice(i, i + 2), 16)) / 2).toString(16).padStart(2, '0')).join('');
      const fx = [...new Set([...(A.overrides.fx || []), ...(B.overrides.fx || [])])].filter(() => Math.random() < 0.5);
      if (fx.length) overrides.fx = fx; else delete overrides.fx;
      const rare = A.rare && Math.random() < 0.4 ? A.rare : B.rare && Math.random() < 0.4 ? B.rare : Math.random() < 0.1 ? RARES[Math.random() * RARES.length | 0] : null;
      const pet = { name, born: Date.now(), mass: 0.3, spin: (A.spin + B.spin) / 2, appetite: 0.5, rare, baby: true, overrides,
                    trait: Math.random() < 0.8 ? [A.trait, B.trait][Math.random() * 2 | 0] : undefined,
                    lineage: { n: name, b: Date.now(), p: [trimTree(A.lineage), trimTree(B.lineage)].filter(Boolean) },
                    parentUid: A.uid || B.uid, children: [], trophies: [], stats: {} };
      toLeader({ type: 'adopt-pet', pet });
      achieve('bred', undefined, 1500);
      log('info', `bred ${name}`);
      return { ok: true, name };
    } catch (e) { return { error: e.message }; }
  });

  // Gallery: once a day, a portrait of each hole, kept in userData\gallery\<hole>\<date>.png.
  const galDir = path.join(app.getPath('userData'), 'gallery');
  async function galleryTick() {
    const today = new Date().toISOString().slice(0, 10);
    for (const h of (lastState?.holes || []).filter(h => !h.deathAt && h.uid)) {
      const dir = path.join(galDir, h.uid), out = path.join(dir, today + '.png');
      if (fs.existsSync(out)) continue;
      const url = await portrait(h.id);
      if (!url) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
      log('info', `gallery: ${h.name}, ${today}`);
    }
  }
  setTimeout(() => galleryTick().catch(() => {}), 90000);
  setInterval(() => galleryTick().catch(() => {}), 3 * 3600e3);
  ipcMain.handle('gallery', (_e, uid) => {
    if (!/^[a-z0-9]{4,32}$/i.test(String(uid))) return [];
    const dir = path.join(galDir, uid);
    try {
      return fs.readdirSync(dir).filter(f => /^\d{4}-\d\d-\d\d\.png$/.test(f)).sort().slice(-60)
        .map(f => ({ date: f.slice(0, 10), url: 'data:image/png;base64,' + fs.readFileSync(path.join(dir, f)).toString('base64') }));
    } catch { return []; }
  });

  // Profiles: named sets of settings (looks, sound, behaviour, performance), not pets or achievements.
  const PROFILE_SKIP = ['looks', 'lastHoles', 'achievements', 'counters', 'profiles', 'memories', 'startWithWindows'];
  ipcMain.handle('profile', (_e, op, name) => {
    name = String(name || '').trim().slice(0, 40);
    if (op === 'save' && name) settings.profiles[name] = structuredClone(Object.fromEntries(Object.entries(settings).filter(([k]) => !PROFILE_SKIP.includes(k))));
    if (op === 'load' && settings.profiles[name]) Object.assign(settings, structuredClone(settings.profiles[name]));
    if (op === 'delete') delete settings.profiles[name];
    if (op !== 'list') applySettings();
    return Object.keys(settings.profiles);
  });
  const loadProfile = name => { if (settings.profiles[name]) { Object.assign(settings, structuredClone(settings.profiles[name])); applySettings(); } };

  // Monitors, for the per-monitor rules.
  ipcMain.handle('monitors', () => {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({ id: d.id, label: `Monitor ${i + 1}${d.id === primary ? ' (main)' : ''}`,
      detail: `${Math.round(d.size.width * d.scaleFactor)} × ${Math.round(d.size.height * d.scaleFactor)}, ${Math.round(d.scaleFactor * 100)}%` }));
  });

  // Export everything to a file, or bring it back (a backup, or moving to another PC).
  const NUM_RANGE = { ...RANGE, size: [0.4, 2], volume: [0, 1], captureRate: [15, 240] };
  ipcMain.handle('export-all', async () => {
    const r = await dialog.showSaveDialog(settingsWin, { title: 'Export Accretion', defaultPath: path.join(app.getPath('documents'), 'Accretion backup.json'),
                                                          filters: [{ name: 'Accretion backup', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return { canceled: true };
    const pets = (lastState?.holes || []).filter(h => !h.deathAt).map(shareCode);
    const { lastHoles, ...rest } = settings;
    fs.writeFileSync(r.filePath, JSON.stringify({ app: 'Accretion', version: 1, exported: new Date().toISOString(), settings: rest, pets }, null, 2));
    log('info', `exported to ${r.filePath}`);
    return { ok: true, file: r.filePath };
  });
  ipcMain.handle('import-all', async () => {
    const r = await dialog.showOpenDialog(settingsWin, { title: 'Import an Accretion backup', properties: ['openFile'], filters: [{ name: 'Accretion backup', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths?.[0]) return { canceled: true };
    let data;
    try { data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); } catch { return { error: 'That file isn\'t an Accretion backup.' }; }
    if (data?.app !== 'Accretion' || typeof data.settings !== 'object') return { error: 'That file isn\'t an Accretion backup.' };
    // Only settings we know, of the same kind as ours, numbers kept in range; pets go through the share-code checks.
    for (const [k, v] of Object.entries(data.settings)) {
      if (!(k in DEFAULTS) || k === 'lastHoles' || typeof v !== typeof DEFAULTS[k] || Array.isArray(v) !== Array.isArray(DEFAULTS[k]) || v === null) continue;
      settings[k] = typeof v === 'number' && NUM_RANGE[k] ? Math.min(Math.max(v, NUM_RANGE[k][0]), NUM_RANGE[k][1]) : v;
    }
    const pets = (Array.isArray(data.pets) ? data.pets : []).slice(0, 4).map(c => { try { return readCode(c); } catch { return null; } }).filter(Boolean);
    applySettings(); applyLogin();
    if (pets.length) toLeader({ type: 'replace-pets', pets });
    log('info', `imported ${r.filePaths[0]} (${pets.length} black holes)`);
    return { ok: true, pets: pets.length };
  });

  // =====================  wormhole  =====================
  // While a hole has the wormhole look, send the pages a small picture of another monitor (the same one, if there's
  // only one) about once a second. Our own windows are excluded from screen capture, so it never sees itself.
  const fxOf = h => ({ ...settings, ...(h.overrides || {}) }).fx || [];
  let wormBusy = false;
  setInterval(async () => {
    if (wormBusy || hidden || paused) return;
    const h = (lastState?.holes || []).find(h => !h.deathAt && fxOf(h).includes('wormhole'));
    if (!h) return;
    wormBusy = true;
    try {
      const ds = screen.getAllDisplays(), here = screen.getDisplayNearestPoint(screen.screenToDipPoint({ x: h.x, y: h.y }));
      const other = ds.find(d => d.id !== here.id) || here;
      const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 640, height: 360 } });
      const s = srcs.find(s => String(s.display_id) === String(other.id)) || srcs[0];
      if (s && !s.thumbnail.isEmpty()) { const { width, height } = s.thumbnail.getSize(); broadcast('worm', width, height, s.thumbnail.toBitmap()); }
    } catch (e) { log('warn', `wormhole picture failed: ${e.message}`); }
    wormBusy = false;
  }, 1200);
  // Cold snap: running in winter.
  if ([10, 11, 0, 1].includes(new Date().getMonth())) setTimeout(() => achieve('season'), 8000);

  // You dragged a window and let go with the cursor on a black hole: it falls in.
  function windowDropped(m) {
    if (dying || hidden || paused) return;
    const K = 600 / 28;
    for (const h of lastState?.holes || []) {
      if (h.deathAt) continue;
      const rs = K * h.mass * settings.size * h.dpr;   // Schwarzschild radius in px (as in index.html)
      if (Math.hypot(m.x - h.x, m.y - h.y) < 2.6 * rs * 2.5) { eat(h.id, m.key, m.rect, m.title); return; }
    }
  }

  // Giving things back: the hole spits each one out (the pages play the fall in reverse), then the real one returns.
  const SPIT_MS = 1600;
  function release(holeId, keys) {
    for (const key of keys) {
      const m = meals.get(key);
      meals.delete(key);
      if (m && !hidden) broadcast('spit', { holeId, key, rect: m.rect, size: m.size, alpha: m.alpha }, m.px);
      setTimeout(() => win32(`SHOW ${key}`), m && !hidden ? SPIT_MS : 0);
    }
    if (keys.length) log('info', `released ${keys.length} item(s)`);
  }
  ipcMain.on('release', (_e, holeId, keys) => release(holeId, keys));   // a hole evaporated, or you asked
  function releaseAll() {
    const byHole = new Map();
    for (const [key, m] of meals) byHole.set(m.holeId, [...(byHole.get(m.holeId) || []), key]);
    toLeader({ type: 'released-all' });
    for (const [holeId, keys] of byHole) release(holeId, keys);
    setTimeout(() => win32('SHOWALL'), SPIT_MS + 200);   // anything left over (e.g. from before a restart)
  }

  // --- right-click on a hole ---
  ipcMain.on('menu', (e, id) => {
    const holes = lastState?.holes || [], h = holes.find(h => h.id === id), many = holes.length > 1;
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || !h) return;
    const menu = Menu.buildFromTemplate([
      { label: `${h.name || 'Black hole'} · ${h.trait || ''} · ${h.mood || 'calm'}`, enabled: false },
      { label: 'Name it…', click: () => openSettings(id) },
      { label: 'Stay here', type: 'checkbox', checked: !!h.pinned, click: () => toLeader({ type: 'pin', id, on: !h.pinned }) },
      { label: 'Copy share code', click: () => copyCode(id) },
      { label: 'Make a share card', click: () => shareCard(id) },
      { label: 'Undo last meal', accelerator: 'Ctrl+Alt+Z', enabled: [...meals.values()].some(m => m.holeId === id), click: () => undoMeal(id) },
      { type: 'separator' },
      { label: 'Settings…', click: () => openSettings('all') },
      ...(many ? [{ label: 'Settings for this black hole…', click: () => openSettings(id) }] : []),
      { label: 'Screenshot', click: () => !e.sender.isDestroyed() && e.sender.send('take-screenshot') },
      { type: 'separator' },
      { label: h.meals.length ? `Spit out what it swallowed (${h.meals.length})` : 'Spit out what it swallowed', enabled: h.meals.length > 0,
        click: () => toLeader({ type: 'release', id }) },
      { type: 'separator' },
      { label: many ? 'Close this black hole' : 'Close', click: () => toLeader({ type: 'die', id }) },
      ...(many ? [{ label: 'Close all', click: dieAll }] : []),
    ]);
    // A menu on a window that can't take focus closes the moment it opens, so allow focus just while it's up.
    win.setFocusable(true);
    win.focus();
    menu.popup({ window: win, callback: () => {
      if (win.isDestroyed()) return;
      win.setFocusable(false);
      win.setSkipTaskbar(true);   // becoming focusable can put it on the taskbar
    } });
  });

  // --- screenshots: the overlay is invisible to normal screenshots, so the page composites itself over a capture ---
  ipcMain.on('screenshot', (_e, dataUrl) => {
    const dir = path.join(app.getPath('pictures'), 'Accretion');
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const file = path.join(dir, `Accretion ${stamp}.png`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
      log('info', 'screenshot saved', file);
      shell.showItemInFolder(file);
    } catch (err) { log('error', 'screenshot not saved:', err.message); }
  });
  function screenshotNow() {   // the monitor the first hole is on
    const h = lastState?.holes[0];
    const d = h ? screen.getAllDisplays().find(d => { const r = screen.dipToScreenRect(null, d.bounds); return h.x >= r.x && h.x < r.x + r.width && h.y >= r.y && h.y < r.y + r.height; }) : null;
    (wins.get(d?.id) || overlays()[0])?.webContents.send('take-screenshot');
  }

  // --- share view: a normal window showing the desktop with the black hole, for screen sharing and recording ---
  // (The overlays have to stay invisible to capture so they can see what's behind them, which also hides them from
  // Discord, Teams, OBS and the like. Share this window instead.)
  function toggleShareView() {
    if (shareWin && !shareWin.isDestroyed()) { shareWin.close(); return; }
    const h = lastState?.holes[0];
    const d = screen.getAllDisplays().find(d => { const r = screen.dipToScreenRect(null, d.bounds); return h && h.x >= r.x && h.x < r.x + r.width; }) || screen.getPrimaryDisplay();
    // Put it on another monitor if there is one: on the same one it would capture itself (a hall of mirrors).
    // Screen-sharing apps capture a window even when it's behind others, so on one monitor you can tuck it away.
    const other = screen.getAllDisplays().find(o => o.id !== d.id);
    const sw = 1280, sh = Math.round(1280 * d.bounds.height / d.bounds.width) + 32;
    const place = other ? { x: Math.round(other.workArea.x + (other.workArea.width - sw) / 2), y: Math.round(other.workArea.y + (other.workArea.height - sh) / 2) } : {};
    shareWin = new BrowserWindow({
      width: sw, height: sh, ...place, title: 'Accretion — Share view (pick this window when you share)',
      icon: ICON, autoHideMenuBar: true, backgroundColor: '#000000',
      webPreferences: { preload: PRELOAD, backgroundThrottling: false },
    });
    shareWin.setAspectRatio(d.bounds.width / d.bounds.height);
    wirePage(shareWin);
    shareWin.webContents.on('did-finish-load', () => shareWin.webContents.send('init', {
      leader: false, share: true, state: lastState, displays: displaysInfo(), settings,
      origin: (() => { const r = screen.dipToScreenRect(null, d.bounds); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
    }));
    shareWin.loadFile('index.html', { query: { share: '1' } });
    shareWin.on('closed', () => { shareWin = null; updateTray(); });
    updateTray();
  }

  // --- settings window ---
  function openSettings(scope = 'all') {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.webContents.send('scope', scope); settingsWin.show(); settingsWin.focus(); return; }
    settingsWin = new BrowserWindow({
      width: settings.compactSettings ? 440 : 540, height: settings.compactSettings ? 640 : 800, minWidth: 400, minHeight: 420, title: 'Accretion', autoHideMenuBar: true, icon: ICON,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',   // Windows 11's base page colours
      webPreferences: { preload: PRELOAD },
    });
    settingsWin.setAlwaysOnTop(true, 'screen-saver', 1);   // above the overlays
    wirePage(settingsWin);
    settingsWin.webContents.on('did-finish-load', () => settingsWin.webContents.send('scope', scope));
    settingsWin.loadFile('settings.html');
    settingsWin.on('closed', () => { settingsWin = null; });
  }
  // First-launch tour: a few cards on the basics. Shown once (and any time from Settings -> Help).
  let tourWin = null;
  function openTour() {
    if (tourWin && !tourWin.isDestroyed()) { tourWin.focus(); return; }
    tourWin = new BrowserWindow({ width: 460, height: 400, resizable: false, minimizable: false, maximizable: false, title: 'Welcome to Accretion',
      autoHideMenuBar: true, icon: ICON, backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3', webPreferences: { preload: PRELOAD } });
    tourWin.setAlwaysOnTop(true, 'screen-saver', 1);
    wirePage(tourWin);
    tourWin.loadFile('tour.html');
    tourWin.on('closed', () => { tourWin = null; if (!settings.tourDone) { settings.tourDone = true; saveSettings(); } });
  }
  ipcMain.on('show-tour', openTour);
  ipcMain.on('tour-done', () => { settings.tourDone = true; saveSettings(); if (tourWin && !tourWin.isDestroyed()) tourWin.close(); });
  if (!settings.tourDone) setTimeout(openTour, 3500);

  // Self-test: check each part (graphics, screen capture, the window helper, sound, saving, shortcuts, monitors) and
  // say plainly what's wrong, if anything.
  ipcMain.handle('self-test', async () => {
    const out = [], add = (name, state, detail) => out.push({ name, state, detail });
    const timed = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);
    add('Version', 'pass', `Accretion ${app.getVersion()}, Electron ${process.versions.electron}, Windows ${os.release()}`);
    try {
      const g = await timed(leader.executeJavaScript(`(() => { const d = gl.getExtension('WEBGL_debug_renderer_info');
        return { renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), float: floatTargets, timer: !!gpuTimer, gpuMs, rscale, lost: gl.isContextLost() }; })()`), 3000);
      if (!g) add('Graphics', 'fail', 'The drawing page didn\'t answer. Try Pause and resume (Ctrl+Alt+P), or restart Accretion.');
      else if (g.lost) add('Graphics', 'fail', `The graphics card dropped Accretion's drawing (${g.renderer}). Restarting Accretion usually fixes it.`);
      else add('Graphics', g.float && g.rscale > 0.7 ? 'pass' : 'warn', `${g.renderer}. ${g.float ? '' : 'High-precision light isn\'t available, so glow is a little coarser. '}${g.rscale < 0.99 ? `It's drawing at ${Math.round(g.rscale * 100)}% resolution to keep up. ` : ''}${g.timer ? `Ray tracing takes about ${g.gpuMs >= 0 ? g.gpuMs.toFixed(1) : '?'} ms a frame.` : ''}`);
      const hz = Math.max(...screen.getAllDisplays().map(d => d.displayFrequency || 60));
      add('Frame rate', stats.fps >= Math.min(hz, 60) * 0.8 || stats.fps === 0 ? 'pass' : 'warn', stats.fps ? `${stats.fps} frames a second while busy (your fastest display runs at ${hz} Hz).` : 'Nothing is moving right now, so it\'s resting.');
    } catch (e) { add('Graphics', 'fail', e.message); }
    const t0 = Date.now();
    const shot = await timed(new Promise(res => { waiting.push({ cb: () => res(true) }); const d = screen.getPrimaryDisplay(), r = screen.dipToScreenRect(null, d.bounds); capture(r.x, r.y, 64, 64, true); }), 2500);
    add('Screen capture', shot ? (Date.now() - t0 < 120 ? 'pass' : 'warn') : 'fail', shot ? `Took ${Date.now() - t0} ms to grab part of the screen.${Date.now() - t0 >= 120 ? ' That\'s slow: the bent desktop may lag.' : ''}` : 'The screen capture helper didn\'t answer. It restarts by itself; if this keeps failing, your antivirus may be blocking ScreenCapture.exe.');
    const t1 = Date.now(), at = await timed(win32('AT 1 1'), 2500);
    add('Window helper', at ? 'pass' : 'fail', at ? `Answers in ${Date.now() - t1} ms (it's what lets the black hole eat windows and icons).` : 'It didn\'t answer, so eating windows and icons won\'t work. It restarts by itself; check your antivirus if it keeps failing.');
    try {
      const a = await timed(leader.executeJavaScript('({ ctx: typeof AudioContext, heard: !!listen.last })'), 2000);
      add('Sound', a?.ctx === 'function' ? 'pass' : 'fail', !settings.sound ? 'Sound is switched off (Settings -> Sound).' : settings.danceToMusic && !a?.heard ? 'Sound works. Dancing to music hasn\'t heard the PC\'s sound yet: that starts when something plays.' : 'Sound works.');
    } catch { add('Sound', 'warn', 'Couldn\'t check.'); }
    try {
      const f = path.join(app.getPath('userData'), 'selftest.tmp');
      fs.writeFileSync(f, 'ok'); fs.unlinkSync(f);
      add('Saving', 'pass', `Settings and pets save to ${app.getPath('userData')}.`);
    } catch (e) { add('Saving', 'fail', `Can't save settings or pets: ${e.message}`); }
    const taken = SHORTCUTS.filter(([k]) => !globalShortcut.isRegistered(k)).map(([k, w]) => `${k.replace('CommandOrControl', 'Ctrl')} (${w})`);
    add('Shortcuts', taken.length ? 'warn' : 'pass', taken.length ? `Another app already uses: ${taken.join(', ')}.` : 'All keyboard shortcuts work.');
    const ds = screen.getAllDisplays();
    add('Monitors', overlays().length >= ds.length ? 'pass' : 'warn', `${ds.length} monitor${ds.length > 1 ? 's' : ''}: ${ds.map(d => `${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)} at ${Math.round(d.scaleFactor * 100)}%`).join(', ')}.`);
    const mem = app.getAppMetrics().reduce((s, m) => s + (m.memory?.workingSetSize || 0), 0) / 1024;
    add('Memory', mem < 1500 ? 'pass' : 'warn', `About ${Math.round(mem)} MB in use.`);
    add('Start with Windows', 'pass', settings.startWithWindows ? 'On.' : 'Off (Settings -> System).');
    return out;
  });

  // Rename a hole from its name tag: a small box by the cursor.
  let renameWin = null;
  ipcMain.on('rename-prompt', (_e, id) => {
    const h = holeById(id);
    if (!h) return;
    if (renameWin && !renameWin.isDestroyed()) renameWin.close();
    const c = screen.getCursorScreenPoint();
    renameWin = new BrowserWindow({ width: 300, height: 108, x: c.x + 12, y: c.y + 12, resizable: false, minimizable: false, maximizable: false, frame: false,
      skipTaskbar: true, backgroundColor: nativeTheme.shouldUseDarkColors ? '#2b2b2b' : '#fbfbfb', webPreferences: { preload: PRELOAD } });
    renameWin.setAlwaysOnTop(true, 'screen-saver', 2);
    wirePage(renameWin);
    renameWin.loadFile('rename.html', { query: { id: String(id), name: h.name || '' } });
    renameWin.on('blur', () => { if (renameWin && !renameWin.isDestroyed()) renameWin.close(); });
    renameWin.on('closed', () => { renameWin = null; });
  });
  ipcMain.on('rename-close', () => { if (renameWin && !renameWin.isDestroyed()) renameWin.close(); });
  // Compact Settings: a smaller window.
  ipcMain.on('settings-compact', (_e, on) => {
    settings.compactSettings = !!on; saveSettings();
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setSize(on ? 440 : 540, on ? 640 : 800);
  });

  ipcMain.handle('get-settings', () => settings);
  ipcMain.handle('get-holes', () => (lastState?.holes || []).filter(h => !h.deathAt).map(holeInfo));
  ipcMain.on('rename', (_e, id, name) => toLeader({ type: 'rename', id, name: String(name || '') }));
  ipcMain.handle('accent', () => systemPreferences.getAccentColor?.() || '0078d4ff');   // the user's Windows accent colour
  // The fastest monitor's refresh rate: the most often the background can usefully be refreshed.
  ipcMain.handle('max-hz', () => Math.max(60, ...screen.getAllDisplays().map(d => Math.round(d.displayFrequency || 60))));
  const applySettings = () => {
    saveSettings();
    broadcast('settings', settings);
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings', settings);
    updateTray();
  };
  // Start with Windows: a login item that runs this same Electron with this app folder.
  const login = { path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] };   // (in development, Electron plus this folder)
  settings.startWithWindows = app.getLoginItemSettings(login).openAtLogin;
  const applyLogin = () => {
    if (app.getLoginItemSettings(login).openAtLogin !== !!settings.startWithWindows) app.setLoginItemSettings({ ...login, openAtLogin: !!settings.startWithWindows });
  };
  ipcMain.on('set-settings', (_e, patch) => { Object.assign(settings, patch); applySettings(); if ('startWithWindows' in patch) applyLogin(); });
  ipcMain.on('reset-settings', () => {
    settings = { ...structuredClone(DEFAULTS), looks: settings.looks, lastHoles: settings.lastHoles, achievements: settings.achievements,
                 counters: settings.counters, startWithWindows: settings.startWithWindows };
    applySettings();
  });
  ipcMain.on('set-hole', (_e, id, patch) => toLeader({ type: 'hole-settings', id, patch }));   // patch null = back to global
  ipcMain.handle('look-keys', () => LOOK_KEYS);

  // =====================  tray icon and shortcuts  =====================
  function setHidden(v) {
    hidden = v;
    for (const w of overlays()) {
      if (v) w.hide();
      else { w.showInactive(); w.setContentProtection(true); }
    }
    updateTray();
  }
  function setPaused(v) { paused = v; broadcast('paused', v); updateTray(); }
  function addHole() { toLeader({ type: 'add' }); }

  const SHORTCUTS = [
    ['CommandOrControl+Alt+N', 'Add a black hole', addHole],
    ['CommandOrControl+Alt+H', 'Hide / show', () => setHidden(!hidden)],
    ['CommandOrControl+Alt+P', 'Pause / resume', () => setPaused(!paused)],
    ['CommandOrControl+Alt+R', 'Spit out everything swallowed', releaseAll],
    ['CommandOrControl+Alt+Z', 'Undo last meal (spit it out)', () => undoMeal()],
    ['CommandOrControl+Alt+S', 'Screenshot', screenshotNow],
    ['CommandOrControl+Alt+M', 'Sound on / off', () => { settings.sound = !settings.sound; applySettings(); }],
    ['CommandOrControl+Shift+Q', 'Close (evaporate)', () => dieAll()],
  ];
  for (const [keys, what, fn] of SHORTCUTS) {
    if (!globalShortcut.register(keys, fn)) log('warn', `shortcut ${keys} (${what}) is taken by another app`);
  }
  ipcMain.handle('shortcuts', () => SHORTCUTS.map(([k, w]) => [k.replace('CommandOrControl', 'Ctrl'), w]));

  function updateTray() {
    if (!tray) return;
    const n = lastState?.holes.reduce((t, h) => t + h.meals.length, 0) || 0;
    const names = (lastState?.holes || []).filter(h => !h.deathAt).map(h => `${h.name} (${h.mood})`);
    tray.setToolTip(names.length ? `Accretion: ${names.join(', ')}`.slice(0, 127) : 'Accretion');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Add a black hole', accelerator: 'Ctrl+Alt+N', click: addHole },
      { label: 'Settings…', click: () => openSettings('all') },
      { label: 'Screenshot', accelerator: 'Ctrl+Alt+S', click: screenshotNow },
      { label: 'Share view (for screen sharing)', type: 'checkbox', checked: !!shareWin, click: toggleShareView },
      { type: 'separator' },
      { label: 'Pause', type: 'checkbox', checked: paused, accelerator: 'Ctrl+Alt+P', click: () => setPaused(!paused) },
      { label: 'Hide', type: 'checkbox', checked: hidden, accelerator: 'Ctrl+Alt+H', click: () => setHidden(!hidden) },
      { label: 'Sound', type: 'checkbox', checked: settings.sound, accelerator: 'Ctrl+Alt+M', click: () => { settings.sound = !settings.sound; applySettings(); } },
      ...(Object.keys(settings.profiles).length ? [{ label: 'Profile', submenu: Object.keys(settings.profiles).map(n => ({ label: n, click: () => loadProfile(n) })) }] : []),
      { label: 'Start with Windows', type: 'checkbox', checked: !!settings.startWithWindows, click: () => { settings.startWithWindows = !settings.startWithWindows; applySettings(); applyLogin(); } },
      ...(update.state === 'ready' ? [{ label: `Restart to update (${update.version})`, click: installUpdate }, { type: 'separator' }] : []),
      { label: 'Undo last meal', enabled: n > 0, accelerator: 'Ctrl+Alt+Z', click: () => undoMeal() },
      { label: n ? `Spit out everything swallowed (${n})` : 'Spit out everything swallowed', enabled: n > 0, accelerator: 'Ctrl+Alt+R', click: releaseAll },
      { type: 'separator' },
      { label: 'Open log folder', click: () => shell.openPath(path.dirname(logFile)) },
      { label: 'Quit', accelerator: 'Ctrl+Shift+Q', click: () => dieAll() },
    ]));
  }
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('Accretion');
  tray.on('double-click', () => openSettings('all'));
  updateTray();
  setInterval(updateTray, 3000);   // keeps the swallowed-window count current

  // =====================  updates  =====================
  // Installed copies check this project's GitHub Releases (the repository is set in package.json, build.publish) a minute
  // after starting and then every six hours. A new version downloads in the background and installs when you quit, or
  // straight away with "Restart to update". Running from source, or before a repository is set, it does nothing.
  // (update and updater are declared at the top of start(): the tray menu reads them before this runs)
  const updateConfig = path.join(process.resourcesPath || '', 'app-update.yml');
  const updatesSetUp = () => { try { return app.isPackaged && !/YOUR-GITHUB-NAME/.test(fs.readFileSync(updateConfig, 'utf8')); } catch { return false; } };
  function setUpdate(p) {
    Object.assign(update, p);
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update', update);
  }
  function startUpdater() {
    if (updater) return updater;
    updater = require('electron-updater').autoUpdater;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.logger = { info: m => log('info', '[update]', m), warn: m => log('warn', '[update]', m), error: m => log('error', '[update]', m), debug: () => {} };
    updater.on('checking-for-update', () => setUpdate({ state: 'checking', error: null }));
    updater.on('update-available', i => setUpdate({ state: 'downloading', version: i.version, percent: 0 }));
    updater.on('update-not-available', () => setUpdate({ state: 'current' }));
    updater.on('download-progress', p => setUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
    updater.on('update-downloaded', i => {
      setUpdate({ state: 'ready', version: i.version });
      log('info', `update ${i.version} downloaded`);
      broadcast('toast', { holeId: lastState?.holes.find(h => !h.deathAt)?.id, text: `Accretion ${i.version} is ready.`, sub: 'It installs when you quit, or restart from the tray.' });
      updateTray();
    });
    updater.on('error', e => setUpdate({ state: 'error', error: String(e?.message || e).split('\n')[0].slice(0, 200) }));
    return updater;
  }
  async function checkUpdates() {
    if (!updatesSetUp()) { setUpdate({ state: app.isPackaged ? 'unset' : 'dev' }); return update; }
    try { await startUpdater().checkForUpdates(); } catch (e) { setUpdate({ state: 'error', error: String(e?.message || e).split('\n')[0].slice(0, 200) }); }
    return update;
  }
  // Restart now: put everything back exactly as on a normal quit, then let the installer run and reopen Accretion.
  function installUpdate() {
    if (update.state !== 'ready' || !updater) return;
    exiting = dying = true;
    saveSettingsNow();
    log('info', `restarting to install ${update.version}`);
    try { winctl.stdin.write('SHOWALL\n'); winctl.stdin.end(); } catch { }
    cap.kill();
    setTimeout(() => updater.quitAndInstall(true, true), 400);
  }
  ipcMain.handle('update-check', () => checkUpdates());
  ipcMain.handle('update-state', () => update);
  ipcMain.on('update-install', installUpdate);
  if (settings.autoUpdate !== false) setTimeout(() => checkUpdates(), 60000);
  setInterval(() => { if (settings.autoUpdate !== false) checkUpdates(); }, 6 * 3600e3);

  // =====================  watchdog  =====================
  // The GPU process can die (a driver update, a crash): bring every overlay back. And if the physics page stops
  // sending its state for a few seconds while nothing should stop it, reload it (it picks up where it left off).
  app.on('child-process-gone', (_e, d) => {
    if (d.type !== 'GPU' || dying) return;
    log('error', `GPU process gone (${d.reason}); reloading the overlays`);
    crashReport('graphics process stopped', d);
    setTimeout(() => { for (const w of overlays()) if (!w.isDestroyed()) w.webContents.reload(); }, 1500);
  });
  setInterval(() => {
    if (dying || paused || hidden || !leader || leader.isDestroyed() || Date.now() - lastStateAt < 6000) return;
    if (powerMonitor.getSystemIdleState(1) === 'locked') return;   // frames stop while the PC is locked; that's fine
    log('warn', 'the physics page stopped answering; reloading it');
    lastStateAt = Date.now();
    leader.reload();
  }, 2000);

  // =====================  closing and crash safety  =====================
  let exiting = false;
  function exitApp() {
    if (exiting) return;
    exiting = dying = true;
    saveSettingsNow();
    log('info', 'quitting');
    try { winctl.stdin.write('SHOWALL\n'); winctl.stdin.end(); } catch { /* it restores on exit anyway */ }
    cap.kill();
    setTimeout(() => {   // let the window helper put everything back
      if (update.state === 'ready' && updater) { updater.quitAndInstall(true, false); setTimeout(() => app.exit(0), 8000); }
      else app.exit(0);
    }, 300);
  }
  function dieAll() {
    if (dying) return;
    dying = true;
    toLeader({ type: 'die-all' });
    setTimeout(exitApp, DEATH_MS + 1000);   // in case the pages never report back
  }
  process.on('uncaughtException', err => {
    log('error', 'uncaught exception:', err);
    crashReport('main process error', err?.stack || String(err));
    try { winctl.stdin.write('SHOWALL\n'); } catch { /* nothing more to do */ }
  });
  process.on('unhandledRejection', err => log('error', 'unhandled rejection:', err));
  app.on('before-quit', e => { if (!dying) { e.preventDefault(); dieAll(); } });
  app.on('window-all-closed', () => {});   // overlays come and go with monitors; quitting goes through dieAll()
  app.on('second-instance', () => addHole());
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
