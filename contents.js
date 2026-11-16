// Looking inside files a black hole is fed, without changing them: the triangles of a 3D model (to draw it as a
// wireframe) and the list of files in a zip (to burst it open). Everything here reads untrusted files, so sizes are
// capped and any malformed file simply gives null.
const fs = require('fs');
const path = require('path');

const MAX_TRIS = 20000;        // drawn; bigger models are thinned out evenly
const MAX_FILE = 200e6;        // bytes read from a model file

// Keep at most MAX_TRIS triangles (9 floats each), spread evenly through the model.
function thin(tris) {
  const n = tris.length / 9;
  if (n <= MAX_TRIS) return tris;
  const out = new Float32Array(MAX_TRIS * 9), step = n / MAX_TRIS;
  for (let i = 0; i < MAX_TRIS; i++) out.set(tris.subarray(Math.floor(i * step) * 9, Math.floor(i * step) * 9 + 9), i * 9);
  return out;
}

// Wavefront OBJ: "v x y z" vertices and "f a b c ..." faces (indices may be negative, or a/b/c), fanned into triangles.
function parseObj(text) {
  const v = [], tris = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) { const p = line.trim().split(/\s+/); v.push(+p[1], +p[2], +p[3]); }
    else if (line.startsWith('f ')) {
      const idx = line.trim().split(/\s+/).slice(1).map(s => { const i = parseInt(s, 10); return i < 0 ? v.length / 3 + i : i - 1; });
      for (let k = 1; k + 1 < idx.length; k++) for (const i of [idx[0], idx[k], idx[k + 1]]) {
        if (!(i >= 0 && i * 3 + 2 < v.length)) return null;
        tris.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
      }
      if (tris.length > MAX_TRIS * 9 * 20) break;   // plenty to draw from
    }
  }
  return tris.length ? new Float32Array(tris) : null;
}

// STL, text or binary.
function parseStl(buf) {
  const head = buf.subarray(0, 1024).toString('latin1');
  if (/^\s*solid/.test(head) && /facet/.test(head)) {
    const nums = [...buf.toString('latin1').matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].slice(0, MAX_TRIS * 3 * 20);
    return nums.length >= 3 ? new Float32Array(nums.flatMap(m => [+m[1], +m[2], +m[3]])) : null;
  }
  const n = buf.readUInt32LE(80);
  if (n === 0 || 84 + n * 50 > buf.length) return null;
  const out = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) out[i * 9 + k] = buf.readFloatLE(84 + i * 50 + 12 + k * 4);
  return out;
}

// glTF 2.0 (.gltf with its buffers, or binary .glb): every triangle primitive's POSITION, through its indices.
function parseGltfJson(json, buffers) {
  const SIZE = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
  const read = (acc, comps) => {   // an accessor's values as plain numbers
    const bv = json.bufferViews[acc.bufferView], buf = buffers[bv.buffer];
    const size = SIZE[acc.componentType], stride = bv.byteStride || size * comps, base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    if (!buf || !size || base + stride * (acc.count - 1) + size * comps > buf.length) throw new Error('out of range');
    const get = { 5121: o => buf.readUInt8(o), 5123: o => buf.readUInt16LE(o), 5125: o => buf.readUInt32LE(o), 5126: o => buf.readFloatLE(o) }[acc.componentType];
    const out = new Float64Array(acc.count * comps);
    for (let i = 0; i < acc.count; i++) for (let c = 0; c < comps; c++) out[i * comps + c] = get(base + i * stride + c * size);
    return out;
  };
  const tris = [];
  for (const mesh of json.meshes || []) for (const prim of mesh.primitives || []) {
    if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION == null || prim.extensions) continue;   // (compressed meshes are skipped)
    const pos = read(json.accessors[prim.attributes.POSITION], 3);
    const idx = prim.indices != null ? read(json.accessors[prim.indices], 1) : Array.from({ length: pos.length / 3 }, (_, i) => i);
    for (const i of idx) { if (i * 3 + 2 >= pos.length) return null; tris.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); }
    if (tris.length > MAX_TRIS * 9 * 20) break;
  }
  return tris.length >= 9 ? new Float32Array(tris.slice(0, tris.length - tris.length % 9)) : null;
}
function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) return null;   // "glTF"
  let json = null, bin = null;
  for (let o = 12; o + 8 <= buf.length;) {
    const len = buf.readUInt32LE(o), type = buf.readUInt32LE(o + 4), data = buf.subarray(o + 8, o + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    o += 8 + len;
  }
  return json ? parseGltfJson(json, (json.buffers || []).map((b, i) => i === 0 ? bin : null)) : null;
}
function parseGltf(file, text) {
  const json = JSON.parse(text), dir = path.dirname(file);
  const buffers = (json.buffers || []).map(b => {
    if (!b.uri) return null;
    if (b.uri.startsWith('data:')) return Buffer.from(b.uri.slice(b.uri.indexOf(',') + 1), 'base64');
    const f = path.resolve(dir, decodeURIComponent(b.uri));
    if (!f.startsWith(dir + path.sep) || !fs.existsSync(f) || fs.statSync(f).size > MAX_FILE) return null;   // only its own files, beside it
    return fs.readFileSync(f);
  });
  return parseGltfJson(json, buffers);
}

