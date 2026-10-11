import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdirSync,mkdtempSync,copyFileSync,rmSync,readFileSync} from 'node:fs';
import {createStudio} from '../server.mjs';
import {createRunpodControlClient,explainSetupFailure} from '../runpod-management.mjs';

const root=path.resolve(import.meta.dirname,'..');
const secret='account-private-key',oldToken='old_worker_token_abcdefghijklmnopqrstuvwxyz';
async function fixture(t,{lost=false,h3=false}={}) {
  const parent=path.join(root,'.test-tmp');mkdirSync(parent,{recursive:true});const temp=mkdtempSync(path.join(parent,'runpod-manage-'));
  mkdirSync(path.join(temp,'cloud'));for(const name of ['worker.py','setup_worker.py','h3_worker.py','h3_serverless.py','yue2_serverless.py'])copyFileSync(path.join(root,'cloud',name),path.join(temp,'cloud',name));
  const pods=[{id:'oldpod',name:'Existing Pod',status:'RUNNING',actions:['stop'],gpu:{id:'gpu24',count:1},cloud:'SECURE',cost:0.4,ports:['8000/http'],env:{YUE2_WORKER_TOKEN:oldToken,OTHER_SECRET:'never-show-env'},dataCenterId:'DC1'}];
  const volumes=[{id:'existingvol',name:'My models',size:50,dataCenter:'DC1',type:'STANDARD'}],endpoints=[{id:'ep1',name:'Existing endpoint',type:'QUEUE',workers:{min:0,max:1},networkVolumes:['existingvol'],env:{PASSWORD:'no-browser'},registry:'registry-secret'}];
  let rate=0.4,ready=true,created=0;const calls=[];
  const fetcher=async(url,options={})=>{
    const parsed=new URL(url),route=parsed.pathname.replace('/v2',''),method=options.method??'GET',input=options.body?JSON.parse(options.body):null;
    calls.push({url,method,input,headers:options.headers});
    let value;
    if(options.headers.Authorization!=='Bearer '+secret)return new Response(JSON.stringify({error:secret}),{status:401});
    if(route==='/pods'&&method==='GET')value={pods,pagination:{hasNextPage:false,nextCursor:null}};
    else if(route==='/serverless'&&method==='GET')value={endpoints,pagination:{hasNextPage:false,nextCursor:null}};
    else if(route==='/network-volumes'&&method==='GET')value={networkVolumes:volumes};
    else if(route==='/catalog/gpus')value={gpus:[{id:'gpu24',name:'RTX 4090',manufacturer:'NVIDIA',memory:24,pool:'ADA_24',secure:true,community:true,price:{secure:rate,community:rate,serverless:rate},availability:'HIGH',dataCenters:[{id:'DC1',availability:'HIGH',name:'Data center'}]},{id:'gpu12',name:'Too small',manufacturer:'NVIDIA',memory:12,secure:true},{id:'gpu48',name:'A6000',pool:'AMPERE_48',manufacturer:'NVIDIA',memory:48,secure:true,price:{secure:2,serverless:1.5},availability:'HIGH',dataCenters:[{id:'DC1',availability:'HIGH'}]},...(h3?[{id:'h200',name:'H200',pool:'HOPPER_141',manufacturer:'NVIDIA',memory:141,secure:true,price:{secure:3,serverless:4},availability:'HIGH',dataCenters:[{id:'DC1',availability:'HIGH'}]}]:[])]};
    else if(route==='/catalog/datacenters')value={dataCenters:[{id:'DC1',name:'Data center',networkVolumeTypes:['STANDARD']},{id:'DC2',name:'No GPU capacity',networkVolumeTypes:['STANDARD']}]};
    else if(/^\/serverless\/\w+$/.test(route)&&method==='GET')value=endpoints.find(e=>e.id===route.split('/')[2]);
    else if(route==='/serverless'&&method==='POST'){value={...input,id:'newep'};endpoints.push(value);}
    else if(route==='/network-volumes'&&method==='POST'){value={...input,id:'newvol'};volumes.push(value);}
    else if(route==='/pods'&&method==='POST'){
      created++;value={...input,id:'newpod',status:'RUNNING',actions:['stop'],cost:rate,dataCenterId:'DC1'};pods.push(value);
      if(lost)throw new Error('Connection lost with '+secret);
    }else if(/^\/pods\/\w+\/action$/.test(route)) {const pod=pods.find(p=>p.id===route.split('/')[2]);pod.status=input.action==='stop'?'EXITED':'RUNNING';pod.actions=input.action==='stop'?['start']:['stop'];value=pod;}
    else if(/^\/pods\/\w+$/.test(route)&&method==='DELETE'){const i=pods.findIndex(p=>p.id===route.split('/')[2]);pods.splice(i,1);return new Response(null,{status:204});}
    else if(/^\/pods\/\w+$/.test(route))value=pods.find(p=>p.id===route.split('/')[2]);
    else throw new Error('Unexpected test route '+method+' '+route);
    return new Response(JSON.stringify(value));
  };
  const workerCalls=[];
  const workerClient={run:async(song,dir,config,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),health:async config=>{workerCalls.push(config);return {ready,stage:ready?'BF16 worker ready':'Downloading model',protocol:'yue2-studio/v1',model:'yue2-3b-bf16.gguf',vae:'yue2-vae-f32.gguf'};}};
  let app=createStudio({root:temp,runpodControlClient:createRunpodControlClient({fetcher}),runpodClient:workerClient,checkRuntime:()=>({ready:false,missing:['No test local engine']})});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  const token=(await(await fetch(base+'/api/studio')).json()).token;
  const request=(route,method='GET',input)=>fetch(base+route,{method,headers:{'X-Studio-Token':token,'Content-Type':'application/json'},body:input?JSON.stringify(input):undefined});
  t.after(async()=>{await app.close();assert.ok(path.resolve(temp).startsWith(path.resolve(parent)+path.sep));rmSync(temp,{recursive:true,force:true});});
  return {request,pods,volumes,calls,workerCalls,setRate:value=>rate=value,setReady:value=>ready=value,temp,get created(){return created;},base};
}
async function connect(f) {assert.equal((await f.request('/api/runpod/manage/key','PUT',{key:secret})).status,200);return (await f.request('/api/runpod/manage/refresh','POST',{})).json();}
const existing={gpuId:'gpu24',cloud:'SECURE',storage:'existing',volumeId:'existingvol'};

