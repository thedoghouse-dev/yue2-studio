import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setupRunpod} from '../public/runpod.js';

function fixture(t,{reject=false,refreshFails=false}={}) {
 const elements=new Map();
 const element=id=>{if(!elements.has(id))elements.set(id,{value:'',checked:false,hidden:false,disabled:false,textContent:'',innerHTML:'',classList:{toggle(){}},listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},querySelector(){return {disabled:false};},focus(){},scrollIntoView(){}});return elements.get(id);};
 for(const [,id] of readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/id="([^"]+)"/g))element(id);
 const originals={document:globalThis.document,setInterval:globalThis.setInterval};
 globalThis.document={getElementById:element,addEventListener(){}};globalThis.setInterval=()=>0;
 t.after(()=>{globalThis.document=originals.document;globalThis.setInterval=originals.setInterval;});
 element('rp-workload').value='yue2-serverless';element('rp-storage').value='existing';element('rp-gpu').value='__auto__';element('rp-max-workers').value='10';element('rp-auto-rate').value='2';
 const plans=[],plan={id:'plan',status:'review',workload:'yue2-serverless',gpuName:'Automatic',gpuCount:1,hourly:1,storage:'existing',maxWorkers:10};
 let finish,submissions=0;const pending=new Promise(resolve=>finish=resolve);
 setupRunpod({getStudio:()=>({runpodManagement:{configured:true,plans}}),refresh:async()=>{},toast(){},api:async(route)=>{
  if(route.endsWith('/review')){plans.push(plan);return plan;}
  if(route.endsWith('/deploy')){submissions++;await pending;if(reject){plan.status='unknown';plan.error='RunPod did not acknowledge this change.';throw new Error(plan.error);}Object.assign(plan,{status:'deployed',endpointId:'endpoint'});return {...plan};}
  if(route.endsWith('/refresh')&&refreshFails)throw new Error('Cannot reach RunPod.');return {};
 }});
 return {element,finish,get submissions(){return submissions;}};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,15));
async function launch(f){f.element('rp-plan-form').listeners.submit({preventDefault(){}});await settle();f.element('rp-paid').checked=true;f.element('rp-launch').listeners.click();await settle();}

test('launch feedback remains visible while pending and after confirmation, without duplicate submits',async t=>{
 const f=fixture(t);await launch(f);assert.equal(f.element('rp-launch').disabled,true);assert.equal(f.element('rp-cancel-review').disabled,true);assert.match(f.element('rp-launch-result').textContent,/Waiting for RunPod/);
 f.element('rp-launch').listeners.click();assert.equal(f.submissions,1);f.finish();await settle();assert.equal(f.element('rp-launch-review').hidden,true);assert.equal(f.element('rp-launch-result').hidden,false);assert.match(f.element('rp-launch-result').innerHTML,/Serverless setup created/);assert.match(f.element('rp-launch-result').innerHTML,/Workers start for that request/);
});
test('unacknowledged launch displays its error beside the apply button and preserves uncertainty',async t=>{
 const f=fixture(t,{reject:true});await launch(f);f.finish();await settle();assert.equal(f.element('rp-launch-error').hidden,false);assert.match(f.element('rp-launch-error').textContent,/did not acknowledge/);assert.equal(f.element('rp-error').hidden,true);assert.match(f.element('rp-launch-result').innerHTML,/Setup could not be confirmed/);assert.match(f.element('rp-launch-result').innerHTML,/duplicate resources/);
});
test('failed inventory refresh preserves a successful launch result',async t=>{
 const f=fixture(t,{refreshFails:true});await launch(f);f.finish();await settle();assert.equal(f.element('rp-launch-result').hidden,false);assert.match(f.element('rp-launch-result').innerHTML,/Serverless setup created/);assert.equal(f.element('rp-launch-error').hidden,true);assert.match(f.element('rp-launch-result').innerHTML,/refreshing resources failed/);
});