const MODEL = /\.(obj|stl|glb|gltf)$/i;
// The model's triangles as a Float32Array (9 numbers each), or null.
function readModel(file) {
  try {
    if (!MODEL.test(file) || fs.statSync(file).size > MAX_FILE) return null;
    const buf = fs.readFileSync(file), ext = path.extname(file).toLowerCase();
    const tris = ext === '.obj' ? parseObj(buf.toString('utf8')) : ext === '.stl' ? parseStl(buf)
               : ext === '.glb' ? parseGlb(buf) : parseGltf(file, buf.toString('utf8'));
    return tris && tris.every(Number.isFinite) ? thin(tris) : null;
  } catch { return null; }
}

// A zip's files (names and sizes) from its central directory, without extracting anything.
function zipEntries(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, tailLen = Math.min(size, 66000), tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }   // end of central directory
    if (e < 0) return null;
    let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (cdOff === 0xffffffff && e >= 20 && tail.readUInt32LE(e - 20) === 0x07064b50) {   // zip64
      const z = Buffer.alloc(56);
      fs.readSync(fd, z, 0, 56, Number(tail.readBigUInt64LE(e - 20 + 8)));
      if (z.readUInt32LE(0) !== 0x06064b50) return null;
      count = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
    }
    if (cdSize > 64e6 || cdOff + cdSize > size) return null;
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const out = [];
    for (let o = 0, k = 0; k < count && o + 46 <= cd.length; k++) {
      if (cd.readUInt32LE(o) !== 0x02014b50) break;
      const n = cd.readUInt16LE(o + 28), x = cd.readUInt16LE(o + 30), c = cd.readUInt16LE(o + 32);
      const name = cd.subarray(o + 46, o + 46 + n).toString(cd.readUInt16LE(o + 8) & 0x800 ? 'utf8' : 'latin1');
      if (!name.endsWith('/')) out.push({ name, size: cd.readUInt32LE(o + 24) });
      o += 46 + n + x + c;
    }
    return out;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { readModel, zipEntries, MODEL };

// Self-check: node contents.js
if (require.main === module) {
  const os = require('os'), t = fs.mkdtempSync(path.join(os.tmpdir(), 'accretion-contents-'));
  fs.writeFileSync(path.join(t, 'q.obj'), 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n');
  const q = readModel(path.join(t, 'q.obj'));
  console.assert(q && q.length === 18, 'obj quad -> 2 triangles');
  const stl = Buffer.alloc(84 + 50); stl.writeUInt32LE(1, 80); [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((f, i) => stl.writeFloatLE(f, 84 + 12 + i * 4));
  fs.writeFileSync(path.join(t, 'a.stl'), stl);
  console.assert(readModel(path.join(t, 'a.stl'))?.length === 9, 'binary stl');
  fs.writeFileSync(path.join(t, 'bad.glb'), Buffer.from('nonsense'));
  console.assert(readModel(path.join(t, 'bad.glb')) === null, 'bad glb is null');
  console.log('contents.js self-check done');
}