test('RunPod account discovery validates keys, sanitizes secrets, and creates no resources',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/runpod/manage/refresh','POST',{})).status,409);
  const rejected=await f.request('/api/runpod/manage/key','PUT',{key:'wrong'});assert.equal(rejected.status,400);assert.ok(!(await rejected.text()).includes(secret));
  const state=await connect(f);assert.equal(state.inventory.pods.length,1);assert.equal(state.inventory.volumes.length,1);assert.equal(state.inventory.endpoints.length,1);
  const json=JSON.stringify(state);for(const value of [secret,oldToken,'never-show-env','registry-secret','no-browser'])assert.ok(!json.includes(value));
  assert.equal(f.created,0);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  const catalog=await(await f.request('/api/runpod/manage/catalog')).json();assert.equal(catalog.gpus.length,2);
  assert.equal((await fetch(f.base+'/api/runpod/manage/key',{method:'PUT',body:JSON.stringify({key:secret})})).status,403);
});

test('review is free; approved deployment mounts existing volume, bundles worker, protects keys, and connects only after readiness',async t=>{
  const f=await fixture(t);await connect(f);
  const plan=await(await f.request('/api/runpod/manage/review','POST',existing)).json();assert.equal(plan.hourly,0.4);assert.equal(f.created,0);
  assert.equal((await f.request('/api/runpod/manage/deploy','POST',{planId:plan.id})).status,400);
  const deployed=await(await f.request('/api/runpod/manage/deploy','POST',{planId:plan.id,confirmPaid:true})).json();assert.equal(deployed.podId,'newpod');assert.equal(f.created,1);
  const payload=f.calls.find(c=>c.method==='POST'&&c.url.endsWith('/pods')).input;
  assert.deepEqual(payload.mounts,{network:[{volumeId:'existingvol',path:'/workspace'}]});assert.deepEqual(payload.dataCenterIds,['DC1']);assert.equal(payload.gpu.minCudaVersion,'12.8');assert.deepEqual(payload.ports,['8000/http']);assert.ok(payload.image.includes('@sha256:'));
  assert.ok(!JSON.stringify(payload).includes(secret));assert.ok(payload.env.YUE2_WORKER_TOKEN.length>=32);
  const bundle=JSON.parse(Buffer.from(payload.env.YUE2_WORKER_BUNDLE,'base64').toString());assert.deepEqual(Object.keys(bundle),['worker.py','setup_worker.py']);
  f.setReady(false);assert.equal((await f.request('/api/runpod/manage/pods/newpod/connect','POST',{})).status,409);
  f.setReady(true);assert.equal((await f.request('/api/runpod/manage/pods/newpod/connect','POST',{})).status,200);
  const studio=await(await f.request('/api/studio')).json();assert.equal(studio.runpod.url,'https://newpod-8000.proxy.runpod.net');assert.equal(studio.runpod.configured,true);
  assert.ok(!JSON.stringify(studio).includes(payload.env.YUE2_WORKER_TOKEN));assert.ok(!JSON.stringify(studio).includes(secret));assert.notEqual(f.workerCalls.at(-1).token,secret);
  assert.equal((await f.request('/api/runpod/manage/deploy','POST',{planId:plan.id,confirmPaid:true})).status,201);assert.equal(f.created,1);
});

