import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createStudio, validateSong, buildArgs } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = { title: 'A real request', style: 'English, folk', lyrics: '[Verse]\nSing the dawn', seed: 42, mode: 'full', maxTokens: 1500, steps: 8, temperature: 1, abc: '' };
test('reject invalid requests and preserve literal lyrics without shell interpretation', () => {
  for (const durationSeconds of [9,361,10.5,NaN,true]) assert.throws(()=>validateSong({...input,durationSeconds}));
  for (const durationSeconds of [10,60,180,360]) {
    const timed=validateSong({...input,durationSeconds});assert.equal(timed.durationSeconds,durationSeconds);assert.equal(timed.maxTokens,durationSeconds*25);
  }
  assert.equal(validateSong(input).durationSeconds,null);assert.equal(validateSong(input).maxTokens,input.maxTokens);
  assert.throws(()=>validateSong({...input,durationMode:'bad'}));assert.throws(()=>validateSong({...input,scoreUse:'bad'}));
  const target=validateSong({...input,durationSeconds:90,durationMode:'target',scoreUse:'motif',abc:'X:1\nK:C\nC D E F |'});
  const targetArgs=buildArgs(target,{modelDir:'D:\\models',backend:'cuda',modelFile:'yue2-3b-q4_0.gguf'},'D:\\output');
  assert.ok(targetArgs.includes('semantic_min_tokens=2200'));assert.ok(targetArgs.includes('semantic_max_tokens=2250'));
  assert.ok(targetArgs.some(value=>value.includes('develop the supplied melody as a recurring motif')));
  const cap=buildArgs({...target,durationMode:'maximum'},{modelDir:'D:\\models',backend:'cuda',modelFile:'yue2-3b-q4_0.gguf'},'D:\\output');assert.ok(cap.includes('semantic_min_tokens=200'));
  for (const override of [{ seed: -1 }, { seed: 1.5 }, { maxTokens: 9001 }, { steps: 0 }, { temperature: NaN }, { title: '' }, { lyrics: 42 }, { mode: 'bad' }, { abc: 'K:C', mode: 'off' }]) assert.throws(() => validateSong({ ...input, ...override }));
  for (const lyrics of ['', '   ', undefined]) {
    const instrumental = validateSong({ ...input, lyrics });
    const instrumentalArgs = buildArgs(instrumental, {modelDir:'D:\\models',backend:'cuda',modelFile:'yue2-3b-q4_0.gguf'}, 'D:\\output');
    assert.equal(instrumentalArgs[instrumentalArgs.indexOf('--lyrics') + 1], '[instrumental]');
    assert.ok(instrumentalArgs.includes('style=instrumental, no vocals, no singing, ' + input.style));
  }
  const song = validateSong({ ...input, lyrics: '[Verse]\n$(anything) "quotes" `literal`\nHello' });
  const args = buildArgs(song, { modelDir: 'D:\\a folder', backend: 'cuda', modelFile: 'yue2-3b-q4_0.gguf' }, 'D:\\songs');
  assert.equal(args[args.indexOf('--lyrics') + 1], song.lyrics);
  assert.ok(args.includes('cot=full')); assert.ok(args.includes('semantic_max_tokens=1500'));
  const scored=validateSong({...input,abc:'X:1\nM:4/4\nK:C\nCDEF G2 G2 |',lyrics:'[Verse]\nThese are my own lyrics'});
  const scoreArgs=buildArgs(scored,{modelDir:'D:\\models',backend:'cuda',modelFile:'yue2-3b-q4_0.gguf'},path.join(root,'data','score-test'));
  assert.equal(scoreArgs[scoreArgs.indexOf('--lyrics')+1],scored.lyrics);
  assert.ok(scoreArgs.includes(`abc_file=${path.join(root,'data','score-test','input.abc')}`));
});

