import {readFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import path from 'node:path';

// Official RunPod CUDA 12.8 development image, pinned to its published digest.
export const WORKER_IMAGE='runpod/pytorch@sha256:0a360022e8de4375af99430f84e8b38951acc397252163a37ceac7204d01be35';
export function workerPodPlan({root,gpuId,cloud='SECURE',name,volumeId='',dataCenter='',workerToken=randomBytes(32).toString('hex'),deploymentId,includeVideo=false}) {
  const files=Object.fromEntries((includeVideo?['worker.py','setup_worker.py','h3_worker.py']:['worker.py','setup_worker.py']).map(name=>[name,readFileSync(path.join(root,'cloud',name),'utf8')]));
  const source=JSON.stringify(files);
  const bootstrap="import os,json,base64,pathlib,runpy,sys; p=pathlib.Path('/workspace/yue2-service'); p.mkdir(parents=True,exist_ok=True); files=json.loads(base64.b64decode(os.environ['YUE2_WORKER_BUNDLE'])); [(p/name).write_text(content,encoding='utf-8') for name,content in files.items()]; sys.path.insert(0,str(p)); runpy.run_path(str(p/'worker.py'),run_name='__main__')";
  return {name,image:WORKER_IMAGE,cloud,gpu:{id:gpuId,count:1,minRamPerGpu:32,minVcpuCountPerGpu:8,minCudaVersion:'12.8'},disk:30,ports:['8000/http'],
    ...(dataCenter?{dataCenterIds:[dataCenter]}:{}),
    mounts:volumeId?{network:[{volumeId,path:'/workspace'}]}:{persistent:{size:50,path:'/workspace'}},
    env:{YUE2_WORKER_TOKEN:workerToken,YUE2_WORKER_BUNDLE:Buffer.from(source).toString('base64'),YUE2_STUDIO_DEPLOYMENT:deploymentId,YUE2_ROOT:'/workspace/yue2',...(includeVideo?{YUE2_INCLUDE_VIDEO:'1',H3_ROOT:'/workspace/models/minimax-h3'}:{})},
    entrypoint:['python3','-u','-c'],cmd:[bootstrap]};
}
export function workerSourceHash(root) {
  return createHash('sha256').update(['worker.py','setup_worker.py'].map(name=>readFileSync(path.join(root,'cloud',name),'utf8')).join('\n')).digest('hex');
}

export const H3_IMAGE='lmsysorg/sglang@sha256:b1259f3ea3275f66237c498ea388919729018bc9f01c3d638391e06e2cf3f469';
export function h3PodPlan({root,gpuId,cloud='SECURE',name,volumeId,dataCenter,workerToken,deploymentId,workload='h3-video'}) {
  const files=Object.fromEntries(['h3_worker.py','setup_worker.py'].map(name=>[name,readFileSync(path.join(root,'cloud',name),'utf8')]));
  const bootstrap="import os,json,base64,pathlib,runpy,sys; p=pathlib.Path('/workspace/yue2-service'); p.mkdir(parents=True,exist_ok=True); files=json.loads(base64.b64decode(os.environ['YUE2_WORKER_BUNDLE'])); [(p/name).write_text(content,encoding='utf-8') for name,content in files.items()]; sys.path.insert(0,str(p)); runpy.run_path(str(p/'h3_worker.py'),run_name='__main__')";
  const serving=workload==='h3-video';
  return {name,image:serving?H3_IMAGE:WORKER_IMAGE,cloud,gpu:{id:gpuId,count:serving?4:1,minRamPerGpu:serving?96:32,minVcpuCountPerGpu:8,minCudaVersion:serving?'13.0':'12.8'},disk:serving?80:30,
    dataCenterIds:[dataCenter],mounts:{network:[{volumeId,path:'/workspace'}]},ports:serving?['8000/http','30010/http']:['8000/http'],
    env:{YUE2_WORKER_TOKEN:workerToken,YUE2_WORKER_BUNDLE:Buffer.from(JSON.stringify(files)).toString('base64'),YUE2_STUDIO_DEPLOYMENT:deploymentId,YUE2_STUDIO_WORKLOAD:workload,H3_ROOT:'/workspace/models/minimax-h3',HF_HOME:'/workspace/huggingface'},entrypoint:['python3','-u','-c'],cmd:[bootstrap]};
}
export function setupSourceHash(root,workload='yue2',includeVideo=false) {
  if(workload==='yue2-serverless')return createHash('sha256').update(workerSourceHash(root)).update(readFileSync(path.join(root,'cloud','yue2_serverless.py'),'utf8')).update(WORKER_IMAGE).digest('hex');
  if(workload==='yue2')return includeVideo?createHash('sha256').update(workerSourceHash(root)).update(readFileSync(path.join(root,'cloud','h3_worker.py'),'utf8')).digest('hex'):workerSourceHash(root);
  return createHash('sha256').update(workload==='h3-serverless'?readFileSync(path.join(root,'cloud','h3_serverless.py'),'utf8'):'').update(readFileSync(path.join(root,'cloud','h3_worker.py'),'utf8')).update(readFileSync(path.join(root,'cloud','setup_worker.py'),'utf8')).update(H3_IMAGE).digest('hex');
}

export function h3EndpointPlan({root,name,volumeId,dataCenter,workerToken,deploymentId,pool,pools=pool?[pool]:[],excludedTypes=[],maxWorkers=10}) {
  const files=Object.fromEntries(['h3_serverless.py','h3_worker.py','setup_worker.py'].map(name=>[name,readFileSync(path.join(root,'cloud',name),'utf8')]));
  const bootstrap="import os,json,base64,pathlib,runpy,sys,subprocess; p=pathlib.Path('/tmp/yue2-service'); p.mkdir(parents=True,exist_ok=True); files=json.loads(base64.b64decode(os.environ['YUE2_WORKER_BUNDLE'])); [(p/name).write_text(content,encoding='utf-8') for name,content in files.items()]; sys.path.insert(0,str(p)); subprocess.run([sys.executable,'-m','pip','install','runpod==1.12.0'],check=True); runpy.run_path(str(p/'h3_serverless.py'),run_name='__main__')";
  return {name,type:'QUEUE',image:H3_IMAGE,disk:80,ports:[],entrypoint:['python3','-u','-c'],cmd:[bootstrap],
    env:{YUE2_WORKER_TOKEN:workerToken,YUE2_WORKER_BUNDLE:Buffer.from(JSON.stringify(files)).toString('base64'),YUE2_STUDIO_DEPLOYMENT:deploymentId,YUE2_STUDIO_WORKLOAD:'h3-serverless',H3_ROOT:'/runpod-volume/models/minimax-h3',HF_HOME:'/runpod-volume/huggingface'},
    gpu:{pools,excludedTypes,count:4,minCudaVersion:'13.0'},dataCenterIds:[dataCenter],networkVolumes:[volumeId],workers:{min:0,max:maxWorkers,idleTimeout:10},scaling:{type:'QUEUE_DELAY',queueDelay:4},flashboot:'OFF',timeout:3600000};
}

export function yue2EndpointPlan({root,name,volumeId,dataCenter,workerToken,deploymentId,pool,pools=pool?[pool]:[],excludedTypes=[],maxWorkers=10}) {
  const files=Object.fromEntries(['worker.py','setup_worker.py','yue2_serverless.py'].map(name=>[name,readFileSync(path.join(root,'cloud',name),'utf8')]));
  const bootstrap="import os,json,base64,pathlib,runpy,sys,subprocess; p=pathlib.Path('/tmp/yue2-service'); p.mkdir(parents=True,exist_ok=True); files=json.loads(base64.b64decode(os.environ['YUE2_WORKER_BUNDLE'])); [(p/name).write_text(content,encoding='utf-8') for name,content in files.items()]; sys.path.insert(0,str(p)); subprocess.run([sys.executable,'-m','pip','install','runpod==1.12.0'],check=True); runpy.run_path(str(p/'yue2_serverless.py'),run_name='__main__')";
  return {name,type:'QUEUE',image:WORKER_IMAGE,disk:30,ports:[],entrypoint:['python3','-u','-c'],cmd:[bootstrap],
    env:{YUE2_WORKER_TOKEN:workerToken,YUE2_WORKER_BUNDLE:Buffer.from(JSON.stringify(files)).toString('base64'),YUE2_STUDIO_DEPLOYMENT:deploymentId,YUE2_STUDIO_WORKLOAD:'yue2-serverless',YUE2_ROOT:'/runpod-volume/yue2'},
    gpu:{pools,excludedTypes,count:1,minCudaVersion:'12.8'},dataCenterIds:[dataCenter],networkVolumes:[volumeId],workers:{min:0,max:maxWorkers,idleTimeout:10},scaling:{type:'QUEUE_DELAY',queueDelay:4},flashboot:'OFF',timeout:7200000};
}
