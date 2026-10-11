import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import path from 'node:path';
import {createRunpodQueueClient} from '../runpod-queue-client.mjs';
const parent=path.resolve('.test-tmp');
const song={id:'2f8ce5cb-9d89-44be-996a-2eaab11928f4',title:'Test song',style:'Folk',lyrics:'Original lyrics',abc:'',mode:'full',seed:1,maxTokens:250,steps:8,temperature:1};
function fixture(t,{corrupt=false,lost=false,cancel=false}={}){
  mkdirSync(parent,{recursive:true});const dir=mkdtempSync(path.join(parent,'queue-song-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const audio=Buffer.alloc(4*1048576+51,23);audio.write('RIFF');audio.write('WAVE',8);const calls=[];let i=0;const pending=new Map();
  const fetcher=async(url,options)=>{
    calls.push({url,options});assert.equal(new URL(url).origin,'https://api.runpod.ai');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer private-key');
    const route=new URL(url).pathname.split('/').slice(3).join('/');let result;
    if(route==='run'){
      if(lost)throw new Error('private-key');const input=JSON.parse(options.body).input;const id='remote-'+(++i);pending.set(id,input);result={id,status:'IN_QUEUE'};
    }else if(route.startsWith('status/')){
      const input=pending.get(route.slice(7));if(cancel)result={status:'IN_PROGRESS'};
      else if(input.operation==='audio-chunk')result={status:'COMPLETED',output:{offset:input.offset,audioBase64:audio.subarray(input.offset,input.offset+4*1048576).toString('base64')}};
      else result={status:'COMPLETED',output:{protocol:'yue2-studio/queue/v1',ticket:'a'.repeat(64),bytes:audio.length,chunkBytes:4*1048576,sha256:corrupt?'0'.repeat(64):createHash('sha256').update(audio).digest('hex'),abc:'X:1\nK:C\nCDEF',truncated:false}};
    }else if(route.startsWith('cancel/'))result={status:'CANCELLED'};else throw new Error('Unexpected route '+route);
    return new Response(JSON.stringify(result));
  };
  return {dir,audio,calls,client:createRunpodQueueClient({fetcher,pollMs:5}),config:{endpointId:'songendpoint',key:'private-key'}};
}
test('serverless song client transfers multiple verified WAV chunks and submits generation once',async t=>{
  const f=fixture(t);const result=await f.client.run(song,f.dir,f.config);
  assert.deepEqual(readFileSync(path.join(f.dir,'audio.wav')),f.audio);assert.ok(result.abc.includes('CDEF'));
  const submits=f.calls.filter(c=>c.url.endsWith('/run')).map(c=>JSON.parse(c.options.body).input);
  assert.equal(submits.filter(s=>!s.operation).length,1);assert.equal(submits[0].lyrics,song.lyrics);assert.deepEqual(submits.slice(1).map(s=>s.offset),[0,4*1048576]);
});
test('serverless song client removes corrupt output and never retries an ambiguous paid submission',async t=>{
  const f=fixture(t,{corrupt:true});await assert.rejects(f.client.run(song,f.dir,f.config),/integrity/);assert.equal(existsSync(path.join(f.dir,'audio.wav')),false);
  const lost=fixture(t,{lost:true});await assert.rejects(lost.client.run(song,lost.dir,lost.config),/may still be running/);assert.equal(lost.calls.length,1);
});
test('cancelling a song cancels its remote queue job; invalid endpoint never receives a key',async t=>{
  const f=fixture(t,{cancel:true});const controller=new AbortController();setTimeout(()=>controller.abort(new Error('User cancelled')),40);
  await assert.rejects(f.client.run(song,f.dir,f.config,{signal:controller.signal}),/User cancelled/);assert.ok(f.calls.some(c=>c.url.endsWith('/cancel/remote-1')));
  const n=f.calls.length;await assert.rejects(f.client.health({...f.config,endpointId:'../evil'}));assert.equal(f.calls.length,n);
});
import {spawnSync} from 'node:child_process';
const python=process.env.TEST_PYTHON??path.join(process.env.USERPROFILE,'.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe');
test('actual Python queue handler preserves lyrics, caches a completed song, and validates recording tickets',{skip:!existsSync(python)},()=>{
  const code=`
import sys, tempfile, pathlib, types, os, json, base64, uuid
sys.path.insert(0, str(pathlib.Path('cloud').resolve()))
os.environ['YUE2_WORKER_TOKEN']='test_secret_'+'x'*32
with tempfile.TemporaryDirectory(dir='.test-tmp') as directory:
 os.environ['YUE2_ROOT']=directory
 # Windows lacks flock; production uses Linux's cross-worker file lock.
 sys.modules['fcntl']=types.SimpleNamespace(LOCK_EX=2,flock=lambda *args:None)
 import yue2_serverless as q
 q.worker.state['ready']=True
 calls=[]
 def generate(status,data):
  calls.append(dict(data)); dest=q.worker.ROOT/'jobs'/data['id'];dest.mkdir(parents=True)
  (dest/'audio.wav').write_bytes(b'RIFF'+bytes(4)+b'WAVE'+bytes(64))
  status.update(status='completed',abc='X:1\\nK:C\\nCDEF',truncated=True)
 q.worker.generate=generate
 song=json.loads(sys.argv[1]); first=q.handler({'input':song}); second=q.handler({'input':song})
 assert first==second and len(calls)==1 and calls[0]['lyrics']==song['lyrics']
 assert first['truncated'] and first['abc'].endswith('CDEF')
 chunk=q.handler({'input':{'operation':'audio-chunk','id':song['id'],'ticket':first['ticket'],'offset':0}})
 assert base64.b64decode(chunk['audioBase64']).startswith(b'RIFF')
 for request in [{'operation':'audio-chunk','id':song['id'],'ticket':'bad','offset':0},{**song,'lyrics':'Changed'}]:
  try:q.handler({'input':request})
  except ValueError:pass
  else:raise AssertionError('Invalid request accepted')
 interrupted={**song,'id':str(uuid.uuid4())};target=q.worker.ROOT/'queue-jobs'/interrupted['id'];target.mkdir();(target/'started.json').write_text('{}')
 try:q.handler({'input':interrupted})
 except RuntimeError:pass
 else:raise AssertionError('Interrupted job regenerated')
 assert len(calls)==1
`;
  const result=spawnSync(python,['-c',code,JSON.stringify({...song,steps:8,temperature:1,maxTokens:250,seed:1})],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