test('HTTP generation lifecycle, queue, files, security, failure, cancellation, persistence', async t => {
  const tempParent = path.join(root, '.test-tmp'); mkdirSync(tempParent, { recursive: true });
  const temp = mkdtempSync(path.join(tempParent, 'studio-'));
  let app, url, token;
  const spawnRunner = (_exe, args, options) => spawn(process.execPath, [path.join(root, 'tests', 'fixture-cli.mjs'), ...args], { ...options, cwd: temp });
  async function start() {
    app = createStudio({ root: temp, spawnRunner, checkRuntime: () => ({ ready: true, missing: [] }) });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${app.server.address().port}`;
    token = (await (await fetch(url + '/api/studio')).json()).token;
  }
  async function request(route, method = 'GET', body) {
    return fetch(url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function waitFor(id, status) {
    for (let i = 0; i < 100; i++) {
      const song = await (await request(`/api/songs/${id}`)).json();
      if (song.status === status) return song;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`Song did not reach ${status}`);
  }
  t.after(async () => {
    if (app?.server.listening) await app.close();
    // Only remove our explicitly created test directory under this workspace.
    assert.ok(temp.startsWith(tempParent + path.sep)); rmSync(temp, { recursive: true, force: true });
  });
  await start();
  const unauthorized = await fetch(url + '/api/songs', { method: 'POST', body: JSON.stringify(input) }); assert.equal(unauthorized.status, 403);
  const foreign = await fetch(url + '/api/studio', { headers: { Origin: 'https://example.org' } }); assert.equal(foreign.status, 403);
  const rebind = await new Promise((resolve, reject) => {
    const req = http.get(url + '/api/studio', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  }); assert.equal(rebind, 403);
  const bad = await request('/api/songs', 'POST', { ...input, seed: -1 }); assert.equal(bad.status, 400);
  const one = await (await request('/api/songs', 'POST', input)).json();
  const two = await (await request('/api/songs', 'POST', { ...input, title: 'Second' })).json();
  const result = await waitFor(one.id, 'completed'); assert.equal(result.hasAudio, true); assert.equal(result.hasScore, true); assert.equal(result.truncated, true);
  const second = await waitFor(two.id, 'completed'); assert.ok(Date.parse(second.startedAt) >= Date.parse(result.finishedAt));
  const download = await request(`/api/songs/${one.id}/audio?download`); assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment/); assert.equal((await download.arrayBuffer()).byteLength, 244);
  const range = await fetch(`${url}/api/songs/${one.id}/audio`, { headers: { Range: 'bytes=0-3' } }); assert.equal(range.status, 206); assert.equal(await range.text(), 'RIFF');
  const invalidRange = await fetch(`${url}/api/songs/${one.id}/audio`, { headers: { Range: 'bytes=9999-' } }); assert.equal(invalidRange.status, 416);
  const score = await request(`/api/songs/${one.id}/score`); assert.match(await score.text(), /K:C/);
  const userABC='X:1\nT:Chosen sheet music\nM:4/4\nL:1/8\nK:C\nCDEF G2 G2 |';
  const lyricDraft=await(await request('/api/lyrics','POST',{title:'Source draft',lyrics:'[Verse]\nMy words follow this melody',model:''})).json();
  assert.equal((await request('/api/songs','POST',{...input,lyricSource:'11111111-1111-1111-1111-111111111111'})).status,400);
  assert.equal((await request('/api/songs','POST',{...input,scoreSource:'song:11111111-1111-1111-1111-111111111111'})).status,400);
  const withScore=await(await request('/api/songs','POST',{...input,abc:userABC,lyricSource:lyricDraft.id,scoreSource:'song:'+one.id,lyrics:'[Verse]\nMy words follow this melody'})).json();
  assert.equal((await waitFor(withScore.id,'completed')).hasAudio,true);
  assert.equal(await(await request(`/api/songs/${withScore.id}/score`)).text(),userABC);
  const stored=await(await request(`/api/songs/${withScore.id}/request`)).json();assert.equal(stored.lyricSource,lyricDraft.id);assert.equal(stored.scoreSource,'song:'+one.id);assert.equal(stored.abc,userABC);assert.equal(stored.lyrics,'[Verse]\nMy words follow this melody');
  const failed = await (await request('/api/songs', 'POST', { ...input, lyrics: 'FAIL' })).json(); assert.equal((await waitFor(failed.id, 'failed')).hasAudio, false);
  const slow = await (await request('/api/songs', 'POST', { ...input, lyrics: 'SLOW' })).json(); await waitFor(slow.id, 'running');
  const blocked = await request('/api/settings', 'PUT', {}); assert.equal(blocked.status, 409);
  const queued = await (await request('/api/songs', 'POST', input)).json();
  assert.equal((await request(`/api/songs/${queued.id}/cancel`, 'POST', {})).status, 200);
  assert.equal((await request(`/api/songs/${slow.id}/cancel`, 'POST', {})).status, 200);
  await waitFor(slow.id, 'cancelled');
  await request('/api/draft', 'PUT', { title: 'Persistent draft', lyrics: 'Some words' });
  await app.close();
  const dbFile = path.join(temp, 'data', 'studio.json'); const db = JSON.parse(readFileSync(dbFile, 'utf8'));
  db.songs.push({ ...input, id: '11111111-1111-1111-1111-111111111111', status: 'running' }); writeFileSync(dbFile, JSON.stringify(db));
  await start(); const restored = await (await request('/api/studio')).json();
  assert.equal(restored.songs.find(s=>s.id===withScore.id).lyricSource,lyricDraft.id); assert.equal(restored.songs.find(s=>s.id===withScore.id).scoreSource,'song:'+one.id); assert.equal(restored.draft.title, 'Persistent draft'); assert.equal(restored.songs.find(s => s.id === one.id).status, 'completed'); assert.equal(restored.songs[0].status, 'interrupted');
});
