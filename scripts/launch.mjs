import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const address = `http://127.0.0.1:${port}`;
async function running() {
  let response;
  try { response = await fetch(`${address}/api/studio`, { signal: AbortSignal.timeout(2000) }); }
  catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return false;
    throw new Error(`Could not check ${address}. ${error.message}`);
  }
  let value;
  try { value = await response.json(); } catch { }
  if (!response.ok || !value?.runtime || !value?.settings || typeof value.token !== 'string') {
    throw new Error(`Another application is using port ${port}. Close it or choose a different PORT.`);
  }
  return true;
}
function openBrowser() {
  if (process.argv.includes('--no-browser')) return;
  const browser = spawn('cmd.exe', ['/d', '/c', 'start', address], { windowsHide: true, stdio: 'ignore' });
  browser.on('error', () => console.log(`Open ${address} in your browser.`));
  browser.on('exit', code => { if (code) console.log(`Open ${address} in your browser.`); });
}
try {
  if (await running()) {
    console.log(`YuE2 Studio is already running at ${address}. Opening the app.`);
    openBrowser();
  } else {
    console.log('Starting YuE2 Studio. Keep this window open while using the app.');
    const child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, stdio: 'inherit', windowsHide: true });
    let exited = false;
    child.on('error', error => { exited = true; console.error(error.message); process.exitCode = 1; });
    child.on('exit', code => { exited = true; process.exitCode = code ?? 1; });
    let started = false;
    for (let attempt = 0; attempt < 100 && !exited; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (await running()) { started = true; openBrowser(); break; }
    }
    if (!started && !exited) { child.kill(); throw new Error(`The app did not start. Check the messages above, then try again.`); }
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
