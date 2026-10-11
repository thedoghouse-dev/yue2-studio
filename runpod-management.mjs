import path from 'node:path';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {workerPodPlan,h3PodPlan,h3EndpointPlan,yue2EndpointPlan,setupSourceHash} from './cloud/launch-plan.mjs';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const read=(file,fallback)=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const write=(file,value)=>{writeFileSync(file+'.tmp',JSON.stringify(value,null,2),{mode:0o600});renameSync(file+'.tmp',file);};
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
const listItem=(value,max=120)=>String(value??'').slice(0,max);
const money=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;

// Interpret worker diagnostics without returning raw exceptions, paths, or credentials.
export function explainSetupFailure(health) {
  if(!health.error)return {error:null,nextStep:null};
  const text=String(health.error).toLowerCase(),stage=String(health.stage??'').toLowerCase();
  let error='The worker could not finish installing its runtime or models.';
  let nextStep='Stop this GPU to pause compute charges. Your network volume stays saved. Review a new setup using the same volume to retry.';
  if(/index.lock|checkout lock/.test(text)){
    error='An interrupted source checkout left a Git lock on the shared volume.';
    nextStep='Stop the failed GPU and use Review retry setup. The updated installer recovers stale checkout locks; if the lock is recent, wait five minutes before retrying.';
  }else if(/no space|insufficient.*space|disk.*full/.test(text)){
    error='There is not enough free storage to finish installing the models.';
    nextStep='Stop the GPU, then choose a network volume with more free space before retrying setup.';
  }else if(/verification|checksum|digest mismatch/.test(text)){
    error='A downloaded model file failed its integrity check.';
    nextStep='Stop the GPU and review setup again with the same volume. Verified files are reused; the invalid download will be replaced.';
  }else if(/checkout|git.*clone|submodule/.test(text)){
    error='The worker could not prepare the audio.cpp source needed for the song engine.';
  }else if(/cmake|ninja|cuda.*build/.test(text)){
    error='The song engine could not be compiled for the selected GPU.';
  }else if(/timeout|timed out|connection|urlopen|http error|http.*[45][0-9][0-9]/.test(text)){
    error='The worker could not finish downloading a required setup file.';
  }else if(/vram|gpu.*memory|four h200|at least.*gb/.test(text)){
    error='The selected GPU configuration does not have the memory required for this model.';
    nextStep='Stop the GPU and select a compatible GPU configuration in the setup form.';
  }else if(/sglang|serving flags/.test(text)||stage.includes('loading minimax')){
    error='The MiniMax video runtime could not start.';
    nextStep='Stop the GPU to pause compute charges. The downloaded model stays on your network volume; retry setup with the supported MiniMax GPU configuration.';
  }
  return {error,nextStep};
}


export function createRunpodControlClient({fetcher=fetch}={}) {
  async function request(key,route,method='GET',input) {
    let res;
    try {res=await fetcher('https://api.runpod.io/v2'+route,{method,redirect:'error',signal:AbortSignal.timeout(45000),headers:{Authorization:`Bearer ${key}`,...(input?{'Content-Type':'application/json'}:{})},body:input?JSON.stringify(input):undefined});}
    catch {fail(method==='GET'?'Cannot reach RunPod. Check your internet connection.':'RunPod did not acknowledge this change. Refresh resources and check the console before trying again.',502);}
    if(!res.ok){try{fail(res.status===401||res.status===403?'RunPod rejected the API key or its permissions. Use a key with access to Pods, storage, and the catalog.':`RunPod request failed (${res.status}). Check capacity, credit balance, and permissions in the RunPod console.`,res.status===401||res.status===403?400:502);}catch(error){error.requestRejected=res.status>=400&&res.status<500;error.providerStatus=res.status;throw error;}}
    if(res.status===204)return {};
    const text=await res.text();if(text.length>8*1024*1024)fail('RunPod response is too large.',502);
    try{return JSON.parse(text);}catch{fail('RunPod returned invalid metadata.',502);}
  }
  async function list(key,route,field,paginated=false) {
    const entries=[];let cursor;
    for(let page=0;page<20;page++) {
      const url=route+(cursor?(route.includes('?')?'&':'?')+'cursor='+encodeURIComponent(cursor):'');
      const value=await request(key,url);
      if(!Array.isArray(value[field]))fail('RunPod returned an unexpected resource list.',502);
      entries.push(...value[field]);
      if(!paginated||!value.pagination?.hasNextPage)return entries;
      cursor=value.pagination.nextCursor;if(typeof cursor!=='string'||!cursor||cursor.length>2000)fail('Invalid RunPod pagination.',502);
    }
    fail('Your RunPod resource list exceeds this app’s limit. Narrow it in the console.',502);
  }
  return {request,list};
}

