import {writeFileSync,appendFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const idPattern=/^[a-zA-Z0-9_-]{1,150}$/;
export function createRunpodQueueClient({fetcher=fetch,pollMs=2000,timeoutMs=2*60*60*1000}={}) {
  async function request(config,route,{method='GET',body,signal}={}) {
    if(!idPattern.test(config.endpointId??'')||!config.key)throw new Error('Select a YuE2 serverless engine and save your RunPod account key.');
    let response;
    try {response=await fetcher(`https://api.runpod.ai/v2/${config.endpointId}/${route}`,{method,headers:{Authorization:`Bearer ${config.key}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000)});}
    catch {if(signal?.aborted)throw signal.reason;throw new Error('RunPod did not acknowledge the request. Check the job before creating another song; it may still be running.');}
    if(!response.ok)throw new Error(`RunPod serverless request failed (${response.status}). Check your key and endpoint availability.`);
    // Every audio response is capped well below the async result limit.
    let length=0;const pieces=[];
    for await(const chunk of response.body){length+=chunk.length;if(length>7*1048576)throw new Error('RunPod returned too much data.');pieces.push(chunk);}
    try{return JSON.parse(Buffer.concat(pieces).toString());}catch{throw new Error('RunPod returned invalid job metadata.');}
  }
  async function submit(config,input,signal,executionTimeout=7200000){
    const job=await request(config,'run',{method:'POST',body:{input,policy:{executionTimeout,ttl:10800000}},signal});
    if(!idPattern.test(job.id??''))throw new Error('RunPod returned an invalid job ID.');return job.id;
  }
  async function wait(config,id,signal,onProgress){
    while(true){signal.throwIfAborted();const job=await request(config,'status/'+id,{signal});
      if(job.status==='COMPLETED')return job.output;
      if(['FAILED','CANCELLED','TIMED_OUT'].includes(job.status))throw new Error(`RunPod song job ${job.status.toLowerCase()}. ${job.status==='FAILED'?'The worker could not finish setup or generation. Reuse your volume and try a new song session.':''}`);
      if(!['IN_QUEUE','IN_PROGRESS'].includes(job.status))throw new Error('Unexpected RunPod job status.');
      onProgress({stage:job.status==='IN_QUEUE'?'Waiting for a serverless GPU':'Preparing cached engine / generating on RunPod'});
      await delay(pollMs,undefined,{signal});
    }
  }
  return {
    health:config=>request(config,'health'),
    async run(song,dir,config,{signal,onProgress=()=>{}}={}){
      const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
      const file=path.join(dir,'audio.wav');let pending='';
      try {
        const {id,title,style,lyrics,abc,mode,seed,maxTokens,steps,temperature,durationSeconds,durationMode,scoreUse}=song;
        pending=await submit(config,{id,title,style,lyrics,abc,mode,seed,maxTokens,steps,temperature,durationSeconds,durationMode,scoreUse},combined);
        onProgress({stage:'Waiting for a serverless GPU',remoteJobId:pending});
        const result=await wait(config,pending,combined,onProgress);pending='';
        if(result?.protocol!=='yue2-studio/queue/v1'||!Number.isInteger(result.bytes)||result.bytes<=44||result.bytes>128*1048576||result.chunkBytes!==4*1048576||!/^[a-f0-9]{64}$/.test(result.sha256??'')||!/^[a-f0-9]{64}$/.test(result.ticket??''))throw new Error('RunPod returned invalid recording metadata.');
        writeFileSync(file,Buffer.alloc(0));const digest=createHash('sha256');
        for(let offset=0;offset<result.bytes;offset+=result.chunkBytes){
          onProgress({stage:`Downloading recording · ${Math.floor(offset/result.bytes*100)}%`});
          pending=await submit(config,{operation:'audio-chunk',id,ticket:result.ticket,offset},combined,120000);
          const part=await wait(config,pending,combined,()=>{});pending='';
          if(part?.offset!==offset||typeof part.audioBase64!=='string'||part.audioBase64.length>6*1048576||!(/^[A-Za-z0-9+/]+={0,2}$/).test(part.audioBase64))throw new Error('Invalid recording chunk.');
          const bytes=Buffer.from(part.audioBase64,'base64');if(bytes.length!==Math.min(result.chunkBytes,result.bytes-offset))throw new Error('Incomplete recording chunk.');
          digest.update(bytes);appendFileSync(file,bytes);
        }
        const head=readFileSync(file).subarray(0,12);
        if(digest.digest('hex')!==result.sha256||head.toString('ascii',0,4)!=='RIFF'||head.toString('ascii',8,12)!=='WAVE')throw new Error('RunPod recording failed its integrity check.');
        onProgress({stage:'Recording downloaded',logTail:result.logTail??'',truncated:Boolean(result.truncated)});
        return result;
      }catch(error){if(existsSync(file))unlinkSync(file);if(pending)await request(config,'cancel/'+pending,{method:'POST'}).catch(()=>{});throw combined.aborted?combined.reason:error;}
    }
  };
}
