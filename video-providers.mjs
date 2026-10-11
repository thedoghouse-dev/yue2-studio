import { setTimeout as delay } from 'node:timers/promises';
import { createWriteStream, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const VIDEO_MODELS = [
  { id:'minimax/h3-max-turbo/text-to-video', name:'MiniMax H3 Max Turbo', provider:'fal', durations:[5,6,8,10,12,15], resolutions:['480P','768P','1080P'], ratios:['16:9','9:16','1:1'], seed:true, expansion:true },
  { id:'minimax/h3/text-to-video', name:'MiniMax H3', provider:'fal', durations:[5,6,8,10,12,15], resolutions:['480P','768P','2K','4K'], ratios:['16:9','9:16','1:1'], seed:true },
  { id:'fal-ai/kling-video/v2.5-turbo/pro/text-to-video', name:'Kling 2.5 Turbo Pro', provider:'fal', durations:[5,10], resolutions:[], ratios:['16:9','9:16','1:1'], stringDuration:true, maxPrompt:2500 },
  { id:'bytedance/seedance-2.5/text-to-video', name:'Seedance 2.5', provider:'fal', durations:[5,6,8,10,12,15,20,30], resolutions:['480p','720p','1080p'], ratios:['16:9','9:16','1:1'], stringDuration:true, audioFlag:true },
  { id:'lightricks/ltx-2.5/text-to-video/fast', name:'LTX 2.5 Fast', provider:'fal', durations:[6,8,10,12,14,16,18,20], resolutions:['720p','1080p','1440p','2160p'], ratios:['16:9','9:16'], audioFlag:true },
  { id:'minimax-h3-base', name:'MiniMax H3 Base · 768p', provider:'runpod', durations:[5,6,8,10,12,15], resolutions:['768p'], ratios:['16:9','9:16','1:1'], seed:true },
  { id:'minimax/h3/reference-to-video', name:'MiniMax H3 · multiple image references', provider:'fal', durations:[5,6,8,10,12,15], resolutions:['480P','768P','2K','4K'], ratios:['16:9','9:16','1:1'], seed:true, expansion:true, imageMode:'references', maxImages:9 },
  { id:'minimax/h3-max-turbo/image-to-video', name:'MiniMax H3 Max Turbo · image to video', provider:'fal', durations:[5,6,8,10,12,15], resolutions:['480P','768P','1080P'], ratios:['16:9','9:16','1:1'], seed:true, expansion:true, imageMode:'first-frame', maxImages:1 },
];
export function validateVideoPodURL(value) {
  let url;try{url=new URL(value);}catch{throw new Error('Enter a RunPod HTTPS proxy URL.');}
  if(url.protocol!=='https:'||!/^([a-z0-9]+)-([1-9][0-9]{0,4})\.proxy\.runpod\.net$/.test(url.hostname)||url.port||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Use https://<pod-id>-<port>.proxy.runpod.net with no extra path.');
  return url.origin;
}
export function falInput(model, job, prompt, index) {
  const input={prompt,duration:model.stringDuration?String(job.clipSeconds):job.clipSeconds,aspect_ratio:job.ratio};
  if(job.resolution)input.resolution=job.resolution;
  if(model.seed)input.seed=(job.seed+index)%2147483648;
  if(model.expansion)input.prompt_expansion_mode='balanced';
  if(model.audioFlag)input.generate_audio=false;
  if(model.id.startsWith('lightricks/'))input.fps=24;
  if(model.imageMode==='references')input.reference_image_urls=job.imageInputs??[];
  if(model.imageMode==='first-frame'){delete input.aspect_ratio;input.image_url=job.imageInputs?.[0];}
  return input;
}
function queueURL(value) {
  const url=new URL(value);if(url.origin!=='https://queue.fal.run'||url.username||url.password)throw new Error('Invalid fal queue URL.');return url.href;
}
function mediaURL(value) {
  const url=new URL(value);if(url.protocol!=='https:'||!(url.hostname==='fal.media'||url.hostname.endsWith('.fal.media'))||url.port||url.username||url.password)throw new Error('The video provider returned an unrecognized media URL.');return url.href;
}
export function createVideoProviders({fetcher=fetch,pollMs=3000}={}) {
  async function request(url,config,{method='GET',body,signal}={}) {
    const response=await fetcher(url,{method,headers:{Authorization:config.provider==='fal'?`Key ${config.falKey}`:`Bearer ${config.podToken}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)});
    if(!response.ok&&(url.startsWith('https://api.fal.ai/v1/models/billing-events')||url.startsWith('https://api.fal.ai/v1/account/billing'))&&[401,403].includes(response.status))throw Object.assign(new Error('fal.ai denied billing access. Save an admin-scope billing key in Engine settings.'),{status:403});
    if(!response.ok)throw new Error(response.status===401||response.status===403?'Video provider rejected the saved key or token. Update Engine settings.':`Video provider request failed (${response.status}). Check your balance and model availability. No automatic paid retry was made.`);
    return response;
  }
  async function json(url,config,options){const response=await request(url,config,options);const raw=await response.text();if(raw.length>2000000)throw new Error('Video provider returned too much metadata.');return JSON.parse(raw);}
  async function download(url,file,signal,config) {
    let response;
    if(config)response=await request(url,config,{signal});
    else{
      let target=mediaURL(url);
      for(let hops=0;hops<4;hops++){
        response=await fetcher(target,{redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(300000)])});
        if([301,302,303,307,308].includes(response.status)){target=mediaURL(new URL(response.headers.get('location'),target).href);await response.body?.cancel();continue;}
        break;
      }
      if(!response.ok)throw new Error('Could not download the generated video.');
    }
    let size=0;const limit=new Transform({transform(chunk,_encoding,callback){size+=chunk.length;callback(size>512*1024*1024?new Error('Generated clip exceeds the 512 MB download limit.'):null,chunk);}});
    try{await pipeline(Readable.fromWeb(response.body),limit,createWriteStream(file),{signal});if(size<24)throw new Error('Generated video was empty.');}
    catch(error){if(existsSync(file))unlinkSync(file);throw error;}
  }
  return {
    async balance(config){
      if(!config.falBillingKey)throw Object.assign(new Error('Save an admin-scope billing key in Engine settings first.'),{status:409});
      const result=await json('https://api.fal.ai/v1/account/billing?expand=credits',{provider:'fal',falKey:config.falBillingKey});
      const {current_balance:balance,currency}=result.credits??{};
      if(typeof balance!=='number'||!Number.isFinite(balance)||typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency))throw new Error('fal.ai returned an unexpected credit balance.');
      return {balance,currency,checkedAt:new Date().toISOString()};
    },
    async billing(config,job){
      if(!config.falBillingKey)throw Object.assign(new Error('Save an admin-scope billing key in Engine settings first.'),{status:409});
      const ids=[...new Set(job.clips.map(c=>c?.remote?.id).filter(Boolean))],events=[];
      if(!ids.length)return events;
      const start=new Date(new Date(job.createdAt).getTime()-3600000),end=new Date(Math.min(Date.now()+60000,start.getTime()+90*86400000));
      for(let offset=0;offset<ids.length;offset+=50){
        const batch=ids.slice(offset,offset+50);let cursor=null;
        for(let page=0;page<20;page++){
          const params=new URLSearchParams({endpoint_id:job.model,request_id:batch.join(','),start:start.toISOString(),end:end.toISOString(),limit:'1000'});if(cursor)params.set('cursor',cursor);
          const result=await json('https://api.fal.ai/v1/models/billing-events?'+params,{provider:'fal',falKey:config.falBillingKey});
          if(!Array.isArray(result.billing_events))throw new Error('fal.ai returned an unexpected billing response.');
          for(const event of result.billing_events)if(batch.includes(event.request_id)&&event.endpoint_id===job.model){if(typeof event.cost_total!=='number'||!Number.isFinite(event.cost_total)||event.cost_total<0)throw new Error('fal.ai returned an invalid billing amount.');events.push({requestId:event.request_id,costUSD:event.cost_total,timestamp:event.timestamp});}
          if(!result.has_more&&!result.next_cursor)break;
          if(!result.next_cursor||page===19)throw new Error('Billing history has more pages. Try syncing a smaller history.');cursor=result.next_cursor;
        }
      }
      return events;
    },
    async pricing(config,endpoint){return json(`https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(endpoint)}`,{...config,provider:'fal'});},
    async checkServerless(config){
      if(!/^[a-zA-Z0-9_-]{1,100}$/.test(config.endpointId??'')||!config.serverlessKey)throw new Error('Choose a serverless endpoint and save a RunPod account key.');
      return json(`https://api.runpod.ai/v2/${config.endpointId}/health`,{...config,provider:'runpod',podToken:config.serverlessKey});
    },
    async checkPod(config){
      const origin=validateVideoPodURL(config.podURL),models=await json(origin+'/v1/models',{...config,provider:'runpod'});
      if(!models.data?.some(model=>/minimax.*h3/i.test(model.id)))throw new Error('The service is reachable but does not advertise MiniMax H3. Connect the H3 FL2VA service.');
      return models;
    },
    async submit(config,model,job,prompt,index,signal){
      if(job.provider==='fal'){
        const result=await json('https://queue.fal.run/'+model.id,{...config,provider:'fal'},{method:'POST',body:falInput(model,job,prompt,index),signal});
        if(!result.request_id)throw new Error('fal did not return a request ID. Check request history before trying again.');
        return {id:result.request_id,statusURL:queueURL(result.status_url),resultURL:queueURL(result.response_url),cancelURL:queueURL(result.cancel_url)};
      }
      if(config.runpodMode==='serverless'){
        if(!/^[a-zA-Z0-9_-]{1,100}$/.test(config.endpointId??'')||!config.serverlessKey)throw new Error('Configure RunPod serverless in RunPod cloud first.');
        const result=await json(`https://api.runpod.ai/v2/${config.endpointId}/run`,{...config,provider:'runpod',podToken:config.serverlessKey},{method:'POST',body:{input:{prompt:`integrated_multimodal_description: ${prompt}\noverall_soundscape: Quiet ambience.\nnon_diegetic_music: No background music.`,seconds:job.clipSeconds,ratio:job.ratio,seed:(job.seed+index)%2147483648},policy:{executionTimeout:3600000,ttl:7200000}},signal});
        if(typeof result.id!=='string'||!/^[-a-zA-Z0-9_]{1,150}$/.test(result.id))throw new Error('RunPod did not acknowledge a scene job. Check endpoint requests before retrying.');
        return {id:result.id,endpointId:config.endpointId};
      }
      const origin=validateVideoPodURL(config.podURL);
      const result=await json(origin+'/v1/videos',{...config,provider:'runpod'},{method:'POST',body:{task:'t2va',prompt:`integrated_multimodal_description: ${prompt}\noverall_soundscape: Quiet ambience.\nnon_diegetic_music: No background music.`,conditions:[],target:{short_edge:768,aspect_ratio:job.ratio,duration_seconds:job.clipSeconds},seed:(job.seed+index)%2147483648},signal});
      if(typeof result.id!=='string'||!/^[-a-zA-Z0-9_]{1,150}$/.test(result.id))throw new Error('RunPod did not return a valid video ID.');
      return {id:result.id,statusURL:origin+'/v1/videos/'+result.id,resultURL:origin+'/v1/videos/'+result.id+'/content'};
    },
    async waitAndDownload(config,provider,remote,file,{signal,onStatus=()=>{}}){
      if(provider==='runpod'&&remote.endpointId){
        if(!/^[a-zA-Z0-9_-]{1,100}$/.test(remote.endpointId)||!/^[-a-zA-Z0-9_]{1,150}$/.test(remote.id))throw new Error('Invalid serverless job reference.');
        const route=`https://api.runpod.ai/v2/${remote.endpointId}/status/${remote.id}`;
        while(true){
          signal.throwIfAborted();const response=await request(route,{...config,provider:'runpod',podToken:config.serverlessKey},{signal});
          const raw=await response.text();if(raw.length>18*1024*1024)throw new Error('Serverless scene result exceeds its size limit.');const result=JSON.parse(raw);
          if(result.status==='COMPLETED'){
            const encoded=result.output?.videoBase64;if(typeof encoded!=='string'||encoded.length>16*1024*1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw new Error('Invalid serverless video output.');
            const bytes=Buffer.from(encoded,'base64');if(bytes.length<24||bytes.toString('ascii',4,8)!=='ftyp')throw new Error('Serverless output is not an MP4.');writeFileSync(file,bytes);return;
          }
          if(['FAILED','CANCELLED','TIMED_OUT'].includes(result.status))throw new Error('Serverless scene failed. Check worker logs; completed scenes remain saved.');
          if(!['IN_QUEUE','IN_PROGRESS'].includes(result.status))throw new Error('Unknown serverless scene status.');onStatus(result.status);await delay(pollMs,undefined,{signal});
        }
      }
      const conf={...config,provider};
      while(true){
        signal.throwIfAborted();
        const status=await json(provider==='fal'?queueURL(remote.statusURL):remote.statusURL,conf,{signal});
        if(['FAILED','failed','cancelled','CANCELLED'].includes(status.status))throw new Error('The provider could not generate this scene. Completed scenes are retained.');
        if(['COMPLETED','completed'].includes(status.status))break;
        if(!['IN_QUEUE','IN_PROGRESS','queued','in_progress','pending','processing'].includes(status.status))throw new Error('Video provider returned an unknown status.');
        onStatus(status.status);await delay(pollMs,undefined,{signal});
      }
      if(provider==='fal'){const result=await json(queueURL(remote.resultURL),conf,{signal});await download(result.video?.url,file,signal);}
      else await download(remote.resultURL,file,signal,conf);
    },
    async cancel(config,provider,remote){if(provider==='runpod'&&remote?.endpointId&&/^[a-zA-Z0-9_-]{1,100}$/.test(remote.endpointId)&&/^[-a-zA-Z0-9_]{1,150}$/.test(remote.id))await request(`https://api.runpod.ai/v2/${remote.endpointId}/cancel/${remote.id}`,{...config,provider:'runpod',podToken:config.serverlessKey},{method:'POST'});if(provider==='fal'&&remote?.cancelURL)await request(queueURL(remote.cancelURL),{...config,provider},{method:'PUT'});},
  };
}
