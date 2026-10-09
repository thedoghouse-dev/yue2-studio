import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { masterAudio, readLoudness, MASTER_PRESETS } from '../mastering.mjs';
import { createStudio } from '../server.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ffmpeg = path.join(root,'node_modules','@ffmpeg-installer','win32-x64','ffmpeg.exe');
const parent = path.join(root,'.test-tmp');
function fixture(t) {
  mkdirSync(parent,{recursive:true}); const temp=mkdtempSync(path.join(parent,'master-'));
  t.after(()=>{assert.ok(temp.startsWith(parent+path.sep));rmSync(temp,{recursive:true,force:true});}); return temp;
}
function wav(silent=false) {
  const frames=48000*8, data=Buffer.alloc(44+frames*4);
  data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(2,22);data.writeUInt32LE(48000,24);data.writeUInt32LE(192000,28);data.writeUInt16LE(4,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(frames*4,40);
  for(let i=0;!silent&&i<frames;i++) {
    const time=i/48000, envelope=0.10+0.055*Math.sin(time*2);
    const sample=Math.round(32767*envelope*(Math.sin(2*Math.PI*220*time)+0.25*Math.sin(2*Math.PI*1100*time)));
    data.writeInt16LE(sample,44+i*4);data.writeInt16LE(sample,46+i*4);
  } return data;
}
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
function format(file) {
  const data=readFileSync(file);let result={};
  for(let pos=12;pos+8<=data.length;) {
    const size=data.readUInt32LE(pos+4),name=data.toString('ascii',pos,pos+4),start=pos+8;
    if(name==='fmt ') result={channels:data.readUInt16LE(start+2),rate:data.readUInt32LE(start+4),bytesPerSecond:data.readUInt32LE(start+8),bits:data.readUInt16LE(start+14)};
    if(name==='data')result.seconds=size/result.bytesPerSecond;
    pos=start+size+(size%2);
  }return result;
}
test('three presets master real audio with measured loudness, preserved timing and untouched original',async t=>{
  const temp=fixture(t), source=path.join(temp,'original.wav');writeFileSync(source,wav());const before=hash(source);
  for(const preset of Object.keys(MASTER_PRESETS)) {
    const output=path.join(temp,preset+'.wav');const measurements=await masterAudio(ffmpeg,source,output,preset);
    const metadata=format(output);assert.equal(metadata.bits,24);assert.equal(metadata.rate,48000);assert.equal(metadata.channels,2);assert.ok(Math.abs(metadata.seconds-8)<0.02);
    const check=spawnSync(ffmpeg,['-hide_banner','-i',output,'-af','loudnorm=print_format=json','-f','null','-'],{encoding:'utf8',windowsHide:true});assert.equal(check.status,0);
    const loudness=readLoudness(check.stderr);assert.ok(Math.abs(Number(loudness.input_i)-MASTER_PRESETS[preset].loudness)<0.8);assert.ok(Number(loudness.input_tp)<=-1.2);
    assert.equal(measurements.bitDepth,24);assert.equal(hash(source),before);assert.equal(existsSync(output+'.partial.wav'),false);
  }
  const silent=path.join(temp,'silent.wav'),failed=path.join(temp,'failed.wav');writeFileSync(silent,wav(true));
  await assert.rejects(masterAudio(ffmpeg,silent,failed,'balanced'),/silent|quiet/);assert.equal(existsSync(failed),false);assert.equal(existsSync(failed+'.partial.wav'),false);
});
test('mastering API authenticates, saves separate masters, streams downloads and retains them after restart',async t=>{
  const temp=fixture(t),id=randomUUID(),songDir=path.join(temp,'data','songs',id);mkdirSync(songDir,{recursive:true});writeFileSync(path.join(songDir,'audio.wav'),wav());
  writeFileSync(path.join(temp,'data','studio.json'),JSON.stringify({songs:[{id,title:'Test recording',status:'completed',stage:'Ready',createdAt:new Date().toISOString(),lyrics:'',style:'',mode:'off'}],settings:{}}));
  const before=hash(path.join(songDir,'audio.wav'));let app,url,token;
  const start=async()=>{app=createStudio({root:temp,masteringExecutable:ffmpeg,checkRuntime:()=>({ready:true,missing:[]})});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${app.server.address().port}`;token=(await(await fetch(url+'/api/studio')).json()).token;};
  t.after(async()=>{if(app?.server.listening)await app.close();});await start();
  const request=(route,method='GET',body)=>fetch(url+route,{method,headers:{'Content-Type':'application/json','X-Studio-Token':token},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal((await fetch(url+`/api/songs/${id}/masters`,{method:'POST',body:'{}'})).status,403);
  for(const preset of ['unknown','__proto__','constructor'])assert.equal((await request(`/api/songs/${id}/masters`,'POST',{preset})).status,400);
  const response=await request(`/api/songs/${id}/masters`,'POST',{preset:'balanced'});assert.equal(response.status,202);const job=await response.json();
  let completed;
  for(let i=0;i<100;i++){const jobs=(await(await request(`/api/songs/${id}/masters`)).json()).masters;completed=jobs.find(j=>j.id===job.id);if(completed.status==='completed'||completed.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(completed.status,'completed',completed.error);assert.equal(completed.hasAudio,true);
  const download=await request(`/api/masters/${job.id}/audio?download`);assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/balanced-master\.wav/);assert.ok((await download.arrayBuffer()).byteLength>44);
  const partial=await fetch(url+`/api/masters/${job.id}/audio`,{headers:{Range:'bytes=0-43'}});assert.equal(partial.status,206);assert.equal((await partial.arrayBuffer()).byteLength,44);
  await app.close();await start();const studio=await(await request('/api/studio')).json();assert.equal(studio.mastering.jobs[0].hasAudio,true);assert.equal(hash(path.join(songDir,'audio.wav')),before);
});