test('invalid GPUs, foreign volumes and changed prices do not create resources',async t=>{
  const f=await fixture(t);await connect(f);
  for(const input of [{...existing,gpuId:'gpu12'},{...existing,volumeId:'missing'},{...existing,storage:'new',dataCenter:'DC2',volumeName:'New',volumeSize:50}])assert.equal((await f.request('/api/runpod/manage/review','POST',input)).status,400);
  const plan=await(await f.request('/api/runpod/manage/review','POST',existing)).json();f.setRate(0.8);
  assert.equal((await f.request('/api/runpod/manage/deploy','POST',{planId:plan.id,confirmPaid:true})).status,400);assert.equal(f.created,0);
});

test('new network volume is explicitly reviewed and persisted; stopping GPU never deletes shared storage',async t=>{
  const f=await fixture(t);await connect(f);
  const plan=await(await f.request('/api/runpod/manage/review','POST',{...existing,storage:'new',dataCenter:'DC1',volumeName:'Song models',volumeSize:50})).json();assert.equal(plan.storage,'new');assert.equal(f.volumes.length,1);
  await f.request('/api/runpod/manage/deploy','POST',{planId:plan.id,confirmPaid:true});assert.equal(f.volumes.length,2);
  const payload=f.calls.find(c=>c.method==='POST'&&c.url.endsWith('/pods')).input;assert.equal(payload.mounts.network[0].volumeId,'newvol');
  assert.equal((await f.request('/api/runpod/manage/pods/newpod/action','POST',{action:'stop'})).status,400);
  assert.equal((await f.request('/api/runpod/manage/pods/newpod/action','POST',{action:'stop',confirm:true})).status,200);
  assert.equal(f.volumes.length,2);assert.ok(!f.calls.some(c=>c.method==='DELETE'));
  assert.equal((await f.request('/api/runpod/manage/pods/newpod/connect','POST',{})).status,409);
  const quote=await(await f.request('/api/runpod/manage/pods/newpod/quote','POST',{})).json();assert.equal(quote.hourly,0.4);
  assert.equal((await f.request('/api/runpod/manage/pods/newpod/action','POST',{action:'start',confirm:true,maxHourly:0.1})).status,400);
  assert.equal((await f.request('/api/runpod/manage/pods/newpod/action','POST',{action:'start',confirm:true,maxHourly:quote.hourly})).status,200);
});

test('lost create acknowledgement is recovered from deployment marker without resubmitting a rental',async t=>{
  const f=await fixture(t,{lost:true});await connect(f);
  const plan=await(await f.request('/api/runpod/manage/review','POST',existing)).json();
  assert.equal((await f.request('/api/runpod/manage/deploy','POST',{planId:plan.id,confirmPaid:true})).status,502);assert.equal(f.created,1);
  assert.equal((await f.request('/api/runpod/manage/deploy','POST',{planId:plan.id,confirmPaid:true})).status,409);assert.equal(f.created,1);
  const state=await(await f.request('/api/runpod/manage/refresh','POST',{})).json();assert.equal(state.plans.find(p=>p.id===plan.id).status,'deployed');assert.equal(state.managedPods[0].id,'newpod');
  const persisted=JSON.parse(readFileSync(path.join(f.temp,'data','runpod-management.json'),'utf8'));assert.equal(persisted.pods[0].id,'newpod');
  assert.equal((await f.request('/api/runpod/manage/deploy','POST',{planId:plan.id,confirmPaid:true})).status,201);assert.equal(f.created,1);
});

