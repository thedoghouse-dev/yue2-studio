import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createStudio } from '../server.mjs';
import { createVideoProviders, VIDEO_MODELS, falInput, validateVideoPodURL } from '../video-providers.mjs';
import { audioDuration } from '../videos.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),ffmpeg=path.join(root,'node_modules','@ffmpeg-installer','win32-x64','ffmpeg.exe');
const parent=path.join(root,'.test-tmp');
function setup(t){mkdirSync(parent,{recursive:true});const temp=mkdtempSync(path.join(parent,'video-'));t.after(()=>{assert.ok(temp.startsWith(parent+path.sep));rmSync(temp,{recursive:true,force:true});});return temp;}
function media(temp){
  const audio=path.join(temp,'audio.wav'),clip=path.join(temp,'clip.mp4');
  let result=spawnSync(ffmpeg,['-hide_banner','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=12','-ac','2',audio],{windowsHide:true});assert.equal(result.status,0);
  result=spawnSync(ffmpeg,['-hide_banner','-y','-f','lavfi','-i','color=c=blue:s=160x90:r=24:d=1','-an','-c:v','libx264','-pix_fmt','yuv420p',clip],{windowsHide:true});assert.equal(result.status,0);return {audio,clip};
}
test('model inputs use verified duration types and reject unsafe RunPod targets',()=>{
  for(const value of ['http://localhost:30010','https://example.com','https://x-30010.proxy.runpod.net/private','https://x-30010.proxy.runpod.net/?secret=x','https://user:pass@x-30010.proxy.runpod.net'])assert.throws(()=>validateVideoPodURL(value));
  assert.equal(validateVideoPodURL('https://pod1-30010.proxy.runpod.net'),'https://pod1-30010.proxy.runpod.net');
  const job={clipSeconds:10,ratio:'16:9',resolution:'',seed:1234};
  assert.equal(falInput(VIDEO_MODELS[2],job,'Scene',0).duration,'10');
  assert.equal(falInput(VIDEO_MODELS[0],{...job,resolution:'768P'},'Scene',2).seed,1236);
  assert.equal(falInput(VIDEO_MODELS[0],job,'Scene',0).prompt_expansion_mode,'balanced');
  assert.equal(falInput(VIDEO_MODELS[3],job,'Scene',0).generate_audio,false);
});
test('fal workflow persists scenes, protects keys, assembles real MP4 with source audio and streams downloads',async t=>{
  const temp=setup(t),fixture=media(temp),songId=randomUUID(),songDir=path.join(temp,'data','songs',songId);mkdirSync(songDir,{recursive:true});writeFileSync(path.join(songDir,'audio.wav'),readFileSync(fixture.audio));
  const sourceHash=createHash('sha256').update(readFileSync(fixture.audio)).digest('hex');
  writeFileSync(path.join(temp,'data','studio.json'),JSON.stringify({songs:[{id:songId,title:'Video test',status:'completed',stage:'Ready',createdAt:new Date().toISOString(),lyrics:'',style:'',mode:'off'}],settings:{}}));
  const requests=[];let id=0,downloadCount=0;
  const providers=createVideoProviders({pollMs:1,fetcher:async(url,options={})=>{
    requests.push({url,options});
    if(url.includes('/models/pricing'))return Response.json({prices:[{endpoint_id:VIDEO_MODELS[0].id,unit_price:0.08,unit:'second',currency:'USD'}]});
    if(url.startsWith('https://queue.fal.run/')&&options.method==='POST'){
      const requestId='scene-'+(++id),base='https://queue.fal.run/minimax/h3-max-turbo/requests/'+requestId;
      return Response.json({request_id:requestId,status_url:base+'/status',response_url:base+'/response',cancel_url:base+'/cancel'});
    }
    if(url.endsWith('/status'))return Response.json({status:'COMPLETED'});
    if(url.endsWith('/response'))return Response.json({video:{url:'https://v3.fal.media/clip.mp4'}});
    if(url==='https://v3.fal.media/clip.mp4'){downloadCount++;assert.equal(options.headers,undefined);return new Response(readFileSync(fixture.clip));}
    throw new Error('Unexpected test URL '+url);
  }});
  let app,url,token;
  async function start(){app=createStudio({root:temp,masteringExecutable:ffmpeg,videoProviders:providers,checkRuntime:()=>({ready:true,missing:[]})});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${app.server.address().port}`;token=(await(await fetch(url+'/api/studio')).json()).token;}
  t.after(async()=>{if(app?.server.listening)await app.close();});await start();
  const request=(route,method='GET',body)=>fetch(url+route,{method,headers:{'Content-Type':'application/json','X-Studio-Token':token},body:body===undefined?undefined:JSON.stringify(body)});
  const imageFile=path.join(temp,'reference.png');assert.equal(spawnSync(ffmpeg,['-hide_banner','-y','-i',fixture.clip,'-frames:v','1',imageFile],{windowsHide:true}).status,0);
  const imageData='data:image/png;base64,'+readFileSync(imageFile).toString('base64');
  assert.equal((await request('/api/videos/images','POST',{label:'Broken',data:'data:image/png;base64,'+Buffer.alloc(30).toString('base64')})).status,400);
  const rusty=await(await request('/api/videos/images','POST',{label:'Rusty',data:imageData})).json();assert.ok(rusty.id);
  assert.equal((await request('/api/videos/images','POST',{label:'rusty',data:imageData})).status,400);
  const beauty=await(await request('/api/videos/images','POST',{label:'Beauty',data:imageData})).json();assert.ok(beauty.id);
  assert.equal((await request('/api/videos/images/'+rusty.id)).headers.get('content-type'),'image/jpeg');
  assert.equal((await fetch(url+'/api/videos/connection',{method:'PUT',body:'{}'})).status,403);
  const input={provider:'fal',model:VIDEO_MODELS[0].id,songId,masterId:'',scope:'full',clipSeconds:5,resolution:'480P',ratio:'16:9',seed:1234,prompt:'Cinematic ocean, soft blue light.',scenes:'A wave rolls ashore.\n\nA seabird crosses the horizon.'};
  assert.equal((await request('/api/videos','POST',input)).status,409);
  assert.equal((await request('/api/videos/connection','PUT',{falKey:'test-secret-key'})).status,200);
  const state=await(await request('/api/videos/state')).json();assert.equal(state.connection.falConfigured,true);assert.equal(JSON.stringify(state).includes('test-secret-key'),false);
  assert.equal((await request('/api/videos/plan','POST',{...input,model:'invented-model'})).status,400);
  assert.equal((await request('/api/videos/plan','POST',{...input,clipSeconds:60})).status,400);
  const plan=await(await request('/api/videos/plan','POST',input)).json();assert.equal(plan.count,3);assert.equal(plan.seconds,12);assert.equal(plan.pricing.prices[0].unit,'second');
  assert.equal((await request('/api/videos/plan','POST',{...input,referenceIds:[rusty.id]})).status,400);
  const referenceInput={...input,model:'minimax/h3/reference-to-video',referenceIds:[rusty.id,beauty.id]};
  const referencePlan=await(await request('/api/videos/plan','POST',referenceInput)).json();assert.match(referencePlan.prompts[0],/Image 1 is "Rusty"/);assert.match(referencePlan.prompts[0],/Image 2 is "Beauty"/);
  assert.equal((await request('/api/videos/plan','POST',{...referenceInput,referenceIds:['../../private']})).status,400);
  assert.equal((await request('/api/videos/plan','POST',{...referenceInput,model:'minimax/h3-max-turbo/image-to-video'})).status,400);
  const firstFramePlan=await(await request('/api/videos/plan','POST',{...referenceInput,model:'minimax/h3-max-turbo/image-to-video',referenceIds:[rusty.id]})).json();assert.match(firstFramePlan.prompts[0],/opening image shows "Rusty"/);
  const firstFrameInput=falInput(VIDEO_MODELS.find(m=>m.imageMode==='first-frame'),{...input,imageInputs:['data:image/jpeg;base64,test']},'Rusty',0);assert.equal(firstFrameInput.image_url,'data:image/jpeg;base64,test');assert.equal('aspect_ratio' in firstFrameInput,false);
  const submitted=await request('/api/videos','POST',referenceInput);assert.equal(submitted.status,202);const job=await submitted.json();let complete;
  for(let i=0;i<200;i++){complete=(await(await request('/api/videos/state')).json()).jobs.find(j=>j.id===job.id);if(['completed','failed'].includes(complete.status))break;await new Promise(resolve=>setTimeout(resolve,30));}
  assert.equal(complete.status,'completed',complete.error+'\n'+(existsSync(path.join(temp,'data','videos',job.id,'assembly.txt'))?readFileSync(path.join(temp,'data','videos',job.id,'assembly.txt'),'utf8'):''));assert.equal(downloadCount,3);assert.equal(id,3);assert.ok(complete.clips.every(c=>c.completed&&c.remote.id));
  const output=path.join(temp,'data','videos',job.id,'video.mp4');assert.ok(Math.abs(await audioDuration(ffmpeg,output)-12)<0.1);
  const inspected=spawnSync(ffmpeg,['-hide_banner','-i',output],{encoding:'utf8',windowsHide:true});assert.match(inspected.stderr,/Video: h264/);assert.match(inspected.stderr,/Audio: aac/);
  assert.equal(createHash('sha256').update(readFileSync(path.join(songDir,'audio.wav'))).digest('hex'),sourceHash);
  const download=await request(`/api/videos/${job.id}/video?download`);assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'video/mp4');assert.match(download.headers.get('content-disposition'),/music-video\.mp4/);await download.arrayBuffer();
  const thumbnails=await Promise.all([request(`/api/videos/${job.id}/thumbnail`),request(`/api/videos/${job.id}/thumbnail`)]);
  for(const thumbnail of thumbnails){assert.equal(thumbnail.status,200);assert.equal(thumbnail.headers.get('content-type'),'image/jpeg');const bytes=Buffer.from(await thumbnail.arrayBuffer());assert.equal(bytes[0],0xff);assert.equal(bytes[1],0xd8);assert.ok(bytes.length>100);}
  assert.ok(existsSync(path.join(temp,'data','videos',job.id,'thumbnail.jpg')));
  assert.equal((await request(`/api/videos/${randomUUID()}/thumbnail`)).status,404);
  const partial=await fetch(url+`/api/videos/${job.id}/video`,{headers:{Range:'bytes=0-63'}});assert.equal(partial.status,206);assert.equal((await partial.arrayBuffer()).byteLength,64);
  const posts=requests.filter(r=>r.options.method==='POST');assert.ok(posts.every(r=>r.options.headers.Authorization==='Key test-secret-key'));assert.ok(posts[0].options.body.includes('A wave rolls ashore.'));assert.ok(posts[1].options.body.includes('A seabird crosses'));
  assert.equal(JSON.parse(posts[0].options.body).reference_image_urls.length,2);assert.match(JSON.parse(posts[0].options.body).reference_image_urls[0],/^data:image\/jpeg;base64,/);
  assert.equal((await request('/api/videos/images/'+rusty.id,'PATCH',{label:'Rusty renamed'})).status,200);assert.equal((await request('/api/videos/images/'+beauty.id,'DELETE',{})).status,200);
  const imageState=await(await request('/api/videos/state')).json();assert.equal(imageState.images.length,1);assert.equal(imageState.jobs[0].references[0].label,'Rusty');assert.equal(JSON.stringify(imageState).includes('data:image/'),false);
  await app.close();await start();const after=await(await request('/api/videos/state')).json();assert.equal(after.jobs[0].hasVideo,true);assert.equal(after.connection.falConfigured,true);assert.equal(id,3);
  await app.close();
  const workspaceFile=path.join(temp,'data','videos','workspace.json'),saved=JSON.parse(readFileSync(workspaceFile,'utf8'));saved.jobs[0].status='running';writeFileSync(workspaceFile,JSON.stringify(saved));
  await start();assert.equal((await(await request('/api/videos/state')).json()).jobs[0].status,'interrupted');
  assert.equal((await request(`/api/videos/${job.id}/resume`,'POST',{})).status,202);
  for(let i=0;i<200;i++){complete=(await(await request('/api/videos/state')).json()).jobs[0];if(['completed','failed'].includes(complete.status))break;await new Promise(resolve=>setTimeout(resolve,30));}
  assert.equal(complete.status,'completed',complete.error);assert.equal(id,3);assert.equal(downloadCount,3);
  const videoHash=createHash('sha256').update(readFileSync(output)).digest('hex');
  assert.equal((await fetch(url+`/api/videos/${job.id}/trash`,{method:'POST',body:'{}'})).status,403);
  assert.equal((await request(`/api/videos/${job.id}/trash`,'POST',{})).status,200);
  let deletedState=await(await request('/api/videos/state')).json();assert.equal(deletedState.jobs.length,0);assert.equal(deletedState.trash[0].id,job.id);
  assert.equal(deletedState.images.length,1);assert.equal(deletedState.images[0].label,'Rusty renamed');
  assert.equal(createHash('sha256').update(readFileSync(output)).digest('hex'),videoHash);
  assert.equal(createHash('sha256').update(readFileSync(path.join(songDir,'audio.wav'))).digest('hex'),sourceHash);
  assert.equal((await request(`/api/videos/${job.id}/resume`,'POST',{})).status,409);
  await app.close();await start();deletedState=await(await request('/api/videos/state')).json();assert.equal(deletedState.jobs.length,0);assert.equal(deletedState.trash.length,1);
  assert.equal((await request(`/api/videos/${job.id}/restore`,'POST',{})).status,200);
  const restored=await(await request('/api/videos/state')).json();assert.equal(restored.jobs[0].hasVideo,true);assert.equal(restored.trash.length,0);assert.equal(id,3);assert.equal(downloadCount,3);

});
test('RunPod uses the published MiniMax H3 SGLang protocol and fal media rejects credential redirects',async t=>{
  const temp=setup(t),fixture=media(temp),requests=[];const config={podURL:'https://pod1-30010.proxy.runpod.net',podToken:'private-token'};
  const provider=createVideoProviders({pollMs:1,fetcher:async(url,options)=>{requests.push({url,options});if(options.method==='POST')return Response.json({id:'video_123'});if(url.endsWith('/content'))return new Response(readFileSync(fixture.clip));return Response.json({status:'completed'});}});
  const job={provider:'runpod',clipSeconds:10,ratio:'16:9',seed:1234},remote=await provider.submit(config,VIDEO_MODELS[5],job,'A cinematic garden.',0,new AbortController().signal);
  await provider.waitAndDownload(config,'runpod',remote,path.join(temp,'download.mp4'),{signal:new AbortController().signal});
  const submitted=JSON.parse(requests[0].options.body);assert.equal(submitted.task,'t2va');assert.equal(submitted.target.short_edge,768);assert.equal(submitted.target.duration_seconds,10);assert.ok(requests.every(r=>r.options.headers.Authorization==='Bearer private-token'));
  const unsafe=createVideoProviders({fetcher:async url=>{if(url.endsWith('/status'))return Response.json({status:'COMPLETED'});if(url.endsWith('/response'))return Response.json({video:{url:'https://v3.fal.media/clip.mp4'}});return new Response('',{status:302,headers:{location:'http://127.0.0.1/private'}});}});
  await assert.rejects(unsafe.waitAndDownload({falKey:'secret'},'fal',{statusURL:'https://queue.fal.run/m/status',resultURL:'https://queue.fal.run/m/response'},path.join(temp,'bad.mp4'),{signal:new AbortController().signal}),/unrecognized/);assert.equal(existsSync(path.join(temp,'bad.mp4')),false);
});
