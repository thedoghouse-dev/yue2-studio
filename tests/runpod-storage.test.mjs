import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {estimateVolumeStorage,createRunpodManagement} from '../runpod-management.mjs';

test('storage projections use allocated size and tier and distinguish unknown pricing',()=>{
 assert.equal(estimateVolumeStorage({size:200,type:'STANDARD'}).monthly.toFixed(2),'14.00');
 assert.equal(estimateVolumeStorage({size:200,type:'HIGH_PERFORMANCE'}).monthly.toFixed(2),'28.00');
 assert.equal(estimateVolumeStorage({size:2048,type:'STANDARD'}).monthly.toFixed(2),'102.40');
 assert.equal(estimateVolumeStorage({size:200,type:'UNKNOWN'}),null);
 assert.equal(estimateVolumeStorage({size:-1,type:'STANDARD'}),null);
});
test('volume activity is scoped to the requested worker, survives restart, and never counts a refresh as usage',t=>{
 const parent=path.resolve('.test-tmp');mkdirSync(parent,{recursive:true});const root=mkdtempSync(path.join(parent,'volume-'));const data=path.join(root,'data');mkdirSync(data);t.after(()=>rmSync(root,{recursive:true,force:true}));
 const db={pods:[{id:'pod',volumeId:'vol',createdAt:'2026-10-01T12:00:00Z'}],endpoints:[{id:'endpoint',volumeId:'vol'}],plans:[],inventory:{pods:[{id:'pod',volumeId:'vol',name:'GPU',status:'EXITED'}],volumes:[{id:'vol',size:200,type:'STANDARD'},{id:'other',size:50,type:'STANDARD'}],endpoints:[{id:'endpoint',volumeIds:['vol'],name:'Songs',maxWorkers:0}]}};
 writeFileSync(path.join(data,'runpod-management.json'),JSON.stringify(db));
 const m=createRunpodManagement({root,data});assert.equal(m.state().inventory.volumes[0].lastStudioActivity.reason,'Model setup launched');assert.equal(m.state().inventory.volumes[1].lastStudioActivity,null);assert.equal(m.state().inventory.volumes[0].attachments.length,2);
 m.recordUsage({endpointId:'endpoint'},'Song generation requested');const activity=m.state().inventory.volumes[0].lastStudioActivity;assert.equal(activity.reason,'Song generation requested');assert.equal(m.state().inventory.volumes[1].lastStudioActivity,null);
 m.recordUsage({endpointId:'unrelated'},'Video generation requested');assert.deepEqual(m.state().inventory.volumes[0].lastStudioActivity,activity);
 const restored=createRunpodManagement({root,data});assert.deepEqual(restored.state().inventory.volumes[0].lastStudioActivity,activity);
 restored.recordUsage({url:'https://pod-8000.proxy.runpod.net'},'Song generation requested');assert.equal(restored.state().inventory.volumes[0].lastStudioActivity.reason,'Song generation requested');
});
