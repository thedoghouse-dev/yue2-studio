const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const normalized = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();

// Explicit provenance survives later edits. Older records are only matched by content.
export function buildAssetGraph(studio = {}, scores = new Map()) {
  const nodes = [], edges = [];
  const songs = [...(studio.songs ?? []), ...(studio.songTrash ?? [])];
  const lyrics = studio.lyricSessions ?? [], sheets = studio.transcriptions ?? [];
  const add = (type, asset) => nodes.push({id:`${type}:${asset.id}`,assetId:asset.id,type,title:asset.title,trashed:Boolean(asset.deletedAt),status:asset.status,date:asset.createdAt ?? asset.updatedAt});
  const legacyLyrics = new Map();
  for(const draft of lyrics) {
    const content=normalized(draft.lyrics);if(!content)continue;
    if(!legacyLyrics.has(content))legacyLyrics.set(content,[]);
    legacyLyrics.get(content).push(draft.id);
  }
  lyrics.forEach(s => add('lyrics',s)); sheets.forEach(s => add('sheet',s)); songs.forEach(s => add('song',s));
  [...(studio.videos?.jobs ?? []),...(studio.videos?.trash ?? [])].forEach(s => add('video',s));
  const ids = new Set(nodes.map(n => n.id));
  const connect = (from,to,label,inferred=false) => {if(ids.has(from) && ids.has(to) && !edges.some(e=>e.from===from && e.to===to)) edges.push({from,to,label,inferred});};
  for (const song of songs) {
    const target = `song:${song.id}`;
    if(song.lyricSource) connect(`lyrics:${song.lyricSource}`,target,'Lyrics source');
    else for(const id of legacyLyrics.get(normalized(song.lyrics)) ?? []) connect(`lyrics:${id}`,target,'Matching lyrics',true);
    if(song.abc && song.scoreSource?.startsWith('transcription:')) connect(song.scoreSource.replace('transcription:','sheet:'),target,'Sheet music source');
    else if(song.abc && song.scoreSource?.startsWith('song:')) connect(song.scoreSource,target,'Score reused');
    else if(normalized(song.abc)) for(const sheet of sheets) {
      if(normalized(scores.get(sheet.id)) === normalized(song.abc)) connect(`sheet:${sheet.id}`,target,'Matching score',true);
    }
  }
  for(const video of [...(studio.videos?.jobs ?? []),...(studio.videos?.trash ?? [])]) connect(`song:${video.songId}`,`video:${video.id}`,video.masterId?'Mastered soundtrack':'Soundtrack');
  return {nodes,edges};
}

export function connectedAssets(graph, root) {
  const found = new Set([root]);
  let changed = true;
  while(changed) {changed=false;for(const edge of graph.edges) if(found.has(edge.from)||found.has(edge.to)) for(const id of [edge.from,edge.to]) if(!found.has(id)){found.add(id);changed=true;}}
  return {nodes:graph.nodes.filter(n=>found.has(n.id)),edges:graph.edges.filter(e=>found.has(e.from)&&found.has(e.to))};
}

export function lyricUsage(studio, id, graph = buildAssetGraph(studio)) {
  const songIds = new Set(graph.edges.filter(e=>e.from===`lyrics:${id}`).map(e=>e.to));
  return [...(studio?.songs??[]),...(studio?.songTrash??[])].filter(s=>songIds.has(`song:${s.id}`)&&s.status==='completed');
}

