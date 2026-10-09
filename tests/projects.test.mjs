import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createStudio} from '../server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('projects preserve songs, validate atomic moves, assign new songs and persist organization',async t=>{
  const parent=path.join(root,'.test-tmp');mkdirSync(parent,{recursive:true});const temp=mkdtempSync(path.join(parent,'projects-'));
  const ids=[randomUUID(),randomUUID()];mkdirSync(path.join(temp,'data'),{recursive:true});
  for(const id of ids){mkdirSync(path.join(temp,'data','songs',id),{recursive:true});writeFileSync(path.join(temp,'data','songs',id,'audio.wav'),'original-audio-'+id);}
  writeFileSync(path.join(temp,'data','studio.json'),JSON.stringify({songs:ids.map(id=>({id,title:'Same title',status:'completed',createdAt:new Date().toISOString()})),settings:{}}));
  const hash=()=>ids.map(id=>createHash('sha256').update(readFileSync(path.join(temp,'data','songs',id,'audio.wav'))).digest('hex')),before=hash();
  let app,url,token;
  async function start(){app=createStudio({root:temp,checkRuntime:()=>({ready:true,missing:[]}),spawnRunner:(_exe,args,options)=>spawn(process.execPath,[path.join(root,'tests','fixture-cli.mjs'),...args],{...options,cwd:temp})});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${app.server.address().port}`;token=(await(await fetch(url+'/api/studio')).json()).token;}
  t.after(async()=>{if(app?.server.listening)await app.close();assert.ok(temp.startsWith(parent+path.sep));rmSync(temp,{recursive:true,force:true});});await start();
  const request=(route,method='GET',body)=>fetch(url+route,{method,headers:{'Content-Type':'application/json','X-Studio-Token':token},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal((await fetch(url+'/api/projects',{method:'POST',body:'{}'})).status,403);
  assert.deepEqual((await(await request('/api/projects')).json()).projects,[]);
  assert.equal((await request('/api/projects','POST',{name:' '})).status,400);
  const project=await(await request('/api/projects','POST',{name:'Dogs album'})).json();assert.ok(project.id);
  assert.equal((await request('/api/projects','POST',{name:'dogs ALBUM'})).status,400);
  assert.equal((await request('/api/projects/move','POST',{songIds:[ids[0],randomUUID()],projectId:project.id})).status,404);
  let state=await(await request('/api/studio')).json();assert.ok(state.songs.every(song=>!song.projectId));
  assert.equal((await request('/api/projects/move','POST',{songIds:ids,projectId:project.id})).status,200);
  state=await(await request('/api/studio')).json();assert.equal(state.projects[0].songCount,2);assert.ok(state.songs.every(song=>song.projectId===project.id));assert.deepEqual(hash(),before);
  assert.equal((await request('/api/projects/'+project.id,'PATCH',{name:'Rusty & Beauty'})).status,200);
  const input={title:'New version',lyrics:'[Verse]\nHello',style:'folk',mode:'full',seed:42,maxTokens:1500,steps:8,temperature:1,projectId:project.id};
  assert.equal((await request('/api/songs','POST',{...input,projectId:randomUUID()})).status,404);
  const created=await(await request('/api/songs','POST',input)).json();assert.equal(created.projectId,project.id);
  for(let i=0;i<100;i++){const job=await(await request('/api/songs/'+created.id)).json();if(job.status==='completed')break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(JSON.parse(readFileSync(path.join(temp,'data','songs',created.id,'request.json'),'utf8')).projectId,project.id);
  await app.close();await start();state=await(await request('/api/studio')).json();assert.equal(state.projects[0].name,'Rusty & Beauty');assert.equal(state.projects[0].songCount,3);
  await request('/api/draft','PUT',{projectId:project.id,title:'Draft'});
  assert.equal((await request('/api/projects/'+project.id,'DELETE',{})).status,200);
  state=await(await request('/api/studio')).json();assert.deepEqual(state.projects,[]);assert.equal(state.draft.projectId,'');assert.ok(state.songs.every(song=>song.projectId===''));assert.deepEqual(hash(),before);
  assert.equal((await request('/api/projects/move','POST',{songIds:ids,projectId:project.id})).status,404);
  assert.equal((await request('/api/projects/move','POST',{songIds:[ids[0],randomUUID()],newProjectName:'No partial project'})).status,404);
  assert.deepEqual((await(await request('/api/projects')).json()).projects,[]);
  assert.equal((await request('/api/projects/move','POST',{songIds:ids,newProjectName:' '})).status,400);
  const move=await(await request('/api/projects/move','POST',{songIds:ids,newProjectName:'New album'})).json();assert.equal(move.moved,2);assert.ok(move.projectId);
  state=await(await request('/api/studio')).json();assert.equal(state.projects[0].name,'New album');assert.equal(state.projects[0].songCount,2);assert.ok(state.songs.filter(song=>ids.includes(song.id)).every(song=>song.projectId===move.projectId));
  assert.equal((await request('/api/projects/move','POST',{songIds:[created.id],newProjectName:'NEW ALBUM'})).status,400);
  assert.equal((await(await request('/api/projects')).json()).projects.length,1);assert.deepEqual(hash(),before);

});
