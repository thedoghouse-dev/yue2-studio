import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const render=source.slice(source.indexOf('function renderRoom()'),source.indexOf('function renderRecent()'));
function fixture(){
 const room={dataset:{},innerHTML:'',querySelector:()=>null};let writes=0,content='';Object.defineProperty(room,'innerHTML',{get:()=>content,set:value=>{writes++;content=value;}});
 const old={id:'old',title:'Previous song',status:'completed',hasAudio:true,seed:1234,mode:'full'},active={id:'new',title:'New song',status:'running',stage:'Generating',seed:1234,mode:'full'};
 const context=vm.createContext({studio:{songs:[old]},selected:null,preparingSong:false,$:()=>room,elapsed:()=>'',escape:String,badge:s=>s.status,actions:()=>'',link:()=>'/audio'});vm.runInContext(render,context);
 return {context,room,active,get writes(){return writes;},render:()=>vm.runInContext('renderRoom()',context)};
}
test('new drafts never fall back to previous recordings, while current generation appears',()=>{
 const f=fixture();f.render();assert.match(f.room.innerHTML,/Your next song/);assert.ok(!f.room.innerHTML.includes('<audio'));
 f.context.studio.songs.unshift(f.active);f.context.preparingSong=true;f.render();assert.match(f.room.innerHTML,/Your next song/);
 f.context.selected='new';f.context.preparingSong=false;f.render();assert.match(f.room.innerHTML,/New song/);assert.match(f.room.innerHTML,/Generating/);
});
test('explicit playback survives polling and selecting it again after clearing rebuilds its player',()=>{
 const f=fixture();f.context.selected='old';f.render();assert.match(f.room.innerHTML,/<audio/);const writes=f.writes;f.render();assert.equal(f.writes,writes);
 f.context.preparingSong=true;f.context.selected=null;f.render();assert.ok(!f.room.innerHTML.includes('<audio'));
 f.context.preparingSong=false;f.context.selected='old';f.render();assert.match(f.room.innerHTML,/<audio/);assert.match(f.room.innerHTML,/Previous song/);
});
