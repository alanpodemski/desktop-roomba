// Sanity-check the exported GLB files without a DOM: parse the JSON chunk and list nodes.
//   node blender/check_glb.mjs
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
let threeVersion = 'n/a';
try { threeVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'three', 'package.json'), 'utf8')).version; } catch {}

const REQUIRED = {
  'roomba.glb': ['Body', 'Bumper', 'Buttons', 'Turret', 'WheelL', 'WheelR', 'Caster', 'SideBrush', 'Roller', 'EyeL', 'EyeR'],
  'dock.glb': ['DockBase', 'DockContacts', 'DockTower', 'DockLED'],
  'cake.glb': ['CakeSponge', 'CakeFilling', 'CakeFrosting', 'CakeTopping', 'CakeCrumbs', 'CakeSquashed'],
};

function parseGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB: ' + path);
  const version = buf.readUInt32LE(4);
  const chunkLen = buf.readUInt32LE(12);
  const chunkType = buf.readUInt32LE(16);
  if (chunkType !== 0x4e4f534a) throw new Error('first chunk is not JSON');
  const json = JSON.parse(buf.subarray(20, 20 + chunkLen).toString('utf8'));
  return { version, json };
}

let ok = true;
for (const [file, required] of Object.entries(REQUIRED)) {
  const path = join(root, 'public', 'models', file);
  const size = statSync(path).size;
  const { version, json } = parseGlb(path);
  const nodeNames = (json.nodes ?? []).map((n) => n.name);
  const missing = required.filter((n) => !nodeNames.includes(n));
  const tris = (json.meshes ?? []).flatMap((m) => m.primitives).reduce((acc, p) => {
    const a = json.accessors[p.indices];
    return acc + (a ? a.count / 3 : 0);
  }, 0);
  console.log(`\n${file}: ${(size / 1024).toFixed(0)} kB, glTF v${version}, ${json.meshes?.length ?? 0} meshes, ~${tris} tris`);
  console.log('  generator        :', json.asset?.generator);
  console.log('  extensionsUsed   :', (json.extensionsUsed ?? []).join(', ') || '-');
  console.log('  extensionsRequired:', (json.extensionsRequired ?? []).join(', ') || '-');
  console.log('  images           :', (json.images ?? []).map((i) => `${i.name ?? '?'} (${i.mimeType})`).join(', ') || '-');
  console.log('  materials        :', (json.materials ?? []).map((m) => m.name).join(', '));
  for (const n of json.nodes ?? []) {
    const t = n.translation ? n.translation.map((v) => v.toFixed(4)).join(', ') : '0, 0, 0';
    const kids = n.children ? ` children=[${n.children.map((c) => json.nodes[c].name).join(', ')}]` : '';
    const ex = n.extras ? ` extras=${JSON.stringify(n.extras)}` : '';
    console.log(`  node ${n.name.padEnd(13)} t=(${t})${n.mesh !== undefined ? ' mesh' : ''}${kids}${ex}`);
  }
  if (missing.length) { ok = false; console.log('  MISSING:', missing.join(', ')); }
  else console.log('  all required nodes present');
  if (size > 3 * 1024 * 1024) { ok = false; console.log('  TOO LARGE (> 3 MB)'); }
}
console.log(`\nthree version in node_modules: ${threeVersion}`);
process.exit(ok ? 0 : 1);
