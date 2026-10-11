import { createWriteStream, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export function validateRunpodURL(value) {
  let url;try{url=new URL(value);}catch{throw new Error('Enter your RunPod worker HTTPS URL.');}
  if(url.protocol!=='https:'||!/^([a-z0-9]+)-8000\.proxy\.runpod\.net$/.test(url.hostname)||url.port||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Use https://<pod-id>-8000.proxy.runpod.net with no extra path.');
  return url.origin;
}
export function createRunpodClient({fetcher=fetch,pollMs=2000,timeoutMs=30*60*1000}={}) {
  async function request(config,route,{method='GET',body,signal}={}) {
    const base=validateRunpodURL(config.url);
    if(!config.token)throw new Error('Connect your RunPod worker in Engine settings first.');
    let response;
    try{response=await fetcher(base+route,{method,headers:{Authorization:`Bearer ${config.token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});}catch(e){if(signal?.aborted)throw signal.reason;throw new Error('Cannot reach the RunPod worker. Check that the pod is running and its HTTP port is exposed.');}
    if(!response.ok){throw new Error(response.status===401?'RunPod worker token was rejected. Update it in Engine settings.':`RunPod worker request failed (${response.status}). Check its status and try again.`);}
    return response;
  }
  async function json(config,route,options){const res=await request(config,route,options);const value=await res.text();if(value.length>1000000)throw new Error('RunPod returned too much metadata.');try{return JSON.parse(value);}catch{throw new Error('The RunPod URL did not return valid worker metadata.');}}
  const cancel=(config,id)=>json(config,`/jobs/${id}/cancel`,{method:'POST',body:{}});
  return {
    async health(config){const health=await json(config,'/health');if(health.protocol!=='yue2-studio/v1'||health.model!=='yue2-3b-bf16.gguf'||health.vae!=='yue2-vae-f32.gguf')throw new Error('Connect the supplied YuE2 Studio BF16 worker, not another RunPod service.');return health;},
    async setupHealth(config){const health=await json(config,'/health');if(health.protocol!=='yue2-studio/h3-setup/v1'||health.model!=='MiniMaxAI/MiniMax-H3'||!['h3-download','h3-video'].includes(health.workload))throw new Error('Connect the supplied MiniMax H3 installer.');return health;},
    cancel,
    async run(song,dir,config,{signal,onProgress=()=>{}}={}){
      const timed=AbortSignal.timeout(timeoutMs);const combined=signal?AbortSignal.any([signal,timed]):timed;
      const audioFile=path.join(dir,'audio.wav');let submitted=false;
      try{
        const health=await this.health(config);if(!health.ready)throw new Error(health.error||`RunPod is preparing the model: ${health.stage}. Try again when it is ready.`);
        const {id,title,style,lyrics,abc,mode,seed,maxTokens,steps,temperature,durationSeconds,durationMode,scoreUse}=song;
        // The client UUID makes submission idempotent; failed requests are never resubmitted automatically.
        await json(config,'/jobs',{method:'POST',body:{id,title,style,lyrics,abc,mode,seed,maxTokens,steps,temperature,durationSeconds,durationMode,scoreUse},signal:combined});submitted=true;
        while(true){
          combined.throwIfAborted();const job=await json(config,`/jobs/${id}`,{signal:combined});onProgress(job);
          if(job.status==='failed'||job.status==='cancelled')throw new Error(job.error||`RunPod generation was ${job.status}.`);
          if(job.status==='completed'){
            const res=await request(config,`/jobs/${id}/audio`,{signal:combined});let bytes=0;
            if(Number(res.headers.get('content-length'))>128*1048576)throw new Error('RunPod audio exceeds 128 MB.');
            await pipeline(Readable.fromWeb(res.body),new Transform({transform(chunk,encoding,cb){bytes+=chunk.length;cb(bytes>128*1048576?new Error('RunPod audio exceeds 128 MB.'):null,chunk);}}),createWriteStream(audioFile),{signal:combined});
            const head=readFileSync(audioFile).subarray(0,12);if(bytes<=44||head.toString('ascii',0,4)!=='RIFF'||head.toString('ascii',8,12)!=='WAVE')throw new Error('RunPod returned an invalid WAV recording.');
            return job;
          }
          if(!['queued','running'].includes(job.status))throw new Error('Unexpected RunPod job status.');
          await delay(pollMs,undefined,{signal:combined});
        }
      }catch(error){if(existsSync(audioFile))unlinkSync(audioFile);if(submitted||combined.aborted)await cancel(config,song.id).catch(()=>{});throw error;}
    }
  };
}
