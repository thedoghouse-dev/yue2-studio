import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../server.mjs';
import { createOpenRouterClient, extractLyrics } from '../openrouter.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('OpenRouter uses selected model, conversation, and edited draft; handles catalog and errors', async () => {
  const requests = [];
  const client = createOpenRouterClient({ fetchImpl: async (url, options) => {
    requests.push({url,options});
    return {ok:true,json:async()=>url.endsWith('/models') ? {data:[{id:'anthropic/test',name:'Claude test',architecture:{input_modalities:['text'],output_modalities:['text']},pricing:{prompt:'0.000001',completion:'0.000002'}},{id:'image/test',architecture:{input_modalities:['text'],output_modalities:['image']}}]} : {model:'anthropic/test',choices:[{message:{content:'Here is a revision.\n<lyrics>[Verse]\nA new beginning\n\n[Chorus]\nLet the sunlight in</lyrics>'},finish_reason:'stop'}]}};
  } });
  assert.equal((await client.models('secret-key')).length,1);
  const reply = await client.chat('secret-key',{model:'anthropic/test',title:'My song',lyrics:'My manual revision',messages:[{role:'user',content:'Make it hopeful'},{role:'assistant',content:'Let us start with a chorus'}]},'Add a verse');
  assert.match(reply.proposedLyrics,/\[Verse\]/);
  const request = requests[1], payload = JSON.parse(request.options.body);
  assert.equal(request.url,'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.options.headers.Authorization,'Bearer secret-key');
  assert.equal(payload.model,'anthropic/test');
  assert.deepEqual(payload.messages.map(m=>m.role),['system','user','assistant','user']);
  assert.match(payload.messages.at(-1).content,/My manual revision/);
  assert.match(payload.messages.at(-1).content,/Add a verse/);
  assert.equal(extractLyrics('Let us discuss your theme'),null);
  assert.equal(extractLyrics('<lyrics>'+ 'a'.repeat(12001) +'</lyrics>'),null);
  const bad = createOpenRouterClient({fetchImpl:async()=>({ok:false,status:401,json:async()=>({error:{code:401,message:'secret-key sensitive details'}})})});
  await assert.rejects(bad.models('secret-key'),e=>e.status===401 && !e.message.includes('secret-key'));
  const truncated = createOpenRouterClient({fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:'<lyrics>Incomplete</lyrics>'},finish_reason:'length'}]})})});
  assert.equal((await truncated.chat('key',{model:'openai/test',title:'',lyrics:'',messages:[]},'Write')).proposedLyrics,null);
});

test('Lyrics HTTP persistence, key privacy, failed replies, concurrency, and model switching', async t => {
  const parent = path.join(root,'.test-tmp'); mkdirSync(parent,{recursive:true});
  const temp = mkdtempSync(path.join(parent,'lyrics-'));
  let app, url, token, release, calls = 0, rejectNext = false;
  const seen = [];
  const client = {models:async()=>[{id:'openai/test',name:'GPT test',pricing:{prompt:'0',completion:'0'}}],chat:async(key,session,message)=>{
    calls++; seen.push({key,model:session.model,lyrics:session.lyrics,messages:structuredClone(session.messages),message});
    if(rejectNext) {rejectNext=false;throw Object.assign(new Error('Model unavailable'),{status:503});}
    if(message==='Wait') await new Promise(resolve=>release=resolve);
    return {content:'<lyrics>[Verse]\nNew words</lyrics>',proposedLyrics:'[Verse]\nNew words',model:session.model,truncated:false};
  }};
  async function start(){app=createStudio({root:temp,openRouterClient:client});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${app.server.address().port}`;token=(await(await fetch(url+'/api/studio')).json()).token;}
  const request=(route,method='GET',value)=>fetch(url+route,{method,headers:{'Content-Type':'application/json','X-Studio-Token':token},body:value===undefined?undefined:JSON.stringify(value)});
  t.after(async()=>{release?.();if(app?.server.listening)await app.close();assert.ok(temp.startsWith(parent+path.sep));rmSync(temp,{recursive:true,force:true});});
  await start();
  assert.equal((await fetch(url+'/api/openrouter/connection',{method:'PUT',body:JSON.stringify({key:'secret-test-key'})})).status,403);
  let state=await(await request('/api/lyrics')).json();assert.equal(state.connection.configured,false);
  const draft=await(await request('/api/lyrics','POST',{title:'Starting over',lyrics:'Original words',model:'openai/test'})).json();
  assert.equal((await request(`/api/lyrics/${draft.id}/chat`,'POST',{message:'Make it hopeful'})).status,400);
  const studioSummary=await(await request('/api/studio')).json();
  assert.equal(studioSummary.lyricSessions[0].id,draft.id);
  assert.equal(studioSummary.lyricSessions[0].lyrics,'Original words');
  assert.equal(studioSummary.lyricSessions[0].messages,undefined);
  assert.equal((await request('/api/openrouter/connection','PUT',{key:'secret-test-key'})).status,200);
  assert.equal((await(await request('/api/openrouter/models')).json()).models.length,1);
  assert.ok(!JSON.stringify(await(await request('/api/lyrics')).json()).includes('secret-test-key'));
  let response=await(await request(`/api/lyrics/${draft.id}/chat`,'POST',{message:'Make it hopeful'})).json();
  assert.equal(response.messages.length,2);assert.equal(response.lyrics,'Original words');
  await request(`/api/lyrics/${draft.id}`,'PUT',{title:'Starting over',lyrics:'Manually edited chorus',model:'anthropic/test'});
  response=await(await request(`/api/lyrics/${draft.id}/chat`,'POST',{message:'Add a bridge'})).json();
  assert.equal(response.messages.length,4);assert.equal(seen.at(-1).model,'anthropic/test');assert.equal(seen.at(-1).lyrics,'Manually edited chorus');assert.equal(seen.at(-1).messages.length,2);
  rejectNext=true;assert.equal((await request(`/api/lyrics/${draft.id}/chat`,'POST',{message:'Retry me'})).status,503);
  assert.equal((await(await request(`/api/lyrics/${draft.id}`)).json()).messages.length,4);
  const waiting=request(`/api/lyrics/${draft.id}/chat`,'POST',{message:'Wait'});
  for(let i=0;i<50&&!release;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(release);const callCount=calls;
  assert.equal((await request(`/api/lyrics/${draft.id}/chat`,'POST',{message:'Duplicate'})).status,409);
  assert.equal(calls,callCount);
  assert.equal((await request(`/api/lyrics/${draft.id}`,'PUT',{title:'Race',lyrics:'Race',model:'openai/test'})).status,409);
  assert.equal((await request('/api/openrouter/connection','DELETE')).status,409);
  release();await waiting;
  assert.equal((await request('/api/lyrics','POST',{title:'Bad',lyrics:'a'.repeat(12001),model:'openai/test'})).status,400);
  await app.close();await start();
  response=await(await request(`/api/lyrics/${draft.id}`)).json();assert.equal(response.messages.length,6);assert.equal(response.lyrics,'Manually edited chorus');
  assert.equal((await(await request('/api/lyrics')).json()).connection.configured,true);
  await request('/api/openrouter/connection','DELETE');assert.equal((await(await request('/api/lyrics')).json()).connection.configured,false);
});
