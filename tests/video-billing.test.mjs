import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createStudio} from '../server.mjs';
import {createVideoProviders} from '../video-providers.mjs';

test('fal billing uses the separate key and matches request IDs and endpoint exactly',async()=>{
  const calls=[];const provider=createVideoProviders({fetcher:async(url,options)=>{calls.push({url,options});return Response.json({billing_events:[{request_id:'a',endpoint_id:'model',cost_total:1.2,timestamp:'now'},{request_id:'other',endpoint_id:'model',cost_total:100},{request_id:'a',endpoint_id:'wrong',cost_total:100}],has_more:false,next_cursor:null});}});
  const events=await provider.billing({falKey:'generation',falBillingKey:'billing'}, {createdAt:new Date().toISOString(),model:'model',clips:[{remote:{id:'a'}},{remote:{id:'b'}}]});
  assert.equal(events.length,1);assert.equal(events[0].costUSD,1.2);assert.equal(calls[0].options.headers.Authorization,'Key billing');assert.equal(calls[0].options.redirect,'error');assert.match(calls[0].url,/request_id=a%2Cb/);
});

test('billing totals and elapsed time persist, partial billing remains marked, and keys stay private',async t=>{
  const parent=path.resolve('.test-tmp');mkdirSync(parent,{recursive:true});const root=mkdtempSync(path.join(parent,'billing-')),id=randomUUID();mkdirSync(path.join(root,'data','videos'),{recursive:true});
  const job={id,provider:'fal',model:'model',title:'Test',status:'completed',createdAt:'2026-10-08T00:00:00Z',startedAt:'2026-10-08T00:00:00Z',finishedAt:'2026-10-08T00:02:00Z',clips:[{remote:{id:'a'}},{remote:{id:'b'}}]};
  writeFileSync(path.join(root,'data','videos','workspace.json'),JSON.stringify({jobs:[job]}));let app,url,token,complete=false;
  const providers={billing:async(config)=>{assert.equal(config.falBillingKey,'admin-private');return [{requestId:'a',costUSD:1.25},...(complete?[{requestId:'b',costUSD:2}]:[])];}};
  async function start(){app=createStudio({root,videoProviders:providers});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${app.server.address().port}`;token=(await(await fetch(url+'/api/studio')).json()).token;}
  t.after(async()=>{if(app?.server.listening)await app.close();assert.ok(root.startsWith(parent+path.sep));rmSync(root,{recursive:true,force:true});});await start();
  const request=(route,method='GET',body)=>fetch(url+route,{method,headers:{'X-Studio-Token':token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal((await fetch(url+'/api/videos/billing/sync',{method:'POST',body:'{}'})).status,403);
  await request('/api/videos/connection','PUT',{falBillingKey:'admin-private'});
  const privateState=await(await request('/api/studio')).json();assert.equal(JSON.stringify(privateState).includes('admin-private'),false);assert.equal(privateState.videos.connection.billingConfigured,true);assert.equal(privateState.videos.jobs[0].elapsedSeconds,120);
  assert.equal((await request('/api/videos/billing/sync','POST',{})).status,200);let state=await(await request('/api/videos/state')).json();assert.equal(state.jobs[0].billing.actualCost,1.25);assert.equal(state.jobs[0].billing.complete,false);
  complete=true;await request('/api/videos/billing/sync','POST',{});state=await(await request('/api/videos/state')).json();assert.equal(state.jobs[0].billing.actualCost,3.25);assert.equal(state.jobs[0].billing.complete,true);
  await app.close();await start();state=await(await request('/api/videos/state')).json();assert.equal(state.jobs[0].billing.actualCost,3.25);assert.equal(state.connection.billingConfigured,true);
});
