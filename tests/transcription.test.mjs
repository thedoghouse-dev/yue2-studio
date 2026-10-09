import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createStudio, validateAudioName, buildTranscriptionArgs } from '../server.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('validate audio file paths and native transcription arguments', () => {
  for (const name of ['../audio.wav', 'C:\\audio.wav', 'file.exe', '', null]) assert.throws(() => validateAudioName(name));
  assert.equal(validateAudioName('A song.MP3').extension,'.mp3');
  assert.equal(validateAudioName('My-melody.webm').extension,'.webm');
  const args = buildTranscriptionArgs({sheetSageModel:'D:\\models\\model.gguf',backend:'cuda'},'D:\\score');
  assert.equal(args[args.indexOf('--family')+1],'sheetsage2'); assert.equal(args[args.indexOf('--task')+1],'midi');
});
test('audio upload, shared queue, score downloads, conversion failure and transcription failure', async t => {
  const parent = path.join(root,'.test-tmp'); mkdirSync(parent,{recursive:true}); const temp = mkdtempSync(path.join(parent,'transcription-'));
  const app = createStudio({root:temp,checkRuntime:()=>({ready:true,missing:[]}),checkSheetSage:()=>({ready:true,missing:[]}),spawnRunner:(_exe,args,options)=>spawn(process.execPath,[path.join(root,'tests','fixture-cli.mjs'),...args],{...options,cwd:temp})});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve)); const base = `http://127.0.0.1:${app.server.address().port}`;
  const token = (await (await fetch(base+'/api/studio')).json()).token;
  const headers = {'X-Studio-Token':token};
  const audio = Buffer.alloc(100,'a');
  async function upload(data=audio,name='original.mp3') {
    return fetch(base+`/api/transcriptions?filename=${encodeURIComponent(name)}&title=My%20score`,{method:'POST',headers,body:data});
  }
  async function waitFor(id,status) {
    for(let i=0;i<150;i++) { const db=await(await fetch(base+'/api/studio')).json(); const job=db.transcriptions.find(j=>j.id===id);if(job.status===status)return job;await new Promise(r=>setTimeout(r,20)); }
    assert.fail(`Transcription never reached ${status}`);
  }
  t.after(async()=>{await app.close(); assert.ok(temp.startsWith(parent+path.sep));rmSync(temp,{recursive:true,force:true});});
  const unauthorized = await fetch(base+'/api/transcriptions?filename=x.wav&title=Score',{method:'POST',body:audio});assert.equal(unauthorized.status,403);
  assert.equal((await upload(audio,'../bad.wav')).status,400);assert.equal((await upload(Buffer.alloc(1))).status,400);
  const slow = await(await fetch(base+'/api/songs',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({title:'Waiting song',lyrics:'SLOW',style:'folk'})})).json();
  const job=await(await upload()).json(); await new Promise(r=>setTimeout(r,100));
  const waiting=await(await fetch(base+'/api/studio')).json();assert.equal(waiting.transcriptions[0].status,'queued');
  await fetch(base+`/api/songs/${slow.id}/cancel`,{method:'POST',headers});
  assert.equal((await waitFor(job.id,'completed')).hasScore,true);
  const score=await fetch(base+`/api/transcriptions/${job.id}/score?download`);assert.equal(score.status,200);assert.match(score.headers.get('content-disposition'),/attachment/);assert.match(await score.text(),/K:C/);
  assert.equal((await fetch(base+`/api/transcriptions/${job.id}/events`)).status,200);
  assert.equal((await fetch(base+`/api/transcriptions/${job.id}/audio`)).status,200);
  const micJob = await (await upload(audio, 'My-melody.webm')).json();
  assert.equal((await waitFor(micJob.id,'completed')).hasScore,true);
  const render=await fetch(base+`/api/transcriptions/${job.id}/render`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({svg:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M0 0 L20 20"/></svg>'})});assert.equal(render.status,200);
  const svg=await fetch(base+`/api/transcriptions/${job.id}/svg`);assert.equal(svg.status,200);assert.equal(svg.headers.get('content-type'),'image/svg+xml');assert.match(await svg.text(),/<path/);
  const invalid=await(await upload(Buffer.from('FAIL invalid audio data'))).json();assert.equal((await waitFor(invalid.id,'failed')).hasScore,false);
  const failed=await(await upload(Buffer.from('SCOREFAIL valid conversion test'))).json();assert.equal((await waitFor(failed.id,'failed')).hasScore,false);
  assert.equal((await fetch(base+`/api/transcriptions/${failed.id}/score`)).status,409);
});
