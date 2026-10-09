const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const videoProject=(job,songs)=>job.projectId??songs.find(song=>song.id===job.songId)?.projectId??'';
export function filterVideoLibrary(jobs,songs,{search='',project='all',status='all'}={}){
  const query=search.trim().toLowerCase();
  return jobs.filter(job=>{
    const song=songs.find(song=>song.id===job.songId);
    return (project==='all'||videoProject(job,songs)===project)
      &&(status==='all'||(status==='completed'?job.hasVideo:status==='active'?['queued','running'].includes(job.status):['failed','interrupted','cancelled'].includes(job.status)))
      &&(!query||[job.title,job.prompt,song?.title].join(' ').toLowerCase().includes(query));
  });
}
export function renderVideoJobs(container,jobs,models,{gallery=false,projects=[]}={}){
  if(!jobs.length){
    if(container.dataset.empty!=='true'){container.innerHTML='<div class="video-empty"><div class="video-orbit" aria-hidden="true"><span>▶</span></div><h3>A world for your sound.</h3><p>Choose a song, describe the scenes, and create a music video.</p></div>';container.dataset.empty='true';if(gallery)container.innerHTML='<div class="video-empty"><h3>No videos in this view.</h3><p>Try a different filter, or choose New video to create one from a song.</p></div>';}
    return;
  }
  if(container.dataset.empty==='true'){container.replaceChildren();delete container.dataset.empty;}
  const ids=new Set(jobs.map(job=>job.id));
  for(const card of [...container.children])if(!ids.has(card.dataset.videoJob))card.remove();
  jobs.forEach((job,index)=>{
    let card=[...container.children].find(node=>node.dataset.videoJob===job.id);
    if(!card){card=container.ownerDocument.createElement('article');card.className=gallery?'video-job video-library-card':'video-job';card.dataset.videoJob=job.id;card.innerHTML='<span data-job-stage></span><h3 data-job-title></h3><p class="field-help" data-job-summary></p><div data-job-media></div><p class="error-message" data-job-error hidden></p><div data-job-actions></div><div data-job-project></div>';}
    if(container.children[index]!==card)container.insertBefore(card,container.children[index]??null);
    const stage=card.querySelector('[data-job-stage]');stage.className=`status-badge ${job.status}`;const stageText=job.deletedAt?'In Trash':job.stage;if(stage.textContent!==stageText)stage.textContent=stageText;
    card.querySelector('[data-job-title]').textContent=job.title;
    card.querySelector('[data-job-summary]').textContent=`${models.find(model=>model.id===job.model)?.name??job.model} · ${job.scope==='full'?'Full song':'Preview'} · ${job.count} scene${job.count===1?'':'s'}${job.elapsedSeconds!=null?' · Elapsed '+Math.floor(job.elapsedSeconds/60)+'m '+job.elapsedSeconds%60+'s':''}${job.provider==='fal'?' · '+(job.billing?.matchedRequests?('USD '+job.billing.actualCost.toFixed(2)+(job.billing.complete?' actual':' partial')+' ('+job.billing.matchedRequests+'/'+job.billing.totalRequests+' requests)'):'Cost not synced'):''}${gallery?' · '+(job.projectName??'Unassigned')+' · '+new Date(job.createdAt).toLocaleDateString():''}`;
    const media=card.querySelector('[data-job-media]'),source=job.hasVideo?`/api/videos/${job.id}/video`:'';
    // Keep media elements alive across polling updates, including other jobs.
    if(media.dataset.source!==source){media.dataset.source=source;media.innerHTML=source?`<video controls preload="metadata" aria-label="${escape(job.title)} music video" ${gallery?`poster="/api/videos/${job.id}/thumbnail"`:""} src="${source}"></video><a class="secondary" href="${source}?download">Download MP4 ↓</a>`:'';}
    const error=card.querySelector('[data-job-error]');error.hidden=!job.error;error.textContent=job.error??'';
    const actions=card.querySelector('[data-job-actions]');let markup=['queued','running'].includes(job.status)?`<button type="button" class="secondary" data-video-cancel="${job.id}">Cancel video</button>`:['failed','interrupted'].includes(job.status)&&!(job.clips??[]).some(clip=>clip?.submissionUnknown)?`<button type="button" class="secondary" data-video-resume="${job.id}">Resume saved scenes ↗</button>`:'';
    if(gallery){if(job.deletedAt)markup=`<button type="button" class="secondary" data-video-restore="${job.id}">Restore video ↗</button>`;else {markup+=`<button type="button" class="secondary" data-video-song="${job.songId}">Create another video ↗</button>`;if(!['queued','running'].includes(job.status))markup+=`<button type="button" class="text-button video-delete-button" data-video-delete="${job.id}">Delete video</button>`;}if(!job.hasVideo&&media.dataset.placeholder!=='true'){media.dataset.placeholder='true';media.innerHTML='<div class="video-pending-thumbnail" aria-hidden="true">▷</div>';}}
    if(actions.dataset.markup!==markup){actions.dataset.markup=markup;actions.innerHTML=markup;}
    if(gallery&&!job.deletedAt){
      const target=card.querySelector('[data-job-project]'),current=job.projectId??'follow';
      const choices=`<label for="video-project-${job.id}">Project</label><select id="video-project-${job.id}" data-video-project="${job.id}" aria-label="Project for ${escape(job.title)}"><option value="follow" ${current==='follow'?'selected':''}>Follow source song · ${escape(job.sourceProjectName??'Unassigned')}</option><option value="" ${current===''?'selected':''}>Unassigned</option>${projects.map(p=>`<option value="${p.id}" ${current===p.id?'selected':''}>${escape(p.name)}</option>`).join('')}</select><p class="field-help">Saves automatically. Changes only this video. <button class="text-button" type="button" data-page="projects">Manage projects ↗</button></p>`;
      if(target.dataset.markup!==choices){target.dataset.markup=choices;target.innerHTML=choices;}
    }

  });
}
export function setupVideos({ getStudio, api, refresh, toast, showPage }) {
  const $=id=>document.getElementById(id);let initialized=false,songSignature='',masterSignature='',jobSignature='',planned=null,savingTimer,busy=false;
  let balanceLoading=false,balanceRequested=false,balanceError='',costSyncLoading=false;
  function renderBalance(){
    const configured=state()?.connection.billingConfigured,account=state()?.accountBilling;
    for(const id of ['video-settings-balance','video-library-balance']){
      const panel=$(id);panel.hidden=!configured;
      panel.querySelector('[data-fal-balance-value]').textContent=account?new Intl.NumberFormat(undefined,{style:'currency',currency:account.currency}).format(account.balance):balanceLoading?'Checking…':'Not checked yet';
      panel.querySelector('[data-fal-balance-time]').textContent=account?`Last checked ${new Date(account.checkedAt).toLocaleString()}`:'';
      panel.querySelector('[data-fal-balance-refresh]').disabled=balanceLoading;
      panel.querySelector('[data-fal-balance-error]').textContent=balanceError;
    }
    $('video-sync-costs').disabled=costSyncLoading||!configured;
    $('video-sync-costs').title=configured?'Read actual video costs using your billing key':'Add an admin-scope billing key in Engine settings to sync costs';
  }
  async function refreshBalance(){
    if(balanceLoading||!state()?.connection.billingConfigured)return;
    balanceLoading=true;balanceError='';renderBalance();
    try{await api('/api/videos/billing/balance','POST',{});await refresh();}
    catch(error){balanceError=error.message;}
    finally{balanceLoading=false;renderBalance();}
  }
  for(const button of document.querySelectorAll('[data-fal-balance-refresh]'))button.addEventListener('click',refreshBalance);
  let libraryProjectSignature='';
  const state=()=>getStudio()?.videos;let selectedImages=[],imageSignature='';
  const provider=()=>document.querySelector('input[name="video-provider"]:checked').value;
  function draft(){return {provider:provider(),model:$('video-model').value,songId:$('video-song').value,masterId:$('video-master').value,scope:$('video-scope').value,clipSeconds:Number($('video-clip-length').value),resolution:$('video-resolution').value,ratio:$('video-ratio').value,seed:Number($('video-seed').value),prompt:$('video-prompt').value,scenes:$('video-scenes').value,referenceIds:selectedImages};}
  function renderImages(){
    const model=state().models.find(m=>m.id===$('video-model').value),images=state().images??[];
    $('video-reference-help').textContent=model?.imageMode==='references'?'Supports up to nine subject references. Selected labels are mapped to Image 1, Image 2, and so on in every scene. Mention Rusty or Beauty to direct their actions.':model?.imageMode==='first-frame'?'Choose exactly one photo. It becomes the opening frame of every scene. The model follows its shape; the final export fits your chosen frame shape.':'This model is text-only. Your images remain saved but cannot be selected. Choose MiniMax H3 · multiple image references to use Rusty and Beauty together.';
    const signature=JSON.stringify([images,selectedImages,model?.id]);if(signature===imageSignature)return;imageSignature=signature;
    $('video-reference-library').innerHTML=images.length?images.map(image=>`<article class="video-reference-card"><img src="/api/videos/images/${image.id}" alt="${escape(image.label)} reference"><label><input type="checkbox" data-reference-id="${image.id}" ${selectedImages.includes(image.id)?'checked':''} ${!model?.imageMode?'disabled':''}>${escape(image.label)}</label><input type="text" aria-label="Rename ${escape(image.label)}" data-reference-label="${image.id}" maxlength="80" value="${escape(image.label)}"><button type="button" class="text-button" data-reference-rename="${image.id}">Save label</button><button type="button" class="text-button" data-reference-archive="${image.id}">Archive</button></article>`).join(''):'<p class="field-help">No images saved yet.</p>';
  }
  function fillSelect(id,values,preferred){const element=$(id),current=preferred??element.value;element.replaceChildren(...values.map(item=>new Option(item.label??item.value,item.value)));if(values.some(item=>item.value===current))element.value=current;}
  function modelOptions(preferred){
    const models=state().models.filter(m=>m.provider===provider());fillSelect('video-model',models.map(m=>({value:m.id,label:m.name})),preferred);
    const model=state().models.find(m=>m.id===$('video-model').value);
    if(!model.imageMode)selectedImages=[];renderImages();
    fillSelect('video-clip-length',model.durations.map(value=>({value:String(value),label:`${value} seconds`})),String($('video-clip-length').value||10));
    fillSelect('video-resolution',model.resolutions.map(value=>({value})));$('video-resolution-field').hidden=!model.resolutions.length;
    fillSelect('video-ratio',model.ratios.map(value=>({value,label:value==='16:9'?'Landscape · 16:9':value==='9:16'?'Portrait · 9:16':'Square · 1:1'})));
    $('video-provider-note').textContent=provider()==='fal'?'Generate on fal.ai. Visual descriptions are sent to the selected model; your soundtrack is added locally.':'Generate with MiniMax H3 Base on your RunPod video service. This is a separate connection from the YuE2 song worker.';
  }
  function masterOptions(preferred){
    const jobs=getStudio().mastering.jobs.filter(j=>j.songId===$('video-song').value&&j.hasAudio),signature=JSON.stringify([$('video-song').value,jobs.map(j=>j.id)]);
    if(signature===masterSignature&&preferred===undefined)return;masterSignature=signature;
    fillSelect('video-master',[{value:'',label:'Original recording'},...jobs.map(j=>({value:j.id,label:`${j.preset[0].toUpperCase()+j.preset.slice(1)} master`}))],preferred);
  }
  function connectionStatus(){
    if(!state())return;const connection=state().connection;
    $('fal-billing-status').textContent=connection.billingConfigured?'✓ Admin key saved':'Optional · no admin key';
    $('video-billing-key').placeholder=connection.billingConfigured?'Admin key saved · enter a new key to replace it':'Paste your admin-scope fal.ai key';
    $('fal-key-status').textContent=connection.falConfigured?'✓ Key saved':'No key saved';$('fal-key-status').className=`status-badge ${connection.falConfigured?'':'failed'}`;
    $('video-fal-key').placeholder=connection.falConfigured?'Generation key saved · enter a new key to replace it':'Paste your regular fal.ai API key';
    renderBalance();
    if(!connection.billingConfigured){balanceRequested=false;balanceError='';}
    else if(!balanceRequested){balanceRequested=true;void refreshBalance();}
    $('video-pod-status').textContent=connection.podConfigured?'RunPod video connection saved.':'No RunPod video service connected.';
    const connected=provider()==='fal'?connection.falConfigured:connection.podConfigured;
    $('video-connection-note').hidden=connected;
    $('video-generate').disabled=busy||!planned||planned.signature!==JSON.stringify(draft())||!connected||state().jobs.some(job=>['queued','running'].includes(job.status));
    $('video-plan-button').disabled=busy||!$('video-song').value;
  }
  function invalidate(){planned=null;$('video-plan').hidden=true;connectionStatus();clearTimeout(savingTimer);savingTimer=setTimeout(()=>api('/api/videos/draft','PUT',draft()).catch(()=>{}),700);}
  function renderLibrary(){
    if(!state())return;
    const studio=getStudio(),projects=studio.projects??[],signature=JSON.stringify(projects.map(p=>[p.id,p.name]));
    if(signature!==libraryProjectSignature){libraryProjectSignature=signature;const value=$('video-library-project').value;fillSelect('video-library-project',[{value:'all',label:'All projects'},{value:'',label:'Unassigned'},...projects.map(p=>({value:p.id,label:p.name}))],value);}
    const inTrash=$('video-library-status').value==='trash';
    const jobs=filterVideoLibrary(inTrash?(state().trash??[]):state().jobs,studio.songs,{search:$('video-library-search').value,project:$('video-library-project').value,status:inTrash?'all':$('video-library-status').value});
    $('video-library-count').textContent=`${jobs.length} video${jobs.length===1?'':'s'}${inTrash?' in Trash':''}`;
    renderVideoJobs($('video-library-grid'),jobs.map(job=>({...job,projectName:projects.find(p=>p.id===videoProject(job,studio.songs))?.name??'Unassigned',sourceProjectName:projects.find(p=>p.id===studio.songs.find(s=>s.id===job.songId)?.projectId)?.name??'Unassigned'})),state().models,{gallery:true,projects});
  }
  let deletingVideoId=null;
  for(const id of ['close-delete-video','cancel-delete-video'])$(id).addEventListener('click',()=>$('delete-video-dialog').close());
  $('delete-video-dialog').addEventListener('close',()=>{deletingVideoId=null;});
  $('confirm-delete-video').addEventListener('click',async()=>{
    if(!deletingVideoId)return;const button=$('confirm-delete-video');button.disabled=true;$('delete-video-error').hidden=true;
    try{await api(`/api/videos/${deletingVideoId}/trash`,'POST',{});$('delete-video-dialog').close();await refresh();toast('Video moved to Trash. Linked assets stay saved.');}
    catch(error){$('delete-video-error').textContent=error.message;$('delete-video-error').hidden=false;}finally{button.disabled=false;}
  });
  $('video-sync-costs').addEventListener('click',async()=>{const button=$('video-sync-costs');costSyncLoading=true;button.disabled=true;$('video-billing-result').textContent='Reading fal.ai billing events…';try{const result=await api('/api/videos/billing/sync','POST',{});await refresh();await refreshBalance();$('video-billing-result').textContent=`Saved billing results for ${result.synced} video${result.synced===1?'':'s'}.`;}catch(error){$('video-billing-result').textContent=error.message;}finally{costSyncLoading=false;renderBalance();}});
  $('video-billing-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{if(!$('video-billing-key').value.trim())throw new Error('Enter an admin-scope billing key first.');await api('/api/videos/connection','PUT',{falBillingKey:$('video-billing-key').value});$('video-billing-key').value='';balanceRequested=true;await refresh();await refreshBalance();toast('Admin key saved for balance and video costs.');}catch(error){toast(error.message);}finally{button.disabled=false;}});
  $('new-video').addEventListener('click',()=>{showPage('videos');render();});
  $('video-library-search').addEventListener('input',renderLibrary);
  for(const id of ['video-library-project','video-library-status'])$(id).addEventListener('change',renderLibrary);
  function render(){
    if(!state())return;
    renderLibrary();
    const songs=getStudio().songs.filter(s=>s.hasAudio),signature=JSON.stringify(songs.map(s=>[s.id,s.title]));
    if(songSignature!==signature){songSignature=signature;fillSelect('video-song',songs.length?songs.map(s=>({value:s.id,label:`${s.title} · ${new Date(s.createdAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`})):[{value:'',label:'Create a song first'}]);}
    if(!initialized){
      initialized=true;const value=state().draft??{};document.querySelector(`input[name="video-provider"][value="${value.provider==='runpod'?'runpod':'fal'}"]`).checked=true;
      modelOptions(value.model);selectedImages=(value.referenceIds??[]).filter(id=>state().images?.some(i=>i.id===id));if(!state().models.find(m=>m.id===$('video-model').value)?.imageMode)selectedImages=[];for(const [key,id] of Object.entries({songId:'video-song',scope:'video-scope',clipSeconds:'video-clip-length',resolution:'video-resolution',ratio:'video-ratio',seed:'video-seed',prompt:'video-prompt',scenes:'video-scenes'}))if(value[key]!==undefined){if($(id).tagName!=='SELECT'||[...$(id).options].some(o=>o.value===String(value[key])))$(id).value=value[key];}
      masterOptions(value.masterId);$('video-pod-url').value=state().connection.podURL??'';
    }
    masterOptions();renderImages();connectionStatus();
    const jobs=state().jobs,next=JSON.stringify(jobs);if(next===jobSignature)return;jobSignature=next;
    renderVideoJobs($('video-jobs'),jobs,state().models);
  }
  $('video-form').addEventListener('input',event=>{if(!event.target.closest('.video-reference-panel'))invalidate();});
  $('video-reference-library').addEventListener('change',event=>{if(event.target.dataset.referenceId){const id=event.target.dataset.referenceId;selectedImages=event.target.checked?[...selectedImages,id]:selectedImages.filter(value=>value!==id);invalidate();renderImages();}});
  $('video-image-upload').addEventListener('click',async()=>{
    const file=$('video-image-file').files[0],label=$('video-image-label').value.trim();$('video-image-error').hidden=true;
    if(!file||!label){$('video-image-error').textContent='Choose an image and give it a label.';$('video-image-error').hidden=false;return;}
    if(file.size>5*1024*1024){$('video-image-error').textContent='Choose an image smaller than 5 MB.';$('video-image-error').hidden=false;return;}
    $('video-image-upload').disabled=true;
    try{const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});await api('/api/videos/images','POST',{label,data});$('video-image-file').value='';$('video-image-label').value='';await refresh();toast('Labeled image saved on this computer.');}
    catch(error){$('video-image-error').textContent=error.message;$('video-image-error').hidden=false;}finally{$('video-image-upload').disabled=false;}
  });
  $('video-form').addEventListener('change',event=>{
    if(event.target.name==='video-provider'||event.target.id==='video-model')modelOptions(event.target.id==='video-model'?event.target.value:undefined);
    if(event.target.id==='video-song'){masterSignature='';masterOptions('');}
    invalidate();
  });
  $('video-plan-button').addEventListener('click',async()=>{
    $('video-error').hidden=true;busy=true;connectionStatus();const value=draft(),signature=JSON.stringify(value);
    try{
      const plan=await api('/api/videos/plan','POST',value);if(signature!==JSON.stringify(draft()))return;planned={...plan,signature};
      const price=plan.pricing?.prices?.find(p=>p.endpoint_id===plan.model);
      const seconds=Math.ceil(plan.seconds);
      $('video-plan-summary').textContent=`${plan.count} generated scene${plan.count===1?'':'s'} × ${plan.clipSeconds} seconds · final video ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} · ${plan.ratio}${plan.references?.length?' · References: '+plan.references.map(i=>i.label).join(', '):''}`;
      $('video-price').textContent=provider()==='fal'?(price?`${price.currency} ${price.unit_price} per ${price.unit} (base rate). Total depends on duration and resolution. ${plan.count*plan.clipSeconds} seconds will be generated.`:plan.pricingError??'Save a fal.ai key to retrieve the model’s current billing rate. Check pricing before generating.'):'RunPod GPU billing applies while your pod runs. Stop the pod when finished.';
      $('video-plan').hidden=false;
    }catch(error){$('video-error').textContent=error.message;$('video-error').hidden=false;}
    finally{busy=false;connectionStatus();}
  });
  $('video-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!planned||planned.signature!==JSON.stringify(draft()))return;busy=true;connectionStatus();$('video-error').hidden=true;
    try{await api('/api/videos','POST',draft());toast('Video queued. Scenes will be generated and joined with your song.');await refresh();}
    catch(error){$('video-error').textContent=error.message;$('video-error').hidden=false;}
    finally{busy=false;connectionStatus();}
  });
  document.addEventListener('change',async event=>{
    const id=event.target.dataset.videoProject;if(!id)return;const select=event.target,value=select.value;select.disabled=true;
    try{await api(`/api/videos/${id}/project`,'PATCH',{projectId:value==='follow'?null:value});await refresh();toast('Video project saved.');}
    catch(error){select.value=state().jobs.find(j=>j.id===id)?.projectId??'follow';toast(error.message);}finally{select.disabled=false;}
  });
  document.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button)return;
    try{
      if(button.dataset.videoDelete){
        const job=state().jobs.find(j=>j.id===button.dataset.videoDelete);if(!job)return;deletingVideoId=job.id;
        $('delete-video-title').textContent=job.title;
        const song=getStudio().songs.find(s=>s.id===job.songId);$('delete-video-linked-song').textContent=`Linked song: ${song?.title??job.title}. This song will be kept.`;
        $('delete-video-error').hidden=true;$('delete-video-dialog').showModal();
      }
      if(button.dataset.videoRestore){await api(`/api/videos/${button.dataset.videoRestore}/restore`,'POST',{});await refresh();toast('Video restored to your library.');}
      if(button.dataset.referenceRename){const id=button.dataset.referenceRename,label=document.querySelector(`[data-reference-label="${id}"]`).value;await api(`/api/videos/images/${id}`,'PATCH',{label});invalidate();await refresh();}
      if(button.dataset.referenceArchive){const id=button.dataset.referenceArchive;await api(`/api/videos/images/${id}`,'DELETE',{});selectedImages=selectedImages.filter(value=>value!==id);invalidate();await refresh();}
      if(button.dataset.videoSong){if($('song-dialog').open)$('song-dialog').close();showPage('videos');render();$('video-song').value=button.dataset.videoSong;masterSignature='';masterOptions('');invalidate();}
      if(button.dataset.videoCancel){await api(`/api/videos/${button.dataset.videoCancel}/cancel`,'POST',{});toast('Cancelled. An already running provider request may still be billed.');await refresh();}
      if(button.dataset.videoResume){await api(`/api/videos/${button.dataset.videoResume}/resume`,'POST',{});await refresh();}
    }catch(error){toast(error.message);}
  });
  for(const [id,kind] of [['video-fal-form','fal'],['video-pod-form','runpod']])$(id).addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true;$('video-settings-error').hidden=true;
    try{await api('/api/videos/connection','PUT',kind==='fal'?{falKey:$('video-fal-key').value}:{podURL:$('video-pod-url').value,podToken:$('video-pod-token').value});$('video-fal-key').value='';$('video-pod-token').value='';await refresh();toast('Video connection saved');}
    catch(error){$('video-settings-error').textContent=error.message;$('video-settings-error').hidden=false;}
    finally{button.disabled=false;}
  });
  $('video-pod-check').addEventListener('click',async()=>{try{await api('/api/videos/check-pod','POST',{});toast('RunPod video service is reachable');}catch(error){toast(error.message);}});
  for(const kind of ['fal','runpod','billing'])$(`video-disconnect-${kind}`).addEventListener('click',async()=>{try{await api('/api/videos/connection','DELETE',{provider:kind});await refresh();toast('Video provider disconnected');}catch(error){toast(error.message);}});
  return {render};
}