export function setupAssetConnections({getStudio,api,toast,navigate}) {
  const $ = id => document.getElementById(id), scores = new Map();
  let generation = 0, activeGraph;
  $('asset-close').addEventListener('click',()=>$('asset-dialog').close());
  $('asset-dialog').addEventListener('close',()=>generation++);
  function draw(root, state = getStudio()) {
    activeGraph = connectedAssets(buildAssetGraph(state,scores),root);
    const selected = activeGraph.nodes.find(n=>n.id===root);
    $('asset-heading').textContent = selected ? `Connections · ${selected.title}` : 'Related assets';
    $('asset-summary').textContent = activeGraph.edges.length ? `${activeGraph.nodes.length} connected assets. Open a card to explore it.` : 'No saved connections found yet. Create a song from a saved lyric draft or score to connect them.';
    const types = ['lyrics','sheet','song','video'].filter(type=>activeGraph.nodes.some(n=>n.type===type));
    const labels = {lyrics:'LYRICS',sheet:'SHEET MUSIC',song:'SONGS',video:'VIDEOS'};
    const positions = new Map(), width = Math.max(300,types.length*330), height = Math.max(200,...types.map(t=>activeGraph.nodes.filter(n=>n.type===t).length*96+65));
    let cards = '';
    types.forEach((type,column)=>{
      cards+=`<span class="asset-column" style="left:${column*330+20}px">${labels[type]}</span>`;
      activeGraph.nodes.filter(n=>n.type===type).forEach((node,row)=>{
        const x=column*330+20,y=row*96+50;positions.set(node.id,{x,y});
        cards+=`<button class="asset-node ${node.id===root?'selected':''}" style="left:${x}px;top:${y}px" type="button" data-asset-open="${escape(node.id)}"><small>${labels[type]}${node.trashed?' · TRASH':''}</small><strong>${escape(node.title)}</strong><span>${node.date?escape(new Date(node.date).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))+' · ':''}Open ↗</span></button>`;
      });
    });
    const lines=activeGraph.edges.map(edge=>{
      const a=positions.get(edge.from),b=positions.get(edge.to),same=a.x===b.x;
      const x1=a.x+220,y1=a.y+40,x2=same?b.x+220:b.x,y2=b.y+40;
      return `<path marker-end="url(#asset-arrow)" class="${edge.inferred?'inferred':''}" d="M ${x1} ${y1} C ${x1+35} ${y1}, ${same?x2+35:x2-35} ${y2}, ${x2} ${y2}"/><text x="${same?x1+4:(x1+x2)/2}" y="${(y1+y2)/2-8}" text-anchor="${same?'start':'middle'}">${escape(edge.label)}</text>`;
    }).join('');
    $('asset-chart').innerHTML=`<div class="asset-canvas" style="width:${width}px;height:${height}px"><svg aria-hidden="true" width="${width}" height="${height}"><defs><marker id="asset-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>${lines}</svg>${cards}</div>`;
    $('asset-relations').innerHTML=activeGraph.edges.map(edge=>{const from=activeGraph.nodes.find(n=>n.id===edge.from),to=activeGraph.nodes.find(n=>n.id===edge.to);return `<li>${escape(from.title)} (${escape(from.type)}) → ${escape(to.title)} (${escape(to.type)}): ${escape(edge.label)}</li>`;}).join('');
  }
  document.addEventListener('click',async event=>{
    const root=event.target.closest('[data-related]')?.dataset.related;if(!root)return;
    const turn=++generation; draw(root);$('asset-dialog').showModal();
    try {
      const fresh=await api('/api/studio');if(turn!==generation)return;
      const sheets=(fresh.transcriptions??[]).filter(s=>s.hasScore&&!scores.has(s.id));
      await Promise.all(sheets.map(async s=>{const response=await fetch(`/api/transcriptions/${s.id}/score`);if(!response.ok)throw new Error('Score unavailable');scores.set(s.id,await response.text());}));
      if(turn===generation&&$('asset-dialog').open) draw(root,fresh);
    } catch { /* Explicit links and lyrics still work if a legacy score cannot be read. */ }
  });
  $('asset-chart').addEventListener('click',async event=>{
    const id=event.target.closest('[data-asset-open]')?.dataset.assetOpen;if(!id)return;
    const node=activeGraph.nodes.find(n=>n.id===id);$('asset-dialog').close();
    try {await navigate(node);} catch(error) {toast(error.message);}
  });
}