test('control-plane pagination follows opaque cursors and never forwards keys outside the fixed RunPod host',async()=>{
  const urls=[];const client=createRunpodControlClient({fetcher:async(url,options)=>{urls.push([url,options]);return new Response(JSON.stringify(url.includes('cursor=')?{pods:[{id:'second'}],pagination:{hasNextPage:false}}:{pods:[{id:'first'}],pagination:{hasNextPage:true,nextCursor:'opaque/+=='}}));}});
  const pods=await client.list(secret,'/pods','pods',true);assert.equal(pods.length,2);assert.match(urls[1][0],/cursor=opaque%2F%2B%3D%3D/);assert.ok(urls.every(([url,options])=>new URL(url).origin==='https://api.runpod.io'&&options.redirect==='error'));
});

test('a Pod serving an active song cannot be stopped from management',async t=>{
 const f=await fixture(t);await connect(f);
 assert.equal((await f.request('/api/runpod/manage/pods/oldpod/connect','POST',{})).status,200);
 const response=await f.request('/api/songs','POST',{title:'In progress',style:'folk',lyrics:'words',execution:'runpod'});assert.equal(response.status,201);
 assert.equal((await f.request('/api/runpod/manage/pods/oldpod/action','POST',{action:'stop',confirm:true})).status,409);
 assert.ok(!f.calls.some(c=>c.method==='POST'&&c.url.endsWith('/action')));
});

