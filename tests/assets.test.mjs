import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAssetGraph,connectedAssets,lyricUsage} from '../public/assets.js';
import {validateSong} from '../server.mjs';

test('provenance connects edited drafts, scores, multiple songs, and videos without linking unrelated assets',()=>{
 const state={lyricSessions:[{id:'l',title:'Draft',lyrics:'edited'},{id:'other',title:'Draft',lyrics:'other'}],transcriptions:[{id:'t',title:'Humming'}],songs:[{id:'s',title:'Song',lyrics:'original',lyricSource:'l',abc:'notes',scoreSource:'transcription:t',status:'completed'},{id:'queued',lyricSource:'l',status:'queued'}],videos:{jobs:[{id:'v',songId:'s',title:'Video'}]}};
 const graph=connectedAssets(buildAssetGraph(state),'video:v');
 assert.deepEqual(new Set(graph.nodes.map(n=>n.id)),new Set(['lyrics:l','sheet:t','song:s','song:queued','video:v']));
 assert.equal(lyricUsage(state,'l').length,1);
 assert.ok(graph.edges.every(e=>!e.inferred));
});
test('legacy links require exact nonempty content, never matching titles',()=>{
 const state={lyricSessions:[{id:'l',title:'Different name',lyrics:' [Verse]\r\nHello '},{id:'no',title:'Song',lyrics:'different'},{id:'empty',lyrics:''}],transcriptions:[{id:'t'}],songs:[{id:'s',title:'Song',lyrics:'[Verse]\nHello',abc:' notes ',status:'completed'},{id:'instrumental',lyrics:'',status:'completed'}]};
 const graph=buildAssetGraph(state,new Map([['t','notes']]));
 assert.equal(graph.edges.length,2);assert.ok(graph.edges.every(e=>e.inferred));assert.equal(lyricUsage(state,'l').length,1);assert.equal(lyricUsage(state,'no').length,0);assert.equal(lyricUsage(state,'empty').length,0);
});
test('Trash keeps relationships; explicit references do not create phantom or contradictory links',()=>{
 const state={lyricSessions:[{id:'a',lyrics:'same'},{id:'b',lyrics:'same'}],songTrash:[{id:'s',lyrics:'same',lyricSource:'a',deletedAt:'now',status:'completed'}],videos:{trash:[{id:'v',songId:'s',deletedAt:'now'},{id:'missing',songId:'missing'}]}};
 const graph=connectedAssets(buildAssetGraph(state),'video:v');assert.equal(graph.nodes.length,3);assert.equal(graph.edges.length,2);assert.equal(graph.nodes.filter(n=>n.trashed).length,2);
});
test('song validation preserves bounded source references and rejects malformed identifiers',()=>{
 const input={title:'Song',style:'folk',lyrics:'words',lyricSource:'12345678-1234-1234-1234-123456789abc',scoreSource:'transcription:12345678-1234-1234-1234-123456789abc',abc:'notes'};
 const value=validateSong(input);assert.equal(value.lyricSource,input.lyricSource);assert.equal(value.scoreSource,input.scoreSource);
 assert.throws(()=>validateSong({...input,lyricSource:'../../secret'}));assert.throws(()=>validateSong({...input,scoreSource:'file:secret'}));
});
