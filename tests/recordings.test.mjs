import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {recording,safeMedia,createRecordingSource} from '../recordings.mjs';
import {createStudio} from '../server.mjs';
const root=path.resolve(import.meta.dirname,'..');
function page(license='Public domain',code='pd',copyright='False') {
 return {pageid:123,ns:6,title:'File:Song.ogg',imageinfo:[{url:'https://upload.wikimedia.org/wikipedia/commons/a/ab/Song.ogg',mime:'application/ogg',size:100,width:0,height:0,extmetadata:{LicenseShortName:{value:license},License:{value:code},Copyrighted:{value:copyright},Artist:{value:'<b>Artist</b>'}}}]};
}
test('only eligible recording labels and approved audio URLs pass; failed downloads leave no file',async()=>{
 assert.equal(recording(page()).license,'Public domain');assert.equal(recording(page('CC0','cc-zero','True')).license,'CC0 1.0');
 for(const p of [page('CC BY 4.0','cc-by-4.0','True'),page('Public domain','pd','True'),page('Unknown','unknown','False')])assert.equal(recording(p),null);
 const disputed=page();disputed.imageinfo[0].extmetadata.Categories={value:'License review needed (audio)'};assert.equal(recording(disputed),null);
 for(const url of ['http://upload.wikimedia.org/wikipedia/commons/a.mp3','https://localhost/a.mp3','https://upload.wikimedia.org.evil.test/wikipedia/commons/a.mp3','https://user@upload.wikimedia.org/wikipedia/commons/a.mp3'])assert.throws(()=>safeMedia(url));
 const source=createRecordingSource(async()=>new Response(Buffer.alloc(20),{headers:{'content-type':'audio/ogg'}}));
 const parent=path.join(root,'.test-tmp');mkdirSync(parent,{recursive:true});const temp=mkdtempSync(path.join(parent,'download-'));const file=path.join(temp,'audio.ogg');
 try{await assert.rejects(source.download(recording(page()),file),/incomplete/);const {existsSync}=await import('node:fs');assert.equal(existsSync(file),false);}finally{rmSync(temp,{recursive:true,force:true});}
});
test('song search, authenticated download, metadata persistence and SheetSage handoff',async t=>{
 const parent=path.join(root,'.test-tmp');mkdirSync(parent,{recursive:true});const temp=mkdtempSync(path.join(parent,'finder-'));
 let resolved=0;const item=recording(page());
 const source={search:async query=>({results:query==='Song'?[item]:[],scanned:1}),resolve:async id=>{assert.equal(id,123);resolved++;return item;},download:async(_item,file)=>{writeFileSync(file,Buffer.alloc(100,'a'));return 100;}};
 const options={root:temp,recordingSource:source,checkSheetSage:()=>({ready:true,missing:[]}),spawnRunner:(_exe,args,opts)=>spawn(process.execPath,[path.join(root,'tests','fixture-cli.mjs'),...args],{...opts,cwd:temp})};
 let app=createStudio(options);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));let base=`http://127.0.0.1:${app.server.address().port}`;
 t.after(async()=>{await app.close();assert.ok(temp.startsWith(parent+path.sep));rmSync(temp,{recursive:true,force:true});});
 const token=(await(await fetch(base+'/api/studio')).json()).token;
 const post=(route,data)=>fetch(base+route,{method:'POST',headers:{'X-Studio-Token':token,'Content-Type':'application/json'},body:JSON.stringify(data)});
 assert.equal((await fetch(base+'/api/recordings',{method:'POST',body:'{}'})).status,403);
 assert.equal((await(await post('/api/recordings/search',{query:'Song'})).json()).results.length,1);
 assert.equal((await post('/api/recordings',{pageId:'https://localhost/'})).status,400);
 const saved=await(await post('/api/recordings',{pageId:123})).json();assert.ok(saved.id);
 await post('/api/recordings',{pageId:123});assert.equal(resolved,1);
 const audio=await fetch(base+`/api/recordings/${saved.id}/audio?download`);assert.match(audio.headers.get('content-disposition'),/attachment/);assert.equal(audio.headers.get('content-type'),'audio/ogg');assert.equal((await audio.arrayBuffer()).byteLength,100);
 const metadata=await(await fetch(base+`/api/recordings/${saved.id}/source`)).json();assert.equal(metadata.pageId,123);
 const job=await(await post(`/api/recordings/${saved.id}/transcribe`,{})).json();assert.equal(job.recordingId,saved.id);
 let finished=false;for(let i=0;i<100;i++){const db=await(await fetch(base+'/api/studio')).json();if(db.transcriptions[0].status==='completed'){finished=true;break;}await new Promise(r=>setTimeout(r,25));}assert.ok(finished);
 await app.close();app=createStudio(options);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;assert.equal((await(await fetch(base+'/api/studio')).json()).recordings[0].id,saved.id);
});
