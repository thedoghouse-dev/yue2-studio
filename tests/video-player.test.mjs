import test from 'node:test';
import assert from 'node:assert/strict';
import { renderVideoJobs, filterVideoLibrary } from '../public/videos.js';

// Minimal DOM fixture records media replacement and node identity.
class Element {
  constructor(document){this.ownerDocument=document;this.dataset={};this.children=[];this.fields=new Map();this.html='';this.textContent='';}
  set innerHTML(value){
    this.html=value;this.children=[];this.fields.clear();
    for(const match of value.matchAll(/data-(job-[a-z]+)/g))this.fields.set('[data-'+match[1]+']',new Element(this.ownerDocument));
    if(value.includes('<video '))this.children.push({tagName:'VIDEO',currentTime:0,paused:true});
  }
  get innerHTML(){return this.html;}
  querySelector(selector){return this.fields.get(selector);}
  replaceChildren(){for(const child of this.children)child.parent=null;this.children=[];}
  insertBefore(child,next){if(child.parent)child.parent.children.splice(child.parent.children.indexOf(child),1);const index=next?this.children.indexOf(next):this.children.length;this.children.splice(index,0,child);child.parent=this;}
  remove(){this.parent?.children.splice(this.parent.children.indexOf(this),1);this.parent=null;}
}
function fixture(){const document={createElement:()=>new Element(document)};return new Element(document);}
const completed={id:'finished',status:'completed',stage:'Ready to watch',title:'Rusty test',model:'h3',scope:'preview',count:1,hasVideo:true,clips:[]};
const working={id:'working',status:'running',stage:'Scene 6 of 22',title:'Rusty',model:'h3',scope:'full',count:22,hasVideo:false,clips:[]};

test('scene progress preserves the existing video element and playback state',()=>{
  const container=fixture();renderVideoJobs(container,[working,completed],[{id:'h3',name:'MiniMax H3'}]);
  const card=container.children[1],media=card.querySelector('[data-job-media]'),video=media.children[0];video.currentTime=3.2;video.paused=false;
  for(let scene=7;scene<=22;scene++)renderVideoJobs(container,[{...working,stage:`Scene ${scene} of 22`,clips:Array.from({length:scene-1},()=>({completed:true}))},completed],[{id:'h3',name:'MiniMax H3'}]);
  assert.equal(container.children[1],card);assert.equal(media.children[0],video);assert.equal(video.currentTime,3.2);assert.equal(video.paused,false);
  assert.equal(container.children[0].querySelector('[data-job-stage]').textContent,'Scene 22 of 22');
});
test('completion adds only the new player and adding another job preserves older players',()=>{
  const container=fixture();renderVideoJobs(container,[working,completed],[]);const oldPlayer=container.children[1].querySelector('[data-job-media]').children[0];
  renderVideoJobs(container,[{...working,status:'completed',stage:'Ready to watch',hasVideo:true},completed],[]);
  const newPlayer=container.children[0].querySelector('[data-job-media]').children[0];assert.ok(newPlayer);assert.equal(container.children[1].querySelector('[data-job-media]').children[0],oldPlayer);
  renderVideoJobs(container,[{...working,id:'next',stage:'Scene 1 of 22'}, {...working,status:'completed',hasVideo:true},completed],[]);
  assert.equal(container.children[1].querySelector('[data-job-media]').children[0],newPlayer);assert.equal(container.children[2].querySelector('[data-job-media]').children[0],oldPlayer);
});


test('video library filters by linked song project, search and generation status',()=>{
  const songs=[{id:'rusty',title:'Rusty',projectId:'dogs'},{id:'beauty',title:'Beauty',projectId:'dogs'},{id:'other',title:'Other'}];
  const jobs=[{...completed,songId:'rusty',prompt:'Winter forest'},{...working,songId:'beauty'},{...working,id:'failed',songId:'other',status:'failed'}];
  assert.equal(filterVideoLibrary(jobs,songs).length,3);
  assert.deepEqual(filterVideoLibrary(jobs,songs,{project:'dogs'}).map(j=>j.id),['finished','working']);
  assert.deepEqual(filterVideoLibrary(jobs,songs,{search:'forest',project:'dogs',status:'completed'}).map(j=>j.id),['finished']);
  assert.deepEqual(filterVideoLibrary(jobs,songs,{project:'',status:'attention'}).map(j=>j.id),['failed']);
  assert.deepEqual(filterVideoLibrary(jobs,songs,{status:'active'}).map(j=>j.id),['working']);
  assert.equal(filterVideoLibrary(jobs,songs,{search:'missing'}).length,0);
});

test('gallery thumbnails and playback survive scene and project updates',()=>{
  const container=fixture();renderVideoJobs(container,[working,{...completed,projectName:'Dogs'}],[],{gallery:true});
  const card=container.children[1],media=card.querySelector('[data-job-media]'),player=media.children[0];
  assert.match(media.innerHTML,/poster="\/api\/videos\/finished\/thumbnail"/);player.currentTime=3;
  renderVideoJobs(container,[{...working,stage:'Scene 7 of 22'},{...completed,projectName:'Renamed'}],[],{gallery:true});
  assert.equal(media.children[0],player);assert.equal(player.currentTime,3);assert.match(card.querySelector('[data-job-summary]').textContent,/Renamed/);
  assert.match(card.querySelector('[data-job-actions]').innerHTML,/Create another video/);
});


test('gallery offers delete only for idle videos and restore for trashed videos',()=>{
  const container=fixture();renderVideoJobs(container,[working,completed],[],{gallery:true});
  assert.doesNotMatch(container.children[0].querySelector('[data-job-actions]').innerHTML,/data-video-delete/);
  assert.match(container.children[1].querySelector('[data-job-actions]').innerHTML,/data-video-delete="finished"/);
  renderVideoJobs(container,[{...completed,deletedAt:new Date().toISOString()}],[],{gallery:true});
  assert.match(container.children[0].querySelector('[data-job-actions]').innerHTML,/data-video-restore="finished"/);
  assert.doesNotMatch(container.children[0].querySelector('[data-job-actions]').innerHTML,/data-video-delete|data-video-song/);
  assert.equal(container.children[0].querySelector('[data-job-stage]').textContent,'In Trash');
});


test('explicit video projects override song membership without changing the song',()=>{
  const songs=[{id:'source',projectId:'album'}],jobs=[{...completed,songId:'source',projectId:'film'},{...completed,id:'unassigned',songId:'source',projectId:''},{...completed,id:'follow',songId:'source'}];
  assert.deepEqual(filterVideoLibrary(jobs,songs,{project:'film'}).map(j=>j.id),['finished']);
  assert.deepEqual(filterVideoLibrary(jobs,songs,{project:''}).map(j=>j.id),['unassigned']);
  assert.deepEqual(filterVideoLibrary(jobs,songs,{project:'album'}).map(j=>j.id),['follow']);
  assert.equal(songs[0].projectId,'album');
  const container=fixture();renderVideoJobs(container,[jobs[0]],[],{gallery:true,projects:[{id:'film',name:'Film'}]});
  assert.match(container.children[0].querySelector('[data-job-project]').innerHTML,/value="film" selected/);
  const player=container.children[0].querySelector('[data-job-media]').children[0];
  renderVideoJobs(container,[{...jobs[0],projectId:''}],[],{gallery:true,projects:[]});assert.equal(container.children[0].querySelector('[data-job-media]').children[0],player);
});
