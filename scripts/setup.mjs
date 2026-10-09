import { mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'runtime');
const sheetSage = process.argv.includes('--sheetsage');
const model = path.join(root, 'models', sheetSage ? 'SheetSage2' : 'YuE2');
await mkdir(runtime, { recursive: true });
await mkdir(path.join(model, 'sidecars'), { recursive: true });
await mkdir(path.join(root, 'data'), { recursive: true });
const stateFile = path.join(root, 'data', sheetSage ? 'setup-sheetsage.json' : 'setup.json');
async function state(value) { await writeFile(stateFile, JSON.stringify({ ...value, updatedAt: new Date().toISOString() })); }
async function json(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'YuE2-Studio' } });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.json();
}
async function hash(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
async function download(url, file, expected, expectedHash) {
  const name = path.basename(file);
  const existing = await stat(file).catch(() => null);
  if (existing && existing.size === expected && (!expectedHash || await hash(file) === expectedHash)) {
    console.log(`Already installed: ${name}`); return;
  }
  await state({ status: 'downloading', file: name, bytes: 0, total: expected });
  console.log(`Downloading ${name} (${(expected / 1e9).toFixed(2)} GB)`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} downloading ${name}`);
  let bytes = 0, last = 0;
  const meter = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    if (Date.now() - last > 2000) {
      last = Date.now();
      state({ status: 'downloading', file: name, bytes, total: expected }).catch(() => {});
    }
    callback(null, chunk);
  } });
  await pipeline(res.body, meter, createWriteStream(file + '.partial'));
  if (expected && bytes !== expected) throw new Error(`Incomplete download: ${name}`);
  if (expectedHash && await hash(file + '.partial') !== expectedHash) throw new Error(`Checksum mismatch: ${name}`);
  await rename(file + '.partial', file);
  console.log(`Verified ${name}`);
}
function extract(file) {
  return new Promise((resolve, reject) => {
    const quote = text => "'" + text.replaceAll("'", "''") + "'";
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${quote(file)} -DestinationPath ${quote(runtime)} -Force`], { windowsHide: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Archive extraction exited ${code}`)));
  });
}
try {
  // Pin a known release; CUDA 13.3 supports this PC's Blackwell GPU.
  const release = !sheetSage ? await json('https://api.github.com/repos/0xShug0/audio.cpp/releases/tags/v0.9.0') : null;
  for (const suffix of sheetSage ? [] : ['bin-windows-x64-cuda13.3.zip', 'cudart-windows-x64-cuda13.3.zip']) {
    const asset = release.assets.find(a => a.name.endsWith(suffix));
    if (!asset) throw new Error(`Runtime archive missing: ${suffix}`);
    const file = path.join(runtime, asset.name);
    await download(asset.browser_download_url, file, asset.size, asset.digest?.replace(/^sha256:/, ''));
    await state({ status: 'extracting', file: asset.name });
    await extract(file);
  }
  const repo = sheetSage ? 'audio-cpp/SheetSage2-GGUF' : 'audio-cpp/Yue2-3B-GGUF';
  const info = await json(`https://huggingface.co/api/models/${repo}?blobs=true`);
  const wanted = sheetSage ? ['sheetsage2-orig.gguf'] : ['yue2-3b-q4_0.gguf', 'yue2-vae-f16.gguf', 'sidecars/yue2-model-config.json', 'sidecars/yue2-generation-config.json', 'sidecars/yue2-qwen.tiktoken', 'sidecars/yue2-vae-config.json'];
  for (const name of wanted) {
    const entry = info.siblings.find(s => s.rfilename === name);
    if (!entry) throw new Error(`Model file missing: ${name}`);
    await download(`https://huggingface.co/${repo}/resolve/${info.sha}/${name}`, path.join(model, name), entry.size, entry.lfs?.sha256);
  }
  await writeFile(path.join(model, 'installation.json'), JSON.stringify({ repo: info.id, revision: info.sha, runtime: 'v0.9.0', installedAt: new Date().toISOString() }, null, 2));
  await state({ status: 'ready' });
  console.log(`${sheetSage ? 'SheetSage2' : 'YuE2'} is ready. Run npm start, then open http://127.0.0.1:3210`);
} catch (error) {
  await state({ status: 'failed', error: error.message });
  console.error(error);
  process.exitCode = 1;
}