test('one shared setup caches both models, requires adequate network storage and license, starts no video service',async t=>{
  const f=await fixture(t);await connect(f);
  for(const input of [{...existing,includeVideo:true},{...existing,includeVideo:true,storage:'pod'}])assert.equal((await f.request('/api/runpod/manage/review','POST',input)).status,400);
  const response=await f.request('/api/runpod/manage/review','POST',{...existing,includeVideo:true,storage:'new',dataCenter:'DC1',volumeName:'Studio shared models',volumeSize:300});
  assert.equal(response.status,200);const plan=await response.json();assert.equal(plan.includeVideo,true);
  assert.equal((await f.request('/api/runpod/manage/deploy','POST',{planId:plan.id,confirmPaid:true})).status,400);
  assert.equal((await f.request('/api/runpod/manage/deploy','POST',{planId:plan.id,confirmPaid:true,confirmModelLicense:true})).status,201);
  const payload=f.calls.find(c=>c.method==='POST'&&c.url.endsWith('/pods')).input;
  assert.equal(payload.env.YUE2_INCLUDE_VIDEO,'1');assert.equal(payload.env.H3_ROOT,'/workspace/models/minimax-h3');
  const bundle=JSON.parse(Buffer.from(payload.env.YUE2_WORKER_BUNDLE,'base64').toString());
  assert.ok(bundle['h3_worker.py']);assert.match(bundle['worker.py'],/install_model\(VIDEO_ROOT/);
  assert.deepEqual(payload.ports,['8000/http']);assert.equal(payload.gpu.count,1);
  assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/serverless')).length,0);
  assert.ok(!JSON.stringify(payload).includes(secret));
});

test('video serverless defaults to zero idle and ten maximum workers on the shared volume without starting a Pod',async t=>{
  const f=await fixture(t,{h3:true});await connect(f);f.volumes[0].size=300;
  const input={...existing,workload:'h3-serverless',gpuId:'h200'};
  assert.equal((await f.request('/api/runpod/manage/review','POST',{...input,maxWorkers:11})).status,400);
  const response=await f.request('/api/runpod/manage/review','POST',input);assert.equal(response.status,200);const plan=await response.json();
  assert.equal(plan.maxWorkers,10);assert.equal(plan.hourly,16);
  assert.equal((await f.request('/api/runpod/manage/deploy','POST',{planId:plan.id,confirmPaid:true,confirmModelLicense:true})).status,201);
  const payload=f.calls.find(c=>c.method==='POST'&&c.url.endsWith('/serverless')).input;
  assert.deepEqual(payload.workers,{min:0,max:10,idleTimeout:10});assert.deepEqual(payload.networkVolumes,['existingvol']);
  assert.deepEqual(payload.dataCenterIds,['DC1']);assert.equal(payload.gpu.count,4);assert.equal(payload.type,'QUEUE');
  assert.equal(payload.env.H3_ROOT,'/runpod-volume/models/minimax-h3');assert.ok(!JSON.stringify(payload).includes(secret));
  assert.equal(f.created,0);assert.equal(f.calls.some(c=>c.url.includes('/run')),false);
  const studio=await(await f.request('/api/studio')).json();assert.equal(studio.videos.connection.runpodMode,'serverless');assert.equal(studio.videos.connection.endpointId,'newep');
  await f.request('/api/runpod/manage/deploy','POST',{planId:plan.id,confirmPaid:true,confirmModelLicense:true});
  assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/serverless')).length,1);
});

test('worker failures have plain-language causes and recovery steps without raw diagnostics or secrets',()=>{
  const cases=[
    ["Command '['git', '-C', '/workspace/private-token', 'checkout', 'revision']' returned non-zero exit status 128.",/audio.cpp source/],
    ['No space left on device',/free storage/],
    ['Download verification failed: private-token.gguf',/integrity check/],
    ["Command '['cmake', '--build']' returned non-zero exit status 1.",/compiled/],
    ['HTTP Error 503: private-token',/downloading/],
    ['Use a GPU with at least 20 GB VRAM',/memory/],
    ['unknown private-token',/could not finish/]
  ];
  for(const [error,expected] of cases){
    const result=explainSetupFailure({error,stage:'Setup failed'});
    assert.match(result.error,expected);assert.ok(result.nextStep);
    assert.ok(!JSON.stringify(result).includes('private-token'));assert.ok(!JSON.stringify(result).includes('logs'));
  }
  assert.deepEqual(explainSetupFailure({ready:true}),{error:null,nextStep:null});
});

test('termination requires confirmation and a stopped Pod and preserves network volumes',async t=>{
  const f=await fixture(t);await connect(f);
  const route='/api/runpod/manage/pods/oldpod/action';
  assert.equal((await f.request(route,'POST',{action:'terminate',confirm:true})).status,409);
  await f.request(route,'POST',{action:'stop',confirm:true});
  assert.equal((await f.request(route,'POST',{action:'terminate'})).status,400);
  assert.equal((await f.request(route,'POST',{action:'terminate',confirm:true})).status,200);
  assert.equal(f.pods.length,0);assert.equal(f.volumes.length,1);
  assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
  assert.ok(f.calls.find(c=>c.method==='DELETE').url.endsWith('/pods/oldpod'));
});


test('YuE2 serverless creates zero-idle song workers, supports new shared storage, and connects without a Pod',async t=>{
  const f=await fixture(t);await connect(f);
  const plan=await(await f.request('/api/runpod/manage/review','POST',{...existing,workload:'yue2-serverless',storage:'new',volumeName:'Shared models',volumeSize:50,dataCenter:'DC1'})).json();
  assert.equal(plan.workload,'yue2-serverless');assert.equal(plan.hourly,0.4);
  const response=await f.request('/api/runpod/manage/deploy','POST',{planId:plan.id,confirmPaid:true});
  assert.equal(response.status,201,await response.clone().text());assert.equal((await response.json()).endpointId,'newep');assert.equal(f.created,0);
  const payload=f.calls.find(c=>c.method==='POST'&&c.url.endsWith('/serverless')).input;
  assert.deepEqual(payload.workers,{min:0,max:10,idleTimeout:10});assert.equal(payload.gpu.count,1);assert.deepEqual(payload.networkVolumes,['newvol']);assert.equal(payload.env.YUE2_ROOT,'/runpod-volume/yue2');
  const state=await(await f.request('/api/studio')).json();assert.equal(state.runpod.mode,'serverless');assert.equal(state.runpod.configured,true);assert.equal(state.runpod.endpointId,'newep');assert.ok(!JSON.stringify(state).includes(secret));
  assert.equal((await f.request('/api/runpod/manage/endpoints/newep/connect','POST',{})).status,200);
  assert.equal((await f.request('/api/runpod/manage/deploy','POST',{planId:plan.id,confirmPaid:true})).status,201);assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/serverless')).length,1);
});


test('Studio resource links use recorded associations, preserve account names, and store labels and notes locally',async t=>{
  const f=await fixture(t);let state=await connect(f);
  assert.equal(state.inventory.volumes[0].studioLinked,false);assert.equal(state.inventory.pods[0].studioLinked,false);
  const before=f.calls.filter(c=>c.method!=='GET').length;
  const linked=await f.request('/api/runpod/manage/resources/pods/oldpod','PUT',{label:'My song GPU',notes:'Reuses the song model cache'});assert.equal(linked.status,200);
  state=await linked.json();assert.equal(state.inventory.pods[0].studioLinked,true);assert.equal(state.inventory.pods[0].studioLabel,'My song GPU');assert.equal(f.pods[0].name,'Existing Pod');
  assert.equal(f.calls.filter(c=>c.method!=='GET').length,before);
  assert.equal((await f.request('/api/runpod/manage/resources/volumes/missing','PUT',{label:'Foreign',notes:''})).status,404);
  assert.equal((await f.request('/api/runpod/manage/resources/volumes/existingvol','PUT',{label:'x'.repeat(121),notes:''})).status,400);
  const plan=await(await f.request('/api/runpod/manage/review','POST',existing)).json();await f.request('/api/runpod/manage/deploy','POST',{planId:plan.id,confirmPaid:true});
  state=await(await f.request('/api/runpod/manage/refresh','POST',{})).json();assert.equal(state.inventory.volumes[0].studioLinked,true);assert.equal(state.inventory.pods.find(p=>p.id==='newpod').studioLinked,true);assert.equal(state.inventory.endpoints[0].studioLinked,false);
  const saved=JSON.parse(readFileSync(path.join(f.temp,'data','runpod-management.json'),'utf8'));assert.equal(saved.resourceLinks.pods.oldpod.notes,'Reuses the song model cache');
});


test('automatic scan builds a compatible multi-pool endpoint within the reviewed regional rate limit',async t=>{
  const f=await fixture(t);await connect(f);
  const plan=await(await f.request('/api/runpod/manage/review','POST',{...existing,workload:'yue2-serverless',gpuId:'__auto__',maxGpuHourly:1.6})).json();
  assert.equal(plan.automatic,true);assert.equal(plan.gpuOptions.length,2);assert.equal(plan.hourly,1.5);
  const result=await f.request('/api/runpod/manage/deploy','POST',{planId:plan.id,confirmPaid:true});assert.equal(result.status,201,await result.clone().text());
  const endpoint=f.calls.find(c=>c.method==='POST'&&c.url.endsWith('/serverless')).input;assert.deepEqual(new Set(endpoint.gpu.pools),new Set(['ADA_24','AMPERE_48']));assert.equal(endpoint.gpu.count,1);
  assert.equal((await f.request('/api/runpod/manage/review','POST',{...existing,gpuId:'__auto__',maxGpuHourly:0.1})).status,400);
  assert.equal((await f.request('/api/runpod/manage/review','POST',{...existing,gpuId:'__auto__',maxGpuHourly:NaN})).status,400);
});
test('control client distinguishes definite HTTP rejection from lost acknowledgement without exposing provider data',async()=>{
 for(const status of [400,401,422,500]){
  const client=createRunpodControlClient({fetcher:async()=>new Response(JSON.stringify({message:secret,env:oldToken}),{status})});
  await assert.rejects(client.request(secret,'/serverless','POST',{}),error=>{assert.equal(error.requestRejected,status<500);assert.equal(error.providerStatus,status);assert.ok(!error.message.includes(secret));assert.ok(!error.message.includes(oldToken));return true;});
 }
 const client=createRunpodControlClient({fetcher:async()=>{throw new Error(secret);}});
 await assert.rejects(client.request(secret,'/serverless','POST',{}),error=>{assert.equal(error.requestRejected,undefined);assert.ok(!error.message.includes(secret));return true;});
});
