import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { VIDEO_MODELS, createVideoProviders, validateVideoPodURL } from './video-providers.mjs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const atomic=(file,value)=>{writeFileSync(file+'.tmp',JSON.stringify(value,null,2),{mode:0o600});renameSync(file+'.tmp',file);};
const read=(file,fallback)=>existsSync(file)?JSON.parse(readFileSync(file,'utf8')):fallback;
const string=(value,name,max)=>{if(typeof value!=='string'||value.length>max||value.includes('\0'))fail(`${name} must be text up to ${max} characters.`);return value.trim();};
function processAudio(executable,args,signal,cwd){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd,windowsHide:true,stdio:['ignore','ignore','pipe']});let log='';
    const stop=()=>child.kill();signal?.addEventListener('abort',stop,{once:true});
    const timer=setTimeout(stop,600000);
    child.stderr.on('data',chunk=>log=(log+chunk.toString()).slice(-32000));
    child.on('error',()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(new Error('Could not start the local video assembler. Install app dependencies.'));});
    child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);if(signal?.aborted)return reject(signal.reason);resolve({code,log});});
    if(signal?.aborted)stop();
  });
}
export async function audioDuration(executable,file){
  const {log}=await processAudio(executable,['-hide_banner','-i',file]);
  const match=/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  if(!match)throw new Error('Could not measure the selected recording.');
  const seconds=Number(match[1])*3600+Number(match[2])*60+Number(match[3]);
  if(!Number.isFinite(seconds)||seconds<1||seconds>600)fail('Choose a recording between 1 second and 10 minutes.');return seconds;
}
export async function assembleVideo(executable,dir,job,source,signal){
  const short=job.resolution==='4K'||job.resolution==='2160p'?2160:job.resolution==='2K'||job.resolution==='1440p'?1440:/1080/i.test(job.resolution)?1080:/768/i.test(job.resolution)?768:/480/i.test(job.resolution)?480:720;
  const [a,b]=job.ratio.split(':').map(Number),width=Math.round((a>=b?short*a/b:short)/2)*2,height=Math.round((a>=b?short:short*b/a)/2)*2;
  const normalized=[];
  for(let index=0;index<job.count;index++){
    signal.throwIfAborted();const output=path.join(dir,`scene-${index}-normalized.mp4`);
    const result=await processAudio(executable,['-hide_banner','-nostdin','-y','-i',path.join(dir,`scene-${index}.mp4`),'-an','-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=${job.clipSeconds}`,'-t',String(job.clipSeconds),'-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-threads','2',output],signal);
    if(result.code!==0)throw new Error('A generated scene could not be assembled. The original song and downloaded scenes are saved.');
    normalized.push(`file 'scene-${index}-normalized.mp4'`);
  }
  writeFileSync(path.join(dir,'scenes.txt'),normalized.join('\n'));
  const temporary=path.join(dir,'video.partial.mp4');
  try{
    const result=await processAudio(executable,['-hide_banner','-nostdin','-y','-f','concat','-safe','1','-i','scenes.txt','-i',source,'-map','0:v:0','-map','1:a:0','-t',String(job.seconds),'-c:v','copy','-c:a','aac','-b:a','320k','-movflags','+faststart',temporary],signal,dir);
    writeFileSync(path.join(dir,'assembly.txt'),result.log);
    if(result.code!==0||!existsSync(temporary)||statSync(temporary).size<24)throw new Error('Video export failed. Your original recording and generated scenes are saved.');
    renameSync(temporary,path.join(dir,'video.mp4'));
  }finally{if(existsSync(temporary))unlinkSync(temporary);for(const file of normalized.map((_,i)=>path.join(dir,`scene-${i}-normalized.mp4`)))if(existsSync(file))unlinkSync(file);}
}
export function createVideos({onRunpodActivity=()=>{},data,executable,getSource,validProject=value=>value??'',providers=createVideoProviders(),getRunpodAccountKey=()=>''}){
  const dir=path.join(data,'videos');mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'workspace.json'),keyFile=path.join(dir,'connection.json');
  const db=read(file,{draft:{provider:'fal',model:VIDEO_MODELS[0].id,scope:'preview',clipSeconds:10,resolution:'768P',ratio:'16:9',seed:1234,prompt:'',scenes:'',songId:'',masterId:''},jobs:[]});
  db.images??=[];const imagesDir=path.join(dir,'images');mkdirSync(imagesDir,{recursive:true});
  let config=read(keyFile,{falKey:'',podURL:'',podToken:''}),active=null,closing=false;
  for(const job of db.jobs)if(['running','queued'].includes(job.status)){job.status='interrupted';job.stage='Interrupted';job.error='The app stopped. Resume to keep completed scenes and continue existing provider requests.';}
  config.runpodMode??=config.podURL?'pod':'serverless';
  const concurrent=new Map();
  const save=()=>atomic(file,db);save();
  const jobDir=id=>path.join(dir,id);
  const thumbnails=new Map();
  const view=job=>({...job,elapsedSeconds:job.startedAt?Math.max(0,Math.round(((job.finishedAt?new Date(job.finishedAt).getTime():Date.now())-new Date(job.startedAt).getTime())/1000)):null,hasVideo:job.status==='completed'&&existsSync(path.join(jobDir(job.id),'video.mp4'))});
  const state=()=>({models:VIDEO_MODELS,images:db.images.filter(i=>!i.archived),draft:db.draft,jobs:db.jobs.filter(j=>!j.deletedAt).map(view).reverse(),trash:db.jobs.filter(j=>j.deletedAt).map(view).reverse(),accountBilling:config.falBillingKey?db.accountBilling??null:null,connection:{falConfigured:Boolean(config.falKey),billingConfigured:Boolean(config.falBillingKey),podConfigured:config.runpodMode==='serverless'?Boolean(config.endpointId&&getRunpodAccountKey()):Boolean(config.podURL&&config.podToken),runpodMode:config.runpodMode,endpointId:config.endpointId??'',podURL:config.podURL}});
  async function plan(input){
    if(!input||typeof input!=='object')fail('Choose a song and describe your video.');
    const model=VIDEO_MODELS.find(m=>m.id===input.model&&m.provider===input.provider);if(!model)fail('Choose a supported video model.');
    const scope=input.scope??'preview';if(!['preview','full'].includes(scope))fail('Choose a preview or full-song video.');
    if(!model.durations.includes(input.clipSeconds))fail('Choose a supported scene length.');
    if(!model.ratios.includes(input.ratio))fail('Choose a supported aspect ratio.');
    if(model.resolutions.length&&!model.resolutions.includes(input.resolution))fail('Choose a supported resolution.');
    if(model.id.startsWith('lightricks/')&&['1440p','2160p'].includes(input.resolution)&&input.clipSeconds>10)fail('LTX supports scenes up to 10 seconds at this resolution.');
    if(!Number.isInteger(input.seed)||input.seed<0||input.seed>2147483647)fail('Seed must be a whole number from 0 to 2147483647.');
    const prompt=string(input.prompt,'Visual direction',2000);if(!prompt)fail('Describe the visuals you want.');
    const ids=input.referenceIds??[];
    if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length||ids.length>9)fail('Choose up to nine different references.');
    if(ids.length&&!model.imageMode)fail('This model is text-only. Deselect images or choose an image-capable model.');
    if(model.imageMode&&(!ids.length||ids.length>model.maxImages))fail(`Choose ${model.maxImages===1?'one opening-frame image':'one to nine reference images'}.`);
    const references=ids.map(id=>{const image=db.images.find(i=>i.id===id&&!i.archived);if(!image)fail('A selected reference is no longer available.');return {...image};});
    const scenes=string(input.scenes??'','Storyboard',16000).split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean);
    if(scenes.some(s=>s.length>2000))fail('Each storyboard scene must be under 2,000 characters.');
    const source=getSource(input.songId,input.masterId??'');
    if(!existsSync(executable))fail('The local video assembler is missing. Run npm ci in the app folder.',503);
    const duration=await audioDuration(executable,source.file),seconds=scope==='full'?duration:Math.min(duration,input.clipSeconds),count=Math.ceil(seconds/input.clipSeconds);
    const binding=references.length?'\n\n'+references.map((image,index)=>model.imageMode==='references'?`Image ${index+1} is ${JSON.stringify(image.label)}. Use this image for that named subject whenever mentioned.`:`The opening image shows ${JSON.stringify(image.label)}. Preserve that subject’s appearance.`).join('\n'):'';
    const prompts=Array.from({length:count},(_,index)=>`${prompt}${scenes.length?'\n\n'+scenes[index%scenes.length]:''}${binding}`);
    if(prompts.some(p=>p.length>(model.maxPrompt??5000)))fail('Shorten the visual direction or storyboard scene for this model.');
    return {provider:input.provider,model:model.id,scope,songId:input.songId,masterId:input.masterId??'',title:source.title,prompt,scenes:scenes.join('\n\n'),clipSeconds:input.clipSeconds,resolution:model.resolutions.length?input.resolution:'',ratio:input.ratio,seed:input.seed,seconds,count,prompts,references};
  }
  function next(){
    if(closing||active)return;const candidates=db.jobs.filter(j=>j.status==='queued');const job=concurrent.size?candidates.find(j=>j.provider==='runpod'&&(j.runpodMode??config.runpodMode)==='serverless'):candidates[0];if(!job||concurrent.size>=2)return;
    const controller=new AbortController(),sessionConfig={...config,serverlessKey:getRunpodAccountKey()};const parallel=job.provider==='runpod'&&sessionConfig.runpodMode==='serverless';job.status='running';job.startedAt??=new Date().toISOString();save();
    const running=(async()=>{
      try{
        const source=getSource(job.songId,job.masterId),model=VIDEO_MODELS.find(m=>m.id===job.model),folder=jobDir(job.id);
        async function processScene(index){
          controller.signal.throwIfAborted();job.stage=`Scene ${index+1} of ${job.count}`;save();
          const clip=path.join(folder,`scene-${index}.mp4`);if(job.clips[index]?.completed&&existsSync(clip))return;
          job.clips[index]??={};const scene=job.clips[index];
          if(!scene.remote){
            if(scene.submissionUnknown)throw new Error('A scene submission had no acknowledgement. Check the provider request history before creating another video; it may already be billed.');
            const imageInputs=(job.references??[]).map(image=>`data:${image.mime};base64,${readFileSync(path.join(imagesDir,image.id+'.'+image.extension)).toString('base64')}`);
            scene.submittedAt??=new Date().toISOString();scene.submissionUnknown=true;save();
            if(job.provider==='runpod')onRunpodActivity(sessionConfig);
            scene.remote=await providers.submit(sessionConfig,model,{...job,imageInputs},job.prompts[index],index,controller.signal);scene.submissionUnknown=false;save();
          }
          await providers.waitAndDownload(sessionConfig,job.provider,scene.remote,clip,{signal:controller.signal,onStatus:status=>{job.stage=`Scene ${index+1} of ${job.count} · ${status==='IN_QUEUE'||status==='queued'?'queued':'generating'}`;save();}});
          scene.completed=true;scene.finishedAt=new Date().toISOString();save();
        }
        if(parallel){let cursor=0,failed=false;const lane=async()=>{while(cursor<job.count&&!failed){const index=cursor++;try{await processScene(index);}catch(error){failed=true;throw error;}}};const outcomes=await Promise.allSettled(Array.from({length:Math.min(5,job.count)},lane));const failure=outcomes.find(r=>r.status==='rejected');if(failure)throw failure.reason;}else for(let index=0;index<job.count;index++)await processScene(index);
        job.stage='Joining scenes with your soundtrack';save();
        await assembleVideo(executable,folder,job,source.file,controller.signal);
        job.status='completed';job.stage='Ready to watch';delete job.error;
      }catch(error){if(job.status!=='cancelled'){job.status=closing?'interrupted':'failed';job.stage=closing?'Interrupted':'Needs attention';job.error=error.message;}}
      finally{job.finishedAt=new Date().toISOString();save();if(parallel)concurrent.delete(job.id);else active=null;setImmediate(next);}
    })();const task={job,controller,running,config:sessionConfig};if(parallel){concurrent.set(job.id,task);setImmediate(next);}else active=task;
  }
  let billingBusy=false,balanceBusy=false;
  async function syncCosts(job){
    const ids=[...new Set(job.clips.map(c=>c?.remote?.id).filter(Boolean))];
    const key=config.falBillingKey,fetched=await providers.billing({falBillingKey:key},job),reported=new Set(fetched.map(e=>e.requestId));
    if(config.falBillingKey!==key)fail('The billing key changed. Sync costs again.',409);
    const events=[...fetched,...(job.billing?.events??[]).filter(e=>ids.includes(e.requestId)&&!reported.has(e.requestId))],matched=new Set(events.map(e=>e.requestId));
    job.billing={currency:'USD',actualCost:events.reduce((sum,e)=>sum+e.costUSD,0),matchedRequests:matched.size,totalRequests:ids.length,complete:ids.length>0&&matched.size===ids.length&&!job.clips.some(c=>c?.submissionUnknown),events,syncedAt:new Date().toISOString()};save();
  }
  const ensureConnection=provider=>{if(provider==='fal'&&!config.falKey)fail('Save your fal.ai API key in Engine settings first.',409);if(provider==='runpod'&&!(config.runpodMode==='serverless'?config.endpointId&&getRunpodAccountKey():config.podURL&&config.podToken))fail('Configure MiniMax H3 serverless or a dedicated Pod in RunPod cloud first.',409);};
  return {
    state,
    async connectServerless({endpointId}){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(endpointId??''))fail('Invalid endpoint ID.');if(db.jobs.some(j=>j.provider==='runpod'&&['queued','running'].includes(j.status)))fail('Wait for the RunPod video queue before switching endpoints.',409);config={...config,endpointId,runpodMode:'serverless'};atomic(keyFile,config);},
    async connectRunpod({url,token}) {
      if(db.jobs.some(j=>j.provider==='runpod'&&['queued','running'].includes(j.status)))fail('Wait for the RunPod video queue before changing its service.',409);
      const next={...config,runpodMode:'pod',podURL:validateVideoPodURL(url),podToken:string(token,'RunPod video token',250)};
      if(!next.podToken)fail('A video worker token is required.');
      await providers.checkPod(next);config=next;atomic(keyFile,config);
    },
    clearProject(id){for(const job of db.jobs)if(job.projectId===id)job.projectId='';save();},
    async handle(req,res,route,{body,send,serveFile}){
      if(route==='/api/videos/billing/balance'&&req.method==='POST'){
        if(!config.falBillingKey)fail('Save an admin-scope billing key in Engine settings first.',409);
        if(balanceBusy)fail('Balance refresh is already running.',409);
        balanceBusy=true;const key=config.falBillingKey;
        try{
          const result=await providers.balance({falBillingKey:key});
          if(config.falBillingKey!==key)fail('The billing key changed. Refresh the balance again.',409);
          db.accountBilling={balance:result.balance,currency:result.currency,checkedAt:result.checkedAt};save();send(res,200,db.accountBilling);return true;
        }finally{balanceBusy=false;}
      }
      if(route==='/api/videos/billing/sync'&&req.method==='POST'){
        if(billingBusy)fail('Billing sync is already running.',409);if(!config.falBillingKey)fail('Save an admin-scope billing key in Engine settings first.',409);
        billingBusy=true;let synced=0;
        try{for(const job of db.jobs.filter(j=>j.provider==='fal'&&j.clips.some(c=>c?.remote?.id))){await syncCosts(job);synced++;}send(res,200,{synced});return true;}
        finally{billingBusy=false;}
      }
      if(route==='/api/videos/state' &&req.method==='GET'){send(res,200,state());return true;}
      if(route==='/api/videos/images'&&req.method==='POST'){
        const input=await body(req,7500000),label=string(input.label,'Image label',80);
        if(!label)fail('Give the image a name, such as Rusty.');
        if(db.images.some(i=>!i.archived&&i.label.toLowerCase()===label.toLowerCase()))fail('That label already exists. Choose a different label.');
        if(db.images.filter(i=>!i.archived).length>=40)fail('The reference library allows 40 images. Archive an image first.');
        const match=typeof input.data==='string'&&/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.data);
        if(!match)fail('Upload a PNG, JPEG, or WebP image.');
        const bytes=Buffer.from(match[2],'base64'),type=match[1];
        if(bytes.length>5*1024*1024)fail('Images must be 5 MB or smaller.');
        const valid=type==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):type==='jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
        if(!valid||bytes.length<24)fail('The file does not match its image format.');
        if(!existsSync(executable))fail('Install app dependencies to prepare reference images.',503);
        const image={id:randomUUID(),label,mime:'image/jpeg',extension:'jpg',createdAt:new Date().toISOString()},temporary=path.join(imagesDir,image.id+'.upload.'+(type==='jpeg'?'jpg':type)),output=path.join(imagesDir,image.id+'.jpg');
        writeFileSync(temporary,bytes);
        try{const converted=await processAudio(executable,['-hide_banner','-nostdin','-y','-f','image2','-i',temporary,'-frames:v','1','-vf',"scale='min(1536,iw)':'min(1536,ih)':force_original_aspect_ratio=decrease",'-q:v','3','-threads','1',output]);if(converted.code!==0||!existsSync(output)||statSync(output).size<24){if(existsSync(output))unlinkSync(output);fail('This image could not be decoded. Choose a valid PNG, JPEG, or WebP.');}}
        finally{if(existsSync(temporary))unlinkSync(temporary);}
        db.images.push(image);save();send(res,201,image);return true;
      }
      const imageMatch=/^\/api\/videos\/images\/([a-f0-9-]{36})$/.exec(route);
      if(imageMatch){
        const image=db.images.find(i=>i.id===imageMatch[1]);if(!image)fail('Image not found.',404);
        if(['GET','HEAD'].includes(req.method)){serveFile(req,res,path.join(imagesDir,image.id+'.'+image.extension));return true;}
        if(req.method==='PATCH'){const input=await body(req),label=string(input.label,'Image label',80);if(!label||db.images.some(i=>i.id!==image.id&&!i.archived&&i.label.toLowerCase()===label.toLowerCase()))fail('Choose a unique, nonempty label.');image.label=label;save();send(res,200,image);return true;}
        if(req.method==='DELETE'){image.archived=true;save();send(res,200,{archived:true});return true;}
      }
      if(route==='/api/videos/connection'&&req.method==='PUT'){
        const input=await body(req),next={...config};
        if(input.falBillingKey!==undefined){const key=string(input.falBillingKey,'fal.ai billing key',250);if(key)next.falBillingKey=key;}
        if(input.falKey!==undefined){const key=string(input.falKey,'fal.ai key',250);if(key)next.falKey=key;}
        if(input.runpodMode!==undefined){if(!['serverless','pod'].includes(input.runpodMode))fail('Choose Serverless or Pod.');if(db.jobs.some(j=>j.provider==='runpod'&&['queued','running'].includes(j.status)))fail('Wait for the RunPod video queue before changing its engine.',409);next.runpodMode=input.runpodMode;}
        if(input.endpointId!==undefined){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(input.endpointId))fail('Enter your compatible H3 endpoint ID.');next.endpointId=input.endpointId;}
        if(input.podURL!==undefined){try{next.podURL=validateVideoPodURL(input.podURL);}catch(error){fail(error.message);}}
        if(input.podToken!==undefined){const token=string(input.podToken,'RunPod video token',250);if(token)next.podToken=token;}
        if(input.falKey!==undefined&&!next.falKey)fail('Enter your fal.ai API key.');
        if(input.podURL!==undefined&&next.runpodMode!=='serverless'&&!next.podToken)fail('Enter the API token configured on your MiniMax H3 video service.');
        if(next.falBillingKey!==config.falBillingKey){delete db.accountBilling;save();}
        config=next;atomic(keyFile,config);send(res,200,state().connection);return true;
      }
      if(route==='/api/videos/connection'&&req.method==='DELETE'){
        const input=await body(req);if(!['fal','runpod','billing'].includes(input.provider))fail('Choose a provider.');
        if(active?.job.provider===input.provider||(input.provider==='runpod'&&concurrent.size))fail('Finish or cancel the active video before disconnecting.',409);
        if(input.provider==='billing'){config.falBillingKey='';delete db.accountBilling;save();}else if(input.provider==='fal')config.falKey='';else{config.podURL='';config.podToken='';config.endpointId='';}atomic(keyFile,config);send(res,200,state().connection);return true;
      }
      if(route==='/api/videos/check-pod'&&req.method==='POST'){ensureConnection('runpod');if(config.runpodMode==='serverless')await providers.checkServerless({...config,serverlessKey:getRunpodAccountKey()});else await providers.checkPod(config);send(res,200,{ready:true});return true;}
      if(route==='/api/videos/draft'&&req.method==='PUT'){
        const input=await body(req);if(JSON.stringify(input).length>24000)fail('Video draft is too large.');db.draft=input;save();send(res,200,{saved:true});return true;
      }
      if(route==='/api/videos/plan'&&req.method==='POST'){
        const result=await plan(await body(req));let pricing=null,pricingError=null;
        if(result.provider==='fal'&&config.falKey){try{pricing=await providers.pricing(config,result.model);}catch{pricingError='Pricing could not be retrieved. Check fal.ai pricing before generating.';}}
        send(res,200,{...result,pricing,pricingError});return true;
      }
      if(route==='/api/videos'&&req.method==='POST'){
        const input=await body(req);ensureConnection(input.provider);const ongoing=db.jobs.filter(j=>['queued','running'].includes(j.status));if(ongoing.length&&(input.provider!=='runpod'||config.runpodMode!=='serverless'||ongoing.length>=2||ongoing.some(j=>j.provider!=='runpod'||j.runpodMode!=='serverless')))fail('Finish or cancel the current video before starting another; serverless supports two concurrent videos.',409);
        const planned=await plan(input);getSource(planned.songId,planned.masterId);const job={...planned,...(planned.provider==='runpod'?{runpodMode:config.runpodMode,endpointId:config.endpointId??''}:{}),id:randomUUID(),clips:[],status:'queued',stage:'Queued',createdAt:new Date().toISOString()};
        mkdirSync(jobDir(job.id));db.jobs.push(job);db.draft=input;save();setImmediate(next);send(res,202,view(job));return true;
      }
      const match=/^\/api\/videos\/([a-f0-9-]{36})\/(video|thumbnail|cancel|resume|trash|restore|project)$/.exec(route);
      if(match){
        const job=db.jobs.find(j=>j.id===match[1]);if(!job)fail('Video not found.',404);
        if(match[2]==='project'&&req.method==='PATCH'){
          const input=await body(req);if(input.projectId===null)delete job.projectId;else {if(typeof input.projectId!=='string')fail('Choose a project, Unassigned, or Follow source song.');job.projectId=validProject(input.projectId);}save();send(res,200,view(job));return true;
        }
        if(match[2]==='trash' &&req.method==='POST'){
          if(active?.job.id===job.id||['queued','running'].includes(job.status))fail('Finish or cancel this video before deleting it.',409);
          job.deletedAt??=new Date().toISOString();save();send(res,200,{deleted:true,recoverable:true,assetsPreserved:true});return true;
        }
        if(match[2]==='restore'&&req.method==='POST'){
          delete job.deletedAt;save();send(res,200,view(job));return true;
        }
        if(job.deletedAt&&['cancel','resume'].includes(match[2]))fail('Restore this video from Trash first.',409);
        if(match[2]==='video' &&['GET','HEAD'].includes(req.method)){if(!view(job).hasVideo)fail('Video is not ready.',409);serveFile(req,res,path.join(jobDir(job.id),'video.mp4'),new URL(req.url,'http://localhost').searchParams.has('download'),`${job.title.replace(/[^a-zA-Z0-9 _-]/g,'').slice(0,70)||'song'}-music-video.mp4`);return true;}
        if(match[2]==='thumbnail'&&['GET','HEAD'].includes(req.method)){
          if(!view(job).hasVideo)fail('Video is not ready.',409);
          const output=path.join(jobDir(job.id),'thumbnail.jpg'),temporary=path.join(jobDir(job.id),'thumbnail.partial.jpg');
          if(!existsSync(output)){
            if(!thumbnails.has(job.id)){const work=(async()=>{const result=await processAudio(executable,['-hide_banner','-nostdin','-y','-i',path.join(jobDir(job.id),'video.mp4'),'-frames:v','1','-vf','scale=640:-2','-q:v','3','-threads','1',temporary]);if(result.code!==0){if(existsSync(temporary))unlinkSync(temporary);fail('Could not create video thumbnail.',503);}renameSync(temporary,output);})();thumbnails.set(job.id,work);work.finally(()=>thumbnails.delete(job.id)).catch(()=>{});}
            await thumbnails.get(job.id);
          }
          serveFile(req,res,output,false);return true;
        }
        if(match[2]==='cancel'&&req.method==='POST'){
          if(!['running','queued'].includes(job.status))fail('This video is no longer generating.',409);
          job.status='cancelled';job.stage='Cancelled';save();
          const task=concurrent.get(job.id)??(active?.job.id===job.id?active:null);if(task){task.controller.abort(new Error('Video cancelled'));for(const clip of job.clips)if(clip?.remote&&!clip.completed)await providers.cancel(task.config,job.provider,clip.remote).catch(()=>{});}
          send(res,200,view(job));return true;
        }
        if(match[2]==='resume'&&req.method==='POST'){
          if(!['interrupted','failed','cancelled'].includes(job.status)||job.clips.some(c=>c?.submissionUnknown))fail('This video cannot be resumed. Check the provider request history.',409);
          if(active||concurrent.size||db.jobs.some(j=>j.status==='queued'))fail('Wait for the current video to finish.',409);
          ensureConnection(job.provider);if(job.provider==='runpod'&&job.runpodMode==='serverless'&&(config.runpodMode!=='serverless'||job.endpointId!==config.endpointId))fail('Reconnect this video’s original serverless endpoint before resuming.',409);job.status='queued';job.stage='Queued to resume';delete job.error;save();setImmediate(next);send(res,202,view(job));return true;
        }
      }return false;
    },
    async close(){closing=true;const tasks=[...concurrent.values(),...(active?[active]:[])];for(const task of tasks)task.controller.abort(new Error('App shutting down'));await Promise.all(tasks.map(task=>task.running));},
  };
}
