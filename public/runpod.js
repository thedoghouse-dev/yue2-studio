const $=id=>document.getElementById(id);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
export const filterStudioResources=(items,showAll=false)=>(items??[]).filter(item=>showAll||item.studioLinked);
const price=value=>typeof value==='number'?`$${value.toFixed(3)}/hour`:'Rate unavailable';

export function setupRunpod({getStudio,api,refresh,toast}) {
  let busy=false,opened=false,catalog={gpus:[],dataCenters:[]},plan=null,signature='',action=null,actionPending=false,checking=false,pendingId='',resourceEdit=null,resourcePending=false,launchNotice='';
  try {pendingId=sessionStorage.getItem('yue2-runpod-pending')??'';}catch{}
  const state=()=>getStudio()?.runpodManagement??{};
  const error=(message,target='rp-error')=>{
    for(const id of ['rp-error','rp-review-error','rp-action-error','rp-resource-error','rp-launch-error']){$(id).textContent='';$(id).hidden=true;}
    if(!message)return;
    const element=$(target);element.textContent=message;element.hidden=false;
    if(['rp-review-error','rp-launch-error'].includes(target)){element.focus({preventScroll:true});element.scrollIntoView({behavior:'smooth',block:'nearest'});}
  };
  const workload=()=>$('rp-workload').value==='yue2-h3'?'yue2':$('rp-workload').value;
  const includesVideo=()=>$('rp-workload').value==='yue2-h3';
  const minSize=()=>workload().startsWith('yue2')&&!includesVideo()?30:200;
  const queueMode=()=>workload().endsWith('-serverless');
  const needsLicense=p=>Boolean(p?.includeVideo||p?.workload?.startsWith('h3-'));
  function storageFields() {
    const mode=$('rp-storage').value,kind=workload();
    $('rp-combined-info').hidden=!includesVideo();
    $('rp-model-info').textContent=kind==='yue2-serverless'?'On-demand BF16 songs, with no always-running Pod. Setup creates zero idle workers. Your first song builds any missing runtime and downloads models onto the shared volume; that initialization is billed and may take several minutes. Later songs reuse the cache.':kind==='yue2'?(includesVideo()?'Install YuE2 and cache MiniMax H3 on the same volume. This prepares models without starting a video service.':'Install YuE2 BF16 + F32 decoder for songs.'):kind==='h3-download'?'Download the pinned H3 Base FL2VA checkpoint (~144 GB) onto a network volume. This starts a temporary download Pod, not a video service. Stop the Pod when the download is finished.':kind==='h3-serverless'?'Configure on-demand video workers using a volume prepared in the previous step. Setup starts no video service and sends no generation jobs. Default: 0 idle workers, up to 10 workers.':'Optional dedicated H3 video Pod. Starts a persistent service on four H200 GPUs; it is billed while running.';
    $('rp-gpu-label').textContent=['h3-serverless','h3-video'].includes(kind)?'GPU type · 4 × H200 per worker':'GPU · 24 GB or more';
    $('rp-volume-info').textContent=kind==='yue2-serverless'?'YuE2 caches models and recordings under /runpod-volume/yue2. Reuse the same network volume as MiniMax. Songs are downloaded automatically into your local library.':kind==='yue2'?(includesVideo()?'YuE2 and MiniMax models share this network volume. At least 200 GB is required; 300 GB is recommended.':'YuE2 models are saved under /workspace/yue2. GPU placement follows the volume’s data center.'):'H3 models are saved under models/minimax-h3 on this volume. Serverless mounts the same files at /runpod-volume; Pods mount them at /workspace. At least 200 GB is required; 300 GB is recommended.';
    $('rp-workers-field').hidden=!queueMode();
    $('rp-storage').querySelector('option[value=pod]').disabled=kind!=='yue2'||includesVideo();
    $('rp-storage').querySelector('option[value=new]').disabled=kind==='h3-serverless';
    $('rp-volume-size').min=String(minSize());
    $('rp-existing-storage').hidden=mode!=='existing';$('rp-new-storage').hidden=mode!=='new';
    $('rp-storage-info').textContent=mode==='pod'?'50 GB of host-local Pod storage. Kept on stop/start, lost if the Pod is terminated. Storage is billed separately.':mode==='new'?'A new network volume is billed separately and remains saved after the Pod stops or is terminated.':'Your existing network volume is reused. RunPod continues its normal storage billing.';
    const gpu=catalog.gpus.find(g=>g.id===$('rp-gpu').value);
    $('rp-auto-rate-field').hidden=$('rp-gpu').value!=='__auto__';
    $('rp-gpu-info').textContent=$('rp-gpu').value==='__auto__'?'Scan runs when you click Review setup & costs. Compatible models, regional capacity, and quoted rates are checked again before deployment.':gpu?`${gpu.memory} GB VRAM · ${price(gpu.hourly)} GPU list rate · capacity: ${gpu.availability??'unknown'}. Placement and billing are confirmed by RunPod.`:'';
  }
  function buttons() {
    const configured=state().configured;
    for(const id of ['rp-save-key','rp-remove-key','rp-refresh','rp-workload','rp-max-workers','rp-auto-rate','rp-cloud','rp-gpu','rp-storage','rp-volume','rp-volume-name','rp-volume-size','rp-data-center'])$(id).disabled=busy||(!configured&&!['rp-save-key','rp-remove-key'].includes(id));
    $('rp-remove-key').disabled=busy||!configured;
    $('rp-review').disabled=busy||!configured||!$('rp-gpu').value;
    $('rp-cancel-review').disabled=busy;
    $('rp-launch').disabled=busy||!plan||!$('rp-paid').checked||(needsLicense(plan)&&!$('rp-model-license').checked);
  }
  function resourceDetails(kind,item) {
    return `${item.studioNotes?'<p class="field-help rp-recovery">'+escape(item.studioNotes)+'</p>':''}<button class="text-button" type="button" data-rp-resource="${kind}:${escape(item.id)}">${item.studioLinked?'Label &amp; notes':'Link to this Studio'}</button>`;
  }
  function volumeSummary(volume) {
    const cost=volume.storageEstimate,activity=volume.lastStudioActivity;
    const days=activity?Math.max(0,Math.floor((Date.now()-Date.parse(activity.at))/86400000)):null;
    return `<p>${cost?`<strong>Estimated storage: $${cost.monthly.toFixed(2)}/month</strong> · ~$${cost.daily.toFixed(2)}/day · $${cost.yearly.toFixed(2)}/year`:'Storage rate unavailable for this tier.'}</p><p class="field-help">${cost?`Based on allocated ${volume.size} GB at $${cost.ratePerGBMonth.toFixed(2)}/GB/month. Storage stays billed even with no workers. Daily estimate assumes 30 days; excludes GPU charges and account discounts. <a href="${cost.source}" target="_blank" rel="noreferrer">Published rates ↗</a> · checked ${cost.verifiedOn}.`:''}</p><p><strong>Last recorded Studio activity:</strong> ${activity?escape(new Date(activity.at).toLocaleString())+' · '+escape(activity.reason)+` · ${days} day${days===1?'':'s'} ago`:'Unknown · no activity recorded'}</p><p class="field-help">Activity covers setup and generation requests recorded by this Studio, including failed attempts. Use outside this app is not tracked.</p><p><strong>Attached resources:</strong> ${volume.attachments?.length?volume.attachments.map(a=>escape(a.kind+' · '+a.name+' · '+a.status)).join('; '):'None found at the last refresh'}</p><p class="field-help">Before deleting, check attached resources and back up files you need. Downloaded local songs/videos stay saved; deleting cloud storage removes cached models and any remote-only files. Models can be downloaded again, with setup time and compute charges.</p><a class="text-button" href="https://console.runpod.io/storage" target="_blank" rel="noreferrer">Manage storage in RunPod ↗</a>`;
  }
  function render() {
    const data=state(),raw=data.inventory,all=$('rp-show-all').checked,inventory=raw?{...raw,pods:filterStudioResources(raw.pods,all),volumes:filterStudioResources(raw.volumes,all),endpoints:filterStudioResources(raw.endpoints,all)}:null;
    $('rp-key-badge').textContent=data.configured?'✓ API key saved':'No key saved';$('rp-key-badge').classList.toggle('completed',Boolean(data.configured));
    $('rp-key').placeholder=data.configured?'Enter a replacement key if needed':'Paste your RunPod API key';
    $('rp-key-status').textContent=data.configured?'Your account key is saved locally. Review a launch below or manage an existing worker.':'Start with your RunPod account API key. You do not need to make a worker token.';
    const latest=data.plans?.at(-1);
    if(!busy&&latest&&['deployed','unknown','failed'].includes(latest.status))showLaunchResult(latest);
    const next=JSON.stringify([inventory,all,data.managedPods,data.managedEndpoints,workload(),includesVideo(),getStudio()?.runpod?.url,getStudio()?.videos?.connection]);
    if(signature!==next) {
      signature=next;
      const volumes=inventory?.volumes??[],selected=$('rp-volume').value;
      $('rp-volume').innerHTML='<option value="">Choose a network volume…</option>'+ (workload()==='h3-serverless'?'':'<option value="__new__">＋ Create a new network volume…</option>')+volumes.map(v=>`<option value="${escape(v.id)}" ${v.size<minSize()?'disabled':''}>${escape(v.studioLabel||v.name)} · ${v.size} GB · ${escape(v.dataCenter)}${v.size<minSize()?' · too small':''}</option>`).join('');
      if(volumes.some(v=>v.id===selected&&v.size>=minSize()))$('rp-volume').value=selected;
      else if(volumes.some(v=>v.size>=minSize()))$('rp-volume').value=volumes.find(v=>v.size>=minSize()).id;
      $('rp-resource-status').textContent=inventory?`${inventory.pods.length} ${all?'account':'Studio'} Pods · ${inventory.volumes.length} network volumes · checked ${new Date(inventory.checkedAt).toLocaleTimeString()}`:'Save a key and refresh to discover your resources.';
      $('rp-pods').innerHTML=inventory?.pods.length?inventory.pods.map(pod=>{
        const worker=data.managedPods?.find(p=>p.id===pod.id),kind=worker?.workload??pod.workload??'yue2',connected=kind==='h3-video'?getStudio()?.videos?.connection.podURL===`https://${pod.id}-30010.proxy.runpod.net`:getStudio()?.runpod?.url===`https://${pod.id}-8000.proxy.runpod.net`;
        return `<article class="song-card rp-pod"><span class="status-badge ${pod.status==='RUNNING'?'completed':''}">${escape(pod.status)}</span>${pod.managed?'<span class="project-label">Studio worker</span>':''}<h3>${escape(pod.studioLabel||pod.name)}</h3>${pod.studioLabel?'<p class="field-help">'+escape(pod.name)+'</p>':''}${resourceDetails('pods',pod)}<p class="field-help">${escape(pod.gpuName||'GPU not assigned')} ${pod.gpuCount?'× '+pod.gpuCount:''} · ${escape(pod.dataCenter)}<br>${price(pod.hourly)} reported Pod rate</p>${worker?.health&&(pod.status==='RUNNING'||worker.health.error)?`<p class="rp-health ${worker.health.error?'error-message':'field-help'}" ${worker.health.error?'role="alert"':''}>${escape(worker.health.error?worker.health.error==='Worker setup failed. Check the Pod logs in RunPod.'?'Worker setup failed. Click Check readiness for an explanation.':worker.health.error:worker.health.stage)}</p>${worker.health.error?'<p class="field-help rp-recovery">'+escape(pod.status==='RUNNING'?'1. Stop the failed GPU below to pause compute charges. 2. Use Review retry setup to reuse your storage and review the cost before retrying.':'Use Review retry setup to reuse your storage. A retry requires a new cost review; it is not guaranteed to fix the original failure.')+'</p>':''}`:''}${connected?`<p class="rp-connected">${pod.status==='RUNNING'?(kind==='h3-video'?'✓ Connected to video generation':'✓ Connected to song generation'):'Selected song engine · GPU is not running'}</p>`:''}<div class="song-actions">${pod.songWorker||kind.startsWith('h3-')?`<button class="secondary" type="button" data-rp-check="${escape(pod.id)}">Check readiness</button>${kind==='h3-download'||worker?.health?.error?'':`<button class="secondary" type="button" data-rp-connect="${escape(pod.id)}">${kind==='h3-video'?'Use for videos':'Use for songs'}</button>`}`:''}${pod.actions.includes('stop')?`<button class="${worker?.health?.error?'primary':'secondary'}" type="button" data-rp-action="stop" data-rp-id="${escape(pod.id)}">${worker?.health?.error?'Stop failed GPU':'Stop GPU'}</button>`:''}${worker?.health?.error?`<button class="secondary" type="button" data-rp-retry="${escape(pod.id)}" ${pod.status==='RUNNING'?'disabled title="Stop the failed GPU first"':''}>Review retry setup</button>`:''}${pod.status==='EXITED'?`<button class="text-button video-delete-button" type="button" data-rp-action="terminate" data-rp-id="${escape(pod.id)}">Terminate Pod</button>`:''}${pod.actions.includes('start')?`<button class="secondary" type="button" data-rp-action="start" data-rp-id="${escape(pod.id)}">Start GPU · paid</button>`:''}<a class="text-button" href="https://console.runpod.io/pods" target="_blank" rel="noreferrer">Logs &amp; console ↗</a></div></article>`;
      }).join(''):'<div class="empty-library"><h3>No Studio Pods listed.</h3><p>Review a launch above, or show all account resources to link an existing item.</p></div>';
      $('rp-volume-list').innerHTML='<h3>Network volumes</h3>'+(volumes.length?volumes.map(v=>`<div class="rp-resource-row"><p><strong>${escape(v.studioLabel||v.name)}</strong> · ${v.size} GB · ${escape(v.dataCenter)} · ${escape(v.type)}</p>${v.studioLabel?'<p class="field-help">RunPod name: '+escape(v.name)+'</p>':''}${volumeSummary(v)}${resourceDetails('volumes',v)}</div>`).join(''):'<p class="field-help">No Studio volumes linked. Show all account resources to link one, or create a new volume above.</p>');
      $('rp-endpoints').innerHTML=inventory?.endpoints.length?inventory.endpoints.map(e=>`<p><strong>${escape(e.studioLabel||e.name)}</strong> · ${escape(e.type)} · ${e.minWorkers??'?'}–${e.maxWorkers??'?'} workers ${resourceDetails('endpoints',e)} ${e.managed?`<button type="button" class="secondary" data-rp-endpoint="${escape(e.id)}" ${e.maxWorkers===0?'disabled title="Endpoint paused"':''}>${data.managedEndpoints?.find(m=>m.id===e.id)?.workload==='yue2-serverless'?'Use for songs':'Use for videos'}</button>`:''}<a class="text-button" href="https://console.runpod.io/serverless" target="_blank" rel="noreferrer">Open console ↗</a></p>`).join(''):'<p class="field-help">No serverless endpoints listed.</p>';
    }
    storageFields();buttons();
  }
  async function work(fn,errorTarget='rp-error') {
    if(busy){if(errorTarget==='rp-action-error')error('Another RunPod request is finishing. Wait a moment, then try again.',errorTarget);return;}busy=true;error();buttons();
    try {await fn();}catch(e){error(e.message,errorTarget);}finally{busy=false;render();}
  }
  async function resources() {await api('/api/runpod/manage/refresh','POST',{});await refresh();}
  async function loadCatalog() {
    $('rp-gpu-info').textContent='Loading GPU prices and capacity…';
    catalog=await api('/api/runpod/manage/catalog?cloud='+$('rp-cloud').value+'&workload='+workload());
    const selected=$('rp-gpu').value;
    catalog.gpus.sort((a,b)=>(a.name.includes('4090')?-1:0)-(b.name.includes('4090')?-1:0)||(a.hourly??Infinity)-(b.hourly??Infinity));
    $('rp-gpu').innerHTML='<option value="__auto__">Automatic · scan compatible GPUs</option>'+catalog.gpus.map(g=>`<option value="${escape(g.id)}" ${g.availability==='NONE'||g.hourly===null?'disabled':''}>${escape(g.name)} · ${g.memory} GB · ${price(g.hourly)}${g.availability==='NONE'?' · unavailable':''}</option>`).join('');
    $('rp-gpu').value=selected==='__auto__'||!catalog.gpus.some(g=>g.id===selected&&g.availability!=='NONE')?'__auto__':selected;
    const center=$('rp-data-center').value;
    $('rp-data-center').innerHTML=catalog.dataCenters.filter(d=>d.storageTypes.length).map(d=>`<option value="${escape(d.id)}">${escape(d.name)} · ${escape(d.id)}</option>`).join('');
    if(catalog.dataCenters.some(d=>d.id===center))$('rp-data-center').value=center;
    storageFields();
  }
  async function open() {
    render();if(opened||!state().configured)return;opened=true;
    await work(async()=>{await resources();await loadCatalog();});
  }
  function invalidate() {$('rp-review-error').textContent='';$('rp-review-error').hidden=true;plan=null;$('rp-launch-review').hidden=true;$('rp-paid').checked=false;$('rp-model-license').checked=false;storageFields();buttons();}
  $('rp-key-form').addEventListener('submit',event=>{event.preventDefault();work(async()=>{
    await api('/api/runpod/manage/key','PUT',{key:$('rp-key').value});$('rp-key').value='';await refresh();opened=true;invalidate();await resources();await loadCatalog();toast('RunPod account connected. No GPU has been rented.');
  });});
  $('rp-remove-key').addEventListener('click',()=>work(async()=>{await api('/api/runpod/manage/key','DELETE');opened=false;invalidate();await refresh();toast('API key removed. Running Pods and storage stay billed until stopped in RunPod.');}));
  $('rp-refresh').addEventListener('click',()=>work(async()=>{await resources();await loadCatalog();}));
  $('rp-cloud').addEventListener('change',()=>{invalidate();work(loadCatalog);});
  $('rp-workload').addEventListener('change',()=>{if(queueMode()&&$('rp-storage').value==='pod')$('rp-storage').value='existing';if(!workload().startsWith('yue2')||includesVideo()){$('rp-volume-name').value=includesVideo()?'YuE2 + MiniMax H3 models':'MiniMax H3 models';$('rp-volume-size').value='300';if($('rp-storage').value==='pod')$('rp-storage').value='new';if(workload()==='h3-serverless')$('rp-storage').value='existing';}if(['h3-video','h3-serverless'].includes(workload()))$('rp-auto-rate').value='8';signature='';invalidate();render();work(loadCatalog);});
  $('rp-volume').addEventListener('change',()=>{if($('rp-volume').value==='__new__'){$('rp-storage').value='new';invalidate();}});
  for(const id of ['rp-max-workers','rp-auto-rate','rp-gpu','rp-storage','rp-volume','rp-volume-name','rp-volume-size','rp-data-center'])$(id).addEventListener('change',invalidate);
  $('rp-plan-form').addEventListener('submit',event=>{event.preventDefault();work(async()=>{
    plan=await api('/api/runpod/manage/review','POST',{workload:workload(),maxGpuHourly:Number($('rp-auto-rate').value),includeVideo:includesVideo(),maxWorkers:Number($('rp-max-workers').value),cloud:$('rp-cloud').value,gpuId:$('rp-gpu').value,storage:$('rp-storage').value,volumeId:$('rp-volume').value,volumeName:$('rp-volume-name').value,volumeSize:Number($('rp-volume-size').value),dataCenter:$('rp-data-center').value});
    const queue=plan.workload.endsWith('-serverless'),cache=plan.workload==='h3-download';
    $('rp-plan-summary').innerHTML=`<h3>${plan.includeVideo?'YuE2 + MiniMax shared setup · ':''}${escape(plan.gpuName)} · ${plan.gpuCount} GPU${plan.gpuCount===1?'':'s'} ${queue?'per worker':''}</h3><p><strong>${plan.automatic&&queue?price(plan.minHourly)+'–':''}${price(plan.hourly)} ${queue?'per active worker':'GPU list rate'}</strong>${queue?` · up to ${plan.maxWorkers} workers (${price(plan.hourly*plan.maxWorkers)} at the cap)`:` · $${(plan.hourly*2).toFixed(3)} for two GPU hours`}.</p>${plan.automatic?'<p class="field-help">Scan selected '+plan.gpuOptions.map(g=>escape(g.name)+' · '+g.memory+' GB · '+price(g.hourly)).join('; ')+'. '+(queue?'RunPod may place workers on any reviewed GPU type with capacity.':'A compatible GPU is selected from current regional capacity.')+'</p>':''}<p>${plan.storage==='pod'?'50 GB host-local Pod storage':`${plan.storage==='new'?'Create':'Reuse'} network volume: <strong>${escape(plan.volumeName)}</strong> · ${plan.volumeSize} GB · ${escape(plan.dataCenter)}`}</p><p class="field-help">${queue?(plan.workload==='yue2-serverless'?'No GPU starts during setup. The first song prepares missing runtime/models and is billed for initialization and generation. Recordings return in small verified chunks; transfer requests also use workers. Cached models are reused. ':'')+'No persistent service starts during setup. Minimum 0 workers; workers start for paid requests and scale down after 10 idle seconds. Cold starts and initialization are billed. Capacity is not reserved.':cache?'Downloads ~144 GB of MiniMax H3 FL2VA weights without starting a video service. Stop this temporary Pod once the download is ready. You can reuse the volume for serverless.':(plan.includeVideo?'Prepares both models on this volume and starts the song engine only. Video generation uses separate on-demand workers; no video service starts here.':'Starts a dedicated, billed GPU service. Stop compute when finished.')}</p>${queue?'<p class="field-help">Account worker capacity is shared with your other projects. A maximum of '+plan.maxWorkers+' workers can limit their available capacity. Use 1 for a single song, or more for parallel video clips. GPU scanning does not change this limit.</p>':''}<p class="field-help">${plan.workload.startsWith('h3-')&&plan.workload!=='h3-download'?'80':'30'} GB container disk; disk and volume charges are additional. A failed launch can leave a new volume billed. Review <a href="https://www.runpod.io/pricing" target="_blank" rel="noreferrer">RunPod pricing</a>. Quote expires in 10 minutes. This profile has automated contract tests; live GPU validation has not been performed.</p>`;
    $('rp-license-field').hidden=!needsLicense(plan);$('rp-model-license').checked=false;
    $('rp-paid').checked=false;$('rp-launch-review').hidden=false;await refresh();$('rp-launch-review').scrollIntoView({behavior:'smooth',block:'center'});
  },'rp-review-error');});
  $('rp-model-license').addEventListener('change',buttons);$('rp-paid').addEventListener('change',buttons);$('rp-cancel-review').addEventListener('click',invalidate);
  function showLaunchResult(result,notice=launchNotice) {
    launchNotice=notice;
    const box=$('rp-launch-result'),unknown=result.status==='unknown',failed=result.status==='failed',queue=result.workload?.endsWith('-serverless');
    box.hidden=false;
    box.innerHTML=unknown||failed?`<h3 class="error-message">${failed?'Setup was rejected':'Setup could not be confirmed'}</h3><p class="error-message">${escape(result.error||'RunPod did not confirm this setup.')}</p><p>${unknown?'Click Refresh resources to check whether RunPod created it before reviewing another setup. Repeated launches could create duplicate resources.':'Review setup & costs again after correcting the issue. No automatic retry was sent.'}</p><button type="button" class="secondary" data-rp-refresh-result>Refresh resources</button>`:`<h3>${queue?'Serverless setup created':'Pod launch accepted'}</h3><p>${queue?`Endpoint ${escape(result.endpointId)} is configured with 0 idle workers and up to ${result.maxWorkers} workers. No GPU starts during setup.`:`Pod ${escape(result.podId)} was created. It is preparing its runtime and models; check readiness in Your GPU Pods below.`}</p><p>${queue?(result.workload==='yue2-serverless'?'Next: open Create a song, select RunPod, and generate your song. Workers start for that request; missing models are prepared then.':'Next: open New video and choose RunPod. Workers start when you generate a video.'):'Your network volume stays saved when you stop GPU compute.'}</p><div class="song-actions">${queue?`<button type="button" class="primary" data-page="${result.workload==='yue2-serverless'?'create':'videos'}">${result.workload==='yue2-serverless'?'Create a song':'Create a video'} ↗</button>`:''}<button type="button" class="secondary" data-rp-refresh-result>Refresh resources</button></div>${notice?'<p class="error-message">'+escape(notice)+'</p>':''}`;
  }
  $('rp-launch-result').addEventListener('click',event=>{if(event.target.closest('[data-rp-refresh-result]'))work(resources);});
  $('rp-launch').addEventListener('click',()=>work(async()=>{
    if(!plan||!$('rp-paid').checked)return;
    launchNotice='';$('rp-launch').textContent='Applying setup…';
    $('rp-launch-result').hidden=false;$('rp-launch-result').textContent='Applying your reviewed setup. Waiting for RunPod to confirm…';
    try {
      const launched=await api('/api/runpod/manage/deploy','POST',{planId:plan.id,confirmPaid:true,confirmModelLicense:$('rp-model-license').checked});
      pendingId=launched.podId??'';try{sessionStorage.setItem('yue2-runpod-pending',pendingId);}catch{}
      invalidate();showLaunchResult(launched);$('rp-launch-result').focus({preventScroll:true});$('rp-launch-result').scrollIntoView({behavior:'smooth',block:'center'});
      // Inventory failure must not turn an acknowledged launch into a failed launch.
      try{await resources();}catch(e){showLaunchResult(launched,'Setup was accepted, but refreshing resources failed: '+e.message);}
    } catch(e) {
      $('rp-launch-result').hidden=true;
      try{await refresh();}catch{}
      throw e;
    } finally{$('rp-launch').textContent='Apply reviewed setup · paid';}
  },'rp-launch-error'));
  $('rp-show-all').addEventListener('change',()=>{signature='';invalidate();render();});
  $('rp-resource-close').addEventListener('click',()=>{if(!resourcePending)$('rp-resource-dialog').close();});
  $('rp-resource-dialog').addEventListener('cancel',event=>{if(resourcePending)event.preventDefault();});
  $('rp-resource-form').addEventListener('submit',event=>{event.preventDefault();work(async()=>{
    if(!resourceEdit||resourcePending)return;resourcePending=true;$('rp-resource-save').disabled=true;$('rp-resource-close').disabled=true;
    try{await api(`/api/runpod/manage/resources/${resourceEdit.kind}/${resourceEdit.id}`,'PUT',{label:$('rp-resource-label').value,notes:$('rp-resource-notes').value});await refresh();$('rp-resource-dialog').close();toast('Resource linked to this Studio. Label and notes saved locally.');}
    finally{resourcePending=false;$('rp-resource-save').disabled=false;$('rp-resource-close').disabled=false;}
  },'rp-resource-error');});
  document.addEventListener('click',async event=>{
    const edit=event.target.closest('[data-rp-resource]');
    if(edit){if(busy)return;const [kind,id]=edit.dataset.rpResource.split(':');const item=state().inventory?.[kind]?.find(x=>x.id===id);if(!item)return;resourceEdit={kind,id};$('rp-resource-label').value=item.studioLabel??'';$('rp-resource-notes').value=item.studioNotes??'';$('rp-resource-original').textContent=`${item.name} · ${item.id}`;$('rp-resource-heading').textContent=item.studioLinked?'Studio label and notes':'Link to this Studio';$('rp-resource-error').hidden=true;$('rp-resource-dialog').showModal();return;}

    const button=event.target.closest('[data-rp-check],[data-rp-connect],[data-rp-action],[data-rp-endpoint],[data-rp-retry]');if(!button)return;
    if(button.dataset.rpRetry){
      work(async()=>{
        const data=state(),pod=data.inventory?.pods.find(p=>p.id===button.dataset.rpRetry);
        if(!pod||pod.status==='RUNNING')throw new Error('Stop the failed GPU first.');
        const previous=data.plans?.find(p=>p.podId===pod.id),worker=data.managedPods?.find(p=>p.id===pod.id);
        $('rp-workload').value=previous?.includeVideo?'yue2-h3':(worker?.workload??'yue2');
        $('rp-cloud').value=pod.cloud??'SECURE';
        $('rp-storage').value=pod.volumeId?'existing':'pod';
        signature='';invalidate();render();await loadCatalog();
        if(pod.volumeId)$('rp-volume').value=pod.volumeId;
        if(catalog.gpus.some(g=>g.id===pod.gpuName))$('rp-gpu').value=pod.gpuName;
        invalidate();$('rp-plan-form').scrollIntoView({behavior:'smooth',block:'center'});
        $('rp-review').focus({preventScroll:true});
        toast('Previous settings restored. Click Review setup & costs; nothing has been launched.');
      });return;
    }
    if(button.dataset.rpEndpoint){work(async()=>{await api(`/api/runpod/manage/endpoints/${button.dataset.rpEndpoint}/connect`,'POST',{});await refresh();toast('Serverless engine selected.');});return;}
    if(button.dataset.rpAction) {
      if(busy||action)return;
      const pod=state().inventory?.pods.find(p=>p.id===button.dataset.rpId);if(!pod)return;
      action={id:pod.id,action:button.dataset.rpAction};$('rp-action-error').textContent='';$('rp-action-error').hidden=true;
      if(action.action==='start'){try{const quote=await api(`/api/runpod/manage/pods/${pod.id}/quote`,'POST',{});action.maxHourly=quote.hourly;}catch(e){action=null;error(e.message);return;}}
      $('rp-action-heading').textContent=`${action.action==='start'?'Start':action.action==='terminate'?'Permanently terminate':'Stop'} ${pod.name}?`;
      $('rp-action-description').textContent=action.action==='start'?`Starting resumes GPU billing at a quoted GPU list rate of ${price(action.maxHourly)}. Disk and network storage are additional. Models on persistent storage are reused.`:action.action==='terminate'?'Permanently removes this stopped Pod and destroys its container and host-local Pod storage. This cannot be undone. Attached network volumes and models on them remain saved and billed separately. Songs and videos downloaded to this computer remain saved.':'This stops GPU compute. Pod storage and network volumes may still be billed. Downloaded songs and videos stay on this computer.';
      $('rp-action-confirm').textContent=action.action==='start'?'Start GPU · paid':action.action==='terminate'?'Terminate Pod permanently':'Stop GPU';$('rp-action-dialog').showModal();return;
    }
    const id=button.dataset.rpCheck??button.dataset.rpConnect,connect=Boolean(button.dataset.rpConnect);
    work(async()=>{const health=await api(`/api/runpod/manage/pods/${id}/${connect?'connect':'check'}`,'POST',{});await refresh();toast(connect?'RunPod worker connected.':health.error||health.stage);});
  });
  for(const id of ['rp-action-close','rp-action-cancel'])$(id).addEventListener('click',()=>{if(actionPending)return;$('rp-action-dialog').close();action=null;});
  $('rp-action-dialog').addEventListener('close',()=>{action=null;});
  $('rp-action-dialog').addEventListener('cancel',event=>{if(actionPending)event.preventDefault();});
  $('rp-action-confirm').addEventListener('click',()=>work(async()=>{
    if(!action||actionPending)return;
    const requested={...action},button=$('rp-action-confirm'),label=button.textContent;
    actionPending=true;
    for(const id of ['rp-action-confirm','rp-action-close','rp-action-cancel'])$(id).disabled=true;
    button.textContent=requested.action==='stop'?'Stopping GPU…':requested.action==='terminate'?'Terminating Pod…':'Starting GPU…';
    try{
      await api(`/api/runpod/manage/pods/${requested.id}/action`,'POST',{action:requested.action,maxHourly:requested.maxHourly,confirm:true});
      $('rp-action-dialog').close();action=null;
      if(pendingId===requested.id&&requested.action!=='start'){pendingId='';try{sessionStorage.removeItem('yue2-runpod-pending');}catch{}}
      // A refresh failure must not imply that a successful action failed.
      try{await resources();toast(requested.action==='stop'?'Stop request accepted. Updated Pod status shown below.':requested.action==='terminate'?'Pod terminated. Network volumes remain saved.':'Start request accepted.');}
      catch{toast('RunPod accepted the action. Refresh resources to check the latest status.');}
    }finally{
      actionPending=false;button.textContent=label;
      for(const id of ['rp-action-confirm','rp-action-close','rp-action-cancel'])$(id).disabled=false;
    }
  },'rp-action-error'));
  // Check a user-approved launch without submitting inference or another rental.
  setInterval(async()=>{
    if(!pendingId||checking||busy||action||!state().configured)return;checking=true;
    try {const health=await api(`/api/runpod/manage/pods/${pendingId}/check`,'POST',{});await refresh();
      if(health.ready){if(health.workload!=='h3-download')await api(`/api/runpod/manage/pods/${pendingId}/connect`,'POST',{});pendingId='';try{sessionStorage.removeItem('yue2-runpod-pending');}catch{}await resources();toast(health.workload==='h3-download'?'MiniMax model saved. Stop the download Pod, then configure serverless using this volume.':'Your RunPod engine is ready and connected.');}
    }catch(e){error(e.message);}finally{checking=false;}
  },10000);
  return {open,render};
}
