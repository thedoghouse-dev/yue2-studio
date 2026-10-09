import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createStudio} from '../server.mjs';

test('song Trash protects video and master dependencies and persists reversible deletion',async t=>{
  const parent=path.resolve('.test-tmp');mkdirSync(parent,{recursive:true});const root=mkdtempSync(path.join(parent,'song-trash-'));
  const ids=Array.from({length:4},()=>randomUUID()),projectId=randomUUID(),videoId=randomUUID();
  mkdirSync(path.join(root,'data','videos'),{recursive:true});mkdirSync(path.join(root,'data','masters'),{recursive:true});
  const songs=ids.map((id,i)=>({id,title:['Independent','Video source','Master source','Other song'][i],status:'completed',stage:'Ready',projectId,createdAt:new Date().toISOString()}));
  for(const song of songs){const dir=path.join(root,'data','songs',song.id);mkdirSync(dir,{recursive:true});writeFileSync(path.join(dir,'audio.wav'),'original-'+song.id);writeFileSync(path.join(dir,'lyrics.txt'),'original lyrics');}
  writeFileSync(path.join(root,'data','studio.json'),JSON.stringify({songs,projects:[{id:projectId,name:'Album'}],settings:{}}));
  writeFileSync(path.join(root,'data','videos','workspace.json'),JSON.stringify({images:[{id:randomUUID(),label:'Reference'}],jobs:[{id:videoId,title:'Dependent video',songId:ids[1],status:'completed',stage:'Ready',clips:[]}]}));
  writeFileSync(path.join(root,'data','masters','jobs.json'),JSON.stringify([{id:randomUUID(),songId:ids[2],title:'Master source',preset:'balanced',status:'completed'}]));
  let app,url,token;
  async function start(){app=createStudio({root});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${app.server.address().port}`;token=(await(await fetch(url+'/api/studio')).json()).token;}
  t.after(async()=>{if(app?.server.listening)await app.close();assert.ok(root.startsWith(parent+path.sep));rmSync(root,{recursive:true,force:true});});await start();
  const request=(route,method='GET')=>fetch(url+route,{method,headers:{'X-Studio-Token':token,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
  assert.equal((await fetch(url+`/api/songs/${ids[0]}/trash`,{method:'POST',body:'{}'})).status,403);
  assert.equal((await request(`/api/songs/${ids[1]}/trash`,'POST')).status,409);
  assert.equal((await request(`/api/videos/${videoId}/trash`,'POST')).status,200);
  const blocker=await(await request(`/api/songs/${ids[1]}`)).json();assert.equal(blocker.deletionBlockers[0].inTrash,true);
  assert.equal((await request(`/api/songs/${ids[1]}/trash`,'POST')).status,409);
  assert.equal((await request(`/api/songs/${ids[2]}/trash`,'POST')).status,409);
  assert.equal((await request(`/api/songs/${ids[0]}/trash`,'POST')).status,200);
  let state=await(await request('/api/studio')).json();assert.equal(state.songs.length,3);assert.equal(state.songTrash[0].id,ids[0]);assert.equal(state.projects[0].songCount,3);assert.equal(state.videos.trash.length,1);assert.equal(state.mastering.jobs.length,1);
  for(const id of ids)assert.equal(readFileSync(path.join(root,'data','songs',id,'audio.wav'),'utf8'),'original-'+id);
  assert.equal((await request(`/api/songs/${ids[0]}/masters`,'POST')).status,409);
  await app.close();await start();state=await(await request('/api/studio')).json();assert.equal(state.songTrash.length,1);
  assert.equal((await request(`/api/songs/${ids[0]}/restore`,'POST')).status,200);
  state=await(await request('/api/studio')).json();assert.equal(state.songs.length,4);assert.equal(state.songTrash.length,0);assert.equal(state.projects[0].songCount,4);assert.equal(state.videos.images.length,1);
  const mutate=(route,method,body)=>fetch(url+route,{method,headers:{'X-Studio-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const separate=await(await mutate('/api/projects','POST',{name:'Video edits'})).json();
  assert.equal((await fetch(url+`/api/videos/${videoId}/project`,{method:'PATCH',body:'{}'})).status,403);
  assert.equal((await mutate(`/api/videos/${videoId}/project`,'PATCH',{projectId:randomUUID()})).status,404);
  assert.equal((await mutate(`/api/videos/${videoId}/project`,'PATCH',{projectId:separate.id})).status,200);
  state=await(await request('/api/studio')).json();assert.equal(state.videos.trash[0].projectId,separate.id);assert.equal(state.songs.find(s=>s.id===ids[1]).projectId,projectId);
  await app.close();await start();state=await(await request('/api/studio')).json();assert.equal(state.videos.trash[0].projectId,separate.id);
  assert.equal((await mutate('/api/projects/'+separate.id,'DELETE',{})).status,200);state=await(await request('/api/studio')).json();assert.equal(state.videos.trash[0].projectId,'');
  assert.equal((await mutate(`/api/videos/${videoId}/project`,'PATCH',{projectId:separate.id})).status,404);
  assert.equal((await mutate(`/api/videos/${videoId}/project`,'PATCH',{projectId:null})).status,200);state=await(await request('/api/studio')).json();assert.equal(state.videos.trash[0].projectId,undefined);assert.equal(state.songs.find(s=>s.id===ids[1]).projectId,projectId);

});