// Published RunPod storage list rates, verified 2026-10-09. Estimates, not invoices.
export function estimateVolumeStorage(volume) {
  if(!Number.isFinite(volume.size)||volume.size<=0)return null;
  const rate=volume.type==='HIGH_PERFORMANCE'?0.14:volume.type==='STANDARD'?(volume.size>=1024?0.05:0.07):null;
  if(rate===null)return null;
  const monthly=volume.size*rate;
  return {monthly,daily:monthly/30,yearly:monthly*12,ratePerGBMonth:rate,source:'https://www.runpod.io/pricing',verifiedOn:'2026-10-09'};
}

export function createRunpodManagement({root,data,client=createRunpodControlClient(),workerClient,connectWorker,connectVideo,connectServerless,connectSongServerless,isBusy=()=>false}) {
  const keyFile=path.join(data,'runpod-account.json'),file=path.join(data,'runpod-management.json');
  let account=read(keyFile,{key:''});const db=read(file,{pods:[],plans:[],inventory:null});
  db.endpoints??=[];
  db.volumeActivity??={};
  db.resourceLinks??={pods:{},volumes:{},endpoints:{}};
  let busy=false,refreshing;
  const save=()=>write(file,db);
  const publicPlan=p=>({id:p.id,includeVideo:Boolean(p.includeVideo),workload:p.workload??'yue2',gpuCount:p.gpuCount??1,maxWorkers:p.maxWorkers,endpointId:p.endpointId,gpuName:p.gpuName,automatic:Boolean(p.automatic),gpuOptions:p.gpuOptions??[],minHourly:p.minHourly??p.hourly,cloud:p.cloud,hourly:p.hourly,storage:p.storage,volumeName:p.volumeName,volumeSize:p.volumeSize,dataCenter:p.dataCenter,expiresAt:p.expiresAt,status:p.status,error:p.error,podId:p.podId,volumeId:p.volumeId,sourceHash:p.sourceHash});
  function scopedInventory() {
    if(!db.inventory)return null;
    const linkedPods=new Set([...db.pods.map(p=>p.id),...Object.keys(db.resourceLinks.pods)]);
    const linkedEndpoints=new Set([...db.endpoints.map(e=>e.id),...Object.keys(db.resourceLinks.endpoints)]);
    const linkedVolumes=new Set([...Object.keys(db.resourceLinks.volumes),...db.pods.map(p=>p.volumeId),...db.endpoints.map(e=>e.volumeId),...db.plans.filter(p=>p.storage==='new'&&p.volumeId).map(p=>p.volumeId)]);
    for(const p of db.inventory.pods)if(linkedPods.has(p.id)&&p.volumeId)linkedVolumes.add(p.volumeId);
    for(const e of db.inventory.endpoints)if(linkedEndpoints.has(e.id))for(const id of e.volumeIds)linkedVolumes.add(id);
    const annotate=(kind,items,linked)=>items.map(item=>({...item,studioLinked:linked.has(item.id),studioLabel:db.resourceLinks[kind][item.id]?.label??'',studioNotes:db.resourceLinks[kind][item.id]?.notes??''}));
    return {...db.inventory,pods:annotate('pods',db.inventory.pods,linkedPods),volumes:annotate('volumes',db.inventory.volumes,linkedVolumes).map(volume=>({...volume,storageEstimate:estimateVolumeStorage(volume),lastStudioActivity:db.volumeActivity[volume.id]??lastSetup(volume.id),attachments:[...db.inventory.pods.filter(p=>p.volumeId===volume.id).map(p=>({kind:'Pod',id:p.id,name:p.name,status:p.status})),...db.inventory.endpoints.filter(e=>e.volumeIds.includes(volume.id)).map(e=>({kind:'Endpoint',id:e.id,name:e.name,status:e.maxWorkers===0?'Paused':'Configured'}))]})),endpoints:annotate('endpoints',db.inventory.endpoints,linkedEndpoints)};
  }
  function lastSetup(volumeId) {
    const setup=db.pods.filter(p=>p.volumeId===volumeId&&Number.isFinite(Date.parse(p.createdAt))).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
    return setup?{at:setup.createdAt,reason:'Model setup launched'}:null;
  }
  function recordUsage(connection,reason) {
    const endpointId=connection.endpointId,match=/^https:\/\/([a-z0-9]+)-(?:8000|30010)\.proxy\.runpod\.net$/.exec(connection.url??connection.podURL??'');
    const volumes=endpointId?(db.inventory?.endpoints.find(e=>e.id===endpointId)?.volumeIds??[db.endpoints.find(e=>e.id===endpointId)?.volumeId]):[db.inventory?.pods.find(p=>p.id===match?.[1])?.volumeId??db.pods.find(p=>p.id===match?.[1])?.volumeId];
    for(const id of volumes.filter(Boolean))db.volumeActivity[id]={at:new Date().toISOString(),reason};
    if(volumes.some(Boolean))save();
  }
  const state=()=>({configured:Boolean(account.key),inventory:scopedInventory(),managedEndpoints:db.endpoints.map(e=>({id:e.id,name:e.name,volumeId:e.volumeId,maxWorkers:db.inventory?.endpoints?.find(item=>item.id===e.id)?.maxWorkers??e.maxWorkers,workload:e.workload??'h3-serverless'})),managedPods:db.pods.map(p=>({id:p.id,name:p.name,createdAt:p.createdAt,volumeId:p.volumeId,workload:p.workload??'yue2',health:p.health??null})),plans:db.plans.map(publicPlan),busy});
  const requireKey=()=>{if(!account.key)fail('Save your RunPod account API key first.',409);};
  const guard=()=>{if(busy)fail('A RunPod change is already in progress.',409);};
  async function mutate(work) {guard();busy=true;try{return await work();}finally{busy=false;}}
  function podView(pod) {
    return {id:listItem(pod.id),name:listItem(pod.name),status:listItem(pod.status),actions:(pod.actions??[]).filter(a=>['start','stop'].includes(a)),hourly:money(pod.cost),gpuName:listItem(pod.gpu?.id),gpuCount:pod.gpu?.count??null,cloud:pod.cloud,dataCenter:listItem(pod.dataCenterId),volumeId:pod.mounts?.network?.[0]?.volumeId??null,managed:db.pods.some(p=>p.id===pod.id),workload:pod.env?.YUE2_STUDIO_WORKLOAD??'yue2',songWorker:!pod.env?.YUE2_STUDIO_WORKLOAD&&Boolean(pod.env?.YUE2_WORKER_TOKEN&&pod.ports?.includes('8000/http'))};
  }
  async function inventory() {
    requireKey();if(refreshing)return refreshing;
    refreshing=(async()=>{
      const [pods,volumes,endpoints]=await Promise.all([client.list(account.key,'/pods','pods',true),client.list(account.key,'/network-volumes','networkVolumes'),client.list(account.key,'/serverless','endpoints',true)]);
      // Recover acknowledgements lost during pod/volume creation; never repeat a paid POST.
      for(const plan of db.plans.filter(p=>['submitting','unknown'].includes(p.status))) {
        const found=endpoints.filter(e=>e.env?.YUE2_STUDIO_DEPLOYMENT===plan.id);if(plan.workload?.endsWith('-serverless')&&found.length===1){plan.endpointId=found[0].id;plan.status='deployed';registerEndpoint(plan,found[0]);}
        const matches=pods.filter(p=>p.env?.YUE2_STUDIO_DEPLOYMENT===plan.id);
        if(matches.length===1){plan.podId=matches[0].id;plan.status='deployed';register(plan,matches[0]);}
        if(plan.storage==='new'&&!plan.volumeId){const candidates=volumes.filter(v=>v.name===plan.remoteVolumeName);if(candidates.length===1)plan.volumeId=candidates[0].id;}
      }
      db.inventory={checkedAt:new Date().toISOString(),pods:pods.map(podView),volumes:volumes.map(v=>({id:listItem(v.id),name:listItem(v.name),size:v.size,dataCenter:listItem(v.dataCenter),type:listItem(v.type)})),endpoints:endpoints.map(e=>({id:listItem(e.id),name:listItem(e.name),managed:db.endpoints.some(m=>m.id===e.id),type:listItem(e.type),minWorkers:e.workers?.min??null,maxWorkers:e.workers?.max??null,volumeIds:(e.networkVolumes??[]).map(v=>typeof v==='string'?v:v.id)}))};save();return state();
    })().finally(()=>refreshing=null);return refreshing;
  }
  function register(plan,pod) {
    if(!identifier(pod.id))fail('RunPod returned an invalid Pod ID.',502);
    if(!db.pods.some(p=>p.id===pod.id))db.pods.push({id:pod.id,name:pod.name,token:plan.workerToken,workload:plan.workload??'yue2',volumeId:plan.volumeId??'',createdAt:new Date().toISOString()});
  }
  function registerEndpoint(plan,endpoint){if(!identifier(endpoint.id))fail('RunPod returned an invalid endpoint ID.',502);if(!db.endpoints.some(e=>e.id===endpoint.id))db.endpoints.push({id:endpoint.id,name:endpoint.name,volumeId:plan.volumeId,maxWorkers:plan.maxWorkers,workload:plan.workload});}
  async function catalog(cloud='SECURE',workload='yue2') {
    requireKey();if(!['yue2','yue2-serverless','h3-video','h3-download','h3-serverless'].includes(workload))fail('Choose a supported model installation.');if(!['SECURE','COMMUNITY'].includes(cloud))fail('Choose a valid RunPod cloud.');
    const [gpus,centers]=await Promise.all([client.list(account.key,`/catalog/gpus?include=AVAILABILITY&product=${workload.endsWith('-serverless')?'SERVERLESS':'POD'}&count=${['h3-video','h3-serverless'].includes(workload)?4:1}&cloud=${cloud}&minCudaVersion=${['h3-video','h3-serverless'].includes(workload)?'13.0':'12.8'}`,'gpus'),client.list(account.key,'/catalog/datacenters','dataCenters')]);
    return {poolMembers:gpus.map(g=>({id:g.id,pool:g.pool,memory:g.memory,manufacturer:g.manufacturer,hourly:money(g.price?.[workload.endsWith('-serverless')?'serverless':cloud.toLowerCase()])})),gpus:gpus.filter(g=>g.manufacturer==='NVIDIA'&&g.memory>=24&&(workload.endsWith('-serverless')?Boolean(g.pool):g[cloud.toLowerCase()])&&(!['h3-video','h3-serverless'].includes(workload)||(g.memory>=140&&/H200/i.test(g.name)))).map(g=>({id:g.id,name:g.name,memory:g.memory,pool:g.pool,excludedTypes:gpus.filter(other=>other.pool===g.pool&&(workload==='h3-serverless'?!/H200/i.test(other.name):other.manufacturer!=='NVIDIA'||other.memory<24)).map(other=>other.id),hourly:money(g.price?.[workload.endsWith('-serverless')?'serverless':cloud.toLowerCase()]),availability:g.availability,dataCenters:g.dataCenters??[]})),dataCenters:centers.map(d=>({id:d.id,name:d.name,storageTypes:d.networkVolumeTypes??[]}))};
  }
  async function review(input) {
    const workload=input.workload??'yue2',includeVideo=input.includeVideo===true&&workload==='yue2',gpuCount=['h3-video','h3-serverless'].includes(workload)?4:1,minimumSize=workload.startsWith('yue2')&&!includeVideo?30:200;
    const cloud=input.cloud??'SECURE',resources=await inventory(),choices=await catalog(cloud,workload);
    const automatic=input.gpuId==='__auto__';
    if(automatic&&(typeof input.maxGpuHourly!=='number'||!Number.isFinite(input.maxGpuHourly)||input.maxGpuHourly<=0||input.maxGpuHourly>100))fail('Choose a quoted GPU rate limit from $0.01 to $100 per GPU-hour.');
    const storage=input.storage??'existing';if(!['existing','new','pod'].includes(storage))fail('Choose a storage option.');
    if((workload!=='yue2'||includeVideo)&&storage==='pod')fail('Serverless and MiniMax require network storage. Choose an existing or new network volume.');
    let volume,dataCenter='',volumeName='',volumeSize=50;
    if(storage==='existing') {volume=resources.inventory.volumes.find(v=>v.id===input.volumeId);if(!volume||volume.size<minimumSize)fail(`Choose a network volume of at least ${minimumSize} GB.`);dataCenter=volume.dataCenter;volumeName=volume.name;volumeSize=volume.size;}
    if(storage==='new') {dataCenter=input.dataCenter;if(!choices.dataCenters.some(d=>d.id===dataCenter&&d.storageTypes.length))fail('Choose a data center with network storage.');volumeName=listItem(input.volumeName,80).trim();if(!volumeName)fail('Name the new network volume.');volumeSize=input.volumeSize;if(!Number.isInteger(volumeSize)||volumeSize<minimumSize||volumeSize>500)fail(`Choose ${minimumSize}–500 GB of storage.`);}
    let options=automatic?choices.gpus.filter(g=>g.hourly!==null&&g.hourly<=input.maxGpuHourly&&g.availability!=='NONE'&&(!dataCenter||g.dataCenters.some(d=>d.id===dataCenter&&d.availability!=='NONE'))):choices.gpus.filter(g=>g.id===input.gpuId);
    if(!options.length)fail(automatic?'No compatible GPU with capacity fits this volume region and quoted rate limit. Raise the limit, choose another region/volume, or refresh and scan again.':'Choose an available NVIDIA GPU suitable for this installation with a published price.');
    const capacityRank=g=>({HIGH:0,MEDIUM:1,LOW:2,NONE:4}[dataCenter?g.dataCenters.find(d=>d.id===dataCenter)?.availability:g.availability]??3);
    options.sort((a,b)=>capacityRank(a)-capacityRank(b)||a.hourly-b.hourly);
    let gpu=options[0];
    if(gpu.hourly===null||gpu.availability==='NONE')fail('This GPU currently has no capacity or published rate. Choose another GPU.');
    if(!workload.endsWith('-serverless'))options=[gpu];
    const pools=[...new Set(options.map(g=>g.pool).filter(Boolean))];
    const selected=new Set(options.map(g=>g.id));
    const excludedTypes=choices.poolMembers.filter(g=>pools.includes(g.pool)&&!selected.has(g.id)).map(g=>g.id);
    if(dataCenter&&!gpu.dataCenters.some(d=>d.id===dataCenter&&d.availability!=='NONE'))fail('This GPU is not available in your volume’s data center. Choose a different GPU or volume.');
    if(workload==='h3-serverless'&&storage!=='existing')fail('Prepare a network volume first, then select it for serverless.');
    const maxWorkers=input.maxWorkers??10;if(!Number.isInteger(maxWorkers)||maxWorkers<1||maxWorkers>10)fail('Choose 1–10 serverless workers.');
    const plan={id:randomUUID(),includeVideo,maxWorkers,automatic,maxGpuHourly:input.maxGpuHourly,pools,pool:gpu.pool,excludedTypes, gpuOptions:options.map(g=>({id:g.id,name:g.name,memory:g.memory,hourly:g.hourly})),minHourly:Math.min(...options.map(g=>g.hourly))*gpuCount,workload,gpuCount,gpuId:gpu.id,gpuName:automatic&&workload.endsWith('-serverless')?'Automatic · '+options.map(g=>g.name).join(', '):gpu.name,cloud,hourly:Math.max(...options.map(g=>g.hourly))*gpuCount,storage,volumeName,volumeSize,dataCenter,volumeId:volume?.id??'',workerToken:randomBytes(32).toString('hex'),sourceHash:setupSourceHash(root,workload,includeVideo),expiresAt:new Date(Date.now()+10*60000).toISOString(),status:'review'};
    plan.remoteVolumeName=volumeName+' · '+plan.id.slice(0,8);db.plans=db.plans.filter(p=>p.status!=='review');db.plans.push(plan);save();return publicPlan(plan);
  }
  async function deploy(input) {
    return mutate(async()=>{
      requireKey();if(input.confirmPaid!==true)fail('Review the plan and confirm the paid launch.');
      const plan=db.plans.find(p=>p.id===input.planId);if(!plan)fail('Review a deployment plan first.');
      if(plan.status==='deployed')return publicPlan(plan);
      if(plan.status!=='review')fail('This launch may already exist. Refresh resources and check RunPod before reviewing a new launch.',409);
      if(Date.parse(plan.expiresAt)<Date.now())fail('This price review expired. Review a fresh plan.');
      if((plan.includeVideo||plan.workload?.startsWith('h3-'))&&input.confirmModelLicense!==true)fail('Review the MiniMax model license before installing.');
      if(setupSourceHash(root,plan.workload??'yue2',Boolean(plan.includeVideo))!==plan.sourceHash)fail('Worker files changed. Review a fresh plan.');
      const latest=await catalog(plan.cloud,plan.workload??'yue2');
      let gpu=latest.gpus.find(g=>g.id===plan.gpuId);
      if(plan.automatic){
        const approved=new Set(plan.gpuOptions.map(g=>g.id));
        const eligible=latest.gpus.filter(g=>approved.has(g.id)&&g.hourly!==null&&g.hourly*(plan.gpuCount??1)<=plan.hourly&&g.availability!=='NONE'&&(!plan.dataCenter||g.dataCenters.some(d=>d.id===plan.dataCenter&&d.availability!=='NONE')));
        if(!eligible.length)fail('No reviewed GPU has capacity within the quoted rate. Refresh and scan again.');
        gpu=eligible[0];plan.gpuId=gpu.id;
        plan.pools=[...new Set(eligible.map(g=>g.pool).filter(Boolean))];
        const chosen=new Set(eligible.map(g=>g.id));plan.excludedTypes=latest.poolMembers.filter(g=>plan.pools.includes(g.pool)&&!chosen.has(g.id)).map(g=>g.id);
      }
      if(!gpu||gpu.availability==='NONE'||gpu.hourly===null||gpu.hourly*(plan.gpuCount??1)>plan.hourly)fail('The GPU quote changed. Review a fresh plan before paying.');
      plan.status='submitting';save();
      try {
        if(plan.storage==='new') {const volume=await client.request(account.key,'/network-volumes','POST',{name:plan.remoteVolumeName,size:plan.volumeSize,dataCenter:plan.dataCenter});if(!identifier(volume.id))fail('RunPod returned an invalid volume ID.',502);plan.volumeId=volume.id;save();}
        if(plan.workload==='yue2-serverless'){const endpoint=await client.request(account.key,'/serverless','POST',yue2EndpointPlan({root,name:'YuE2 songs · '+plan.id.slice(0,8),volumeId:plan.volumeId,dataCenter:plan.dataCenter,workerToken:plan.workerToken,deploymentId:plan.id,pool:plan.pool,pools:plan.pools,excludedTypes:plan.excludedTypes,maxWorkers:plan.maxWorkers}));registerEndpoint(plan,endpoint);plan.endpointId=endpoint.id;plan.status='deployed';save();await connectSongServerless({mode:'serverless',endpointId:endpoint.id});return publicPlan(plan);}
        if(plan.workload==='h3-serverless'){const endpoint=await client.request(account.key,'/serverless','POST',h3EndpointPlan({root,name:'YuE2 H3 queue · '+plan.id.slice(0,8),volumeId:plan.volumeId,dataCenter:plan.dataCenter,workerToken:plan.workerToken,deploymentId:plan.id,pool:plan.pool,pools:plan.pools,excludedTypes:plan.excludedTypes,maxWorkers:plan.maxWorkers}));registerEndpoint(plan,endpoint);plan.endpointId=endpoint.id;plan.status='deployed';save();await connectServerless({endpointId:endpoint.id});return publicPlan(plan);}
        const builder=plan.workload&&plan.workload!=='yue2'?h3PodPlan:workerPodPlan;
        const pod=await client.request(account.key,'/pods','POST',builder({root,includeVideo:plan.includeVideo,workload:plan.workload,gpuId:plan.gpuId,cloud:plan.cloud,name:(plan.workload&&plan.workload!=='yue2'?'MiniMax H3':'YuE2 Studio')+' · '+plan.id.slice(0,8),volumeId:plan.volumeId,dataCenter:plan.dataCenter,workerToken:plan.workerToken,deploymentId:plan.id}));
        register(plan,pod);plan.podId=pod.id;plan.status='deployed';save();return publicPlan(plan);
      } catch(error) {plan.status=error.requestRejected?'failed':'unknown';plan.error=error.message;save();fail(`${error.message}${plan.volumeId?' The network volume remains saved and may have storage charges.':''} ${plan.status==='unknown'?'Refresh resources to check for an acknowledged launch before trying again.':'Review a fresh setup after correcting the issue.'}`,502);}
    });
  }
  async function checkPod(id,connect=false) {
    requireKey();if(!identifier(id))fail('Invalid Pod ID.');
    const managed=db.pods.find(p=>p.id===id),pod=await client.request(account.key,`/pods/${encodeURIComponent(id)}`);
    const token=managed?.token??pod.env?.YUE2_WORKER_TOKEN,workload=managed?.workload??pod.env?.YUE2_STUDIO_WORKLOAD??'yue2';
    if(!token||!pod.ports?.includes('8000/http'))fail('This Pod does not expose a Studio installer or worker. Use manual connection for other services.');
    if(!/^[a-z0-9]+$/.test(id))fail('This Pod ID cannot be used with RunPod’s HTTPS proxy.');
    const config={url:`https://${id}-8000.proxy.runpod.net`,token};
    let health;
    try {health=pod.status==='RUNNING'?await (workload==='yue2'?workerClient.health(config):workerClient.setupHealth(config)):{ready:false,stage:`Pod is ${listItem(pod.status)}. Start it and wait for the worker to be ready.`};}catch {health={ready:false,stage:'Waiting for the worker’s HTTP service. Refresh readiness shortly.'};}
    const safe={workload,ready:Boolean(health.ready),stage:listItem(health.stage,250),...explainSetupFailure(health),checkedAt:new Date().toISOString()};
    if(managed){managed.health=safe;save();}
    if(connect){if(workload==='h3-download')fail('This Pod only downloads the model. Review a MiniMax video service using the same volume.',409);if(!safe.ready)fail(safe.error||safe.stage,409);if(workload==='h3-video')await connectVideo({url:`https://${id}-30010.proxy.runpod.net`,token});else await connectWorker(config);}
    return safe;
  }
  return {state,recordUsage,inferenceKey:()=>account.key,async handle(req,res,route,{body,send}) {
    if(!route.startsWith('/api/runpod/manage'))return false;
    if(route==='/api/runpod/manage'&&req.method==='GET'){send(res,200,state());return true;}
    if(route==='/api/runpod/manage/key'&&req.method==='PUT') {
      const input=await body(req);guard();if(refreshing)fail('Wait for the resource refresh before changing keys.',409);
      const key=input.key;if(typeof key!=='string'||!key.trim()||key.length>512||!/^[\x21-\x7e]+$/.test(key))fail('Enter a RunPod API key.');
      await mutate(async()=>{await client.list(key,'/pods','pods',true);account={key};write(keyFile,account);db.inventory=null;db.plans=db.plans.filter(p=>p.status!=='review');save();});send(res,200,state());return true;
    }
    if(route==='/api/runpod/manage/key'&&req.method==='DELETE'){guard();if(refreshing)fail('Wait for the resource refresh before removing the key.',409);account={key:''};write(keyFile,account);db.inventory=null;save();send(res,200,state());return true;}
    if(route==='/api/runpod/manage/refresh'&&req.method==='POST'){send(res,200,await inventory());return true;}
    const resourceMatch=/^\/api\/runpod\/manage\/resources\/(pods|volumes|endpoints)\/([a-zA-Z0-9_-]{1,100})$/.exec(route);
    if(resourceMatch&&req.method==='PUT'){
      const input=await body(req);send(res,200,await mutate(async()=>{
        requireKey();const [_,kind,id]=resourceMatch;
        const resources=await inventory();if(!resources.inventory[kind].some(r=>r.id===id))fail('Refresh resources and select an item in this account.',404);
        for(const [field,limit] of [['label',120],['notes',1000]])if(typeof input[field]!=='string'||input[field].length>limit||/\0/.test(input[field]))fail('Enter a valid Studio label and notes.');
        db.resourceLinks[kind][id]={label:input.label.trim(),notes:input.notes.trim()};save();return state();
      }));return true;
    }
    if(route==='/api/runpod/manage/catalog'&&req.method==='GET'){const cloud=new URL(req.url,'http://localhost').searchParams.get('cloud');send(res,200,await catalog(cloud??'SECURE',new URL(req.url,'http://localhost').searchParams.get('workload')??'yue2'));return true;}
    if(route==='/api/runpod/manage/review'&&req.method==='POST'){const input=await body(req);send(res,200,await mutate(()=>review(input)));return true;}
    if(route==='/api/runpod/manage/deploy'&&req.method==='POST'){send(res,201,await deploy(await body(req)));return true;}
    const endpointMatch=/^\/api\/runpod\/manage\/endpoints\/([a-zA-Z0-9_-]{1,100})\/connect$/.exec(route);
    if(endpointMatch&&req.method==='POST'){requireKey();const endpoint=db.endpoints.find(e=>e.id===endpointMatch[1]);if(!endpoint)fail('Select a queue endpoint created by this app.',409);const live=await client.request(account.key,'/serverless/'+endpoint.id);if(live.workers?.max===0)fail('This endpoint is paused. Review a new serverless setup before generating.',409);if(endpoint.workload==='yue2-serverless')await connectSongServerless({mode:'serverless',endpointId:endpoint.id});else await connectServerless({endpointId:endpoint.id});send(res,200,{connected:true});return true;}
    const match=/^\/api\/runpod\/manage\/pods\/([a-zA-Z0-9_-]{1,100})\/(check|connect|action|quote)$/.exec(route);
    if(match&&req.method==='POST') {
      const [_,id,action]=match;
      if(action==='quote'){requireKey();const pod=await client.request(account.key,`/pods/${id}`);const choices=await catalog(pod.cloud);const gpu=choices.gpus.find(g=>g.id===pod.gpu?.id);if(!gpu||gpu.hourly===null)fail('Cannot quote this Pod in the studio. Review its price in the RunPod console.');send(res,200,{hourly:gpu.hourly*(pod.gpu.count??1)});return true;}
      if(action==='action') {const input=await body(req);send(res,200,await mutate(async()=>{requireKey();if(!['start','stop','terminate'].includes(input.action))fail('Choose Start, Stop, or Terminate.');if(input.confirm!==true)fail('Confirm the Pod action.');if(isBusy(id))fail('This Pod has an active or queued generation. Wait or cancel it before changing the Pod.',409);const pod=await client.request(account.key,`/pods/${id}`);if(input.action==='terminate'){
          if(pod.status!=='EXITED')fail('Stop this Pod before terminating it.',409);
          await client.request(account.key,`/pods/${id}`,'DELETE');
          db.pods=db.pods.filter(p=>p.id!==id);
          if(db.inventory)db.inventory.pods=db.inventory.pods.filter(p=>p.id!==id);
          save();return {id,terminated:true};
        }if(!pod.actions?.includes(input.action))fail('This action is not available for the current Pod state.',409);if(input.action==='start'){const choices=await catalog(pod.cloud);const gpu=choices.gpus.find(g=>g.id===pod.gpu?.id);const hourly=gpu?.hourly==null?null:gpu.hourly*(pod.gpu.count??1);if(hourly===null||typeof input.maxHourly!=='number'||hourly>input.maxHourly)fail('The Pod rate changed or is unavailable. Review its start price again.');}return podView(await client.request(account.key,`/pods/${id}/action`,'POST',{action:input.action}));}));}
      else send(res,200,await mutate(()=>checkPod(id,action==='connect')));
      return true;
    }
    fail('RunPod management endpoint not found.',404);
  }};
}
