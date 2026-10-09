const $ = id => document.getElementById(id);
const escape = text => String(text ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
export function setupFinder({getStudio,api,refresh,toast,showPage,selectTranscription}) {
  let results=[],signature='',busy=new Set();
  function card(item,saved=false) {
    const prefix=`/api/recordings/${item.id}`;
    return `<article class="recording-card"><span class="status-badge">${escape(item.license)} · source label</span><h3>${escape(item.title)}</h3><p>${escape(item.creator||'Creator listed on source page')}</p><p class="recording-description">${escape(item.description)}</p><p class="field-help">${(item.bytes/1048576).toFixed(1)} MB · ${escape(item.extension.toUpperCase())}${item.duration?` · ${Math.floor(item.duration/60)}:${String(Math.floor(item.duration%60)).padStart(2,'0')}`:''}</p><div class="recording-actions"><a href="${escape(item.sourceUrl)}" target="_blank" rel="noreferrer">View source & terms ↗</a>${saved?`<a href="${prefix}/source">Source metadata ↓</a>`:''}</div>${saved?`<audio controls preload="none" src="${prefix}/audio"></audio><div class="recording-actions"><a class="primary" href="${prefix}/audio?download">Download audio ↓</a><button class="secondary" data-recording-transcribe="${item.id}" ${busy.has(item.id)?'disabled':''}>${busy.has(item.id)?'Queuing…':'Create sheet music ↗'}</button></div>`:`<button class="primary" data-recording-download="${item.pageId}" ${busy.has(item.pageId)?'disabled':''}>${busy.has(item.pageId)?'Downloading…':'Save recording locally ↓'}</button>`}</article>`;
  }
  function render() {
    if($('page-finder').hidden)return;
    const saved=getStudio()?.recordings??[];
    const next=JSON.stringify([saved,results,[...busy]]);if(signature===next)return;signature=next;
    $('finder-results').innerHTML=results.map(item=>saved.some(s=>s.pageId===item.pageId)?`<article class="recording-card"><h3>${escape(item.title)}</h3><span class="status-badge">Saved below ↓</span></article>`:card(item)).join('');
    $('finder-saved').innerHTML=saved.length?saved.map(item=>card(item,true)).join(''):'<p class="field-help">Your downloaded recordings will appear here.</p>';
  }
  function showError(error) {$('finder-error').textContent=error.message;$('finder-error').hidden=false;}
  $('finder-form').addEventListener('submit',async event=>{
    event.preventDefault();$('finder-error').hidden=true;$('finder-submit').disabled=true;$('finder-status').textContent='Searching recordings and checking source labels…';results=[];render();
    try {const data=await api('/api/recordings/search','POST',{query:$('finder-query').value});results=data.results;$('finder-status').textContent=results.length?`${results.length} eligible recording${results.length===1?'':'s'} found. Review the source terms, then save a version.`:'No eligible public-domain or CC0 recording found. Try another title or spelling. Copyrighted versions are excluded.';render();}catch(error){showError(error);$('finder-status').textContent='Search could not finish. Try again.';}finally{$('finder-submit').disabled=false;}
  });
  $('page-finder').addEventListener('click',async event=>{
    const button=event.target.closest('[data-recording-download], [data-recording-transcribe]');if(!button)return;
    const download=button.hasAttribute('data-recording-download'),key=download?Number(button.dataset.recordingDownload):button.dataset.recordingTranscribe;
    if(busy.has(key))return;busy.add(key);$('finder-error').hidden=true;render();
    try {
      const result = await api(download?'/api/recordings':`/api/recordings/${key}/transcribe`,'POST',download?{pageId:key}:{});
      if(!download)selectTranscription(result.id);
      await refresh();toast(download?'Recording saved locally.':'Sheet music added to the queue.');if(!download)showPage('sheet');
    }catch(error){showError(error);}finally{busy.delete(key);render();}
  });
  return {render};
}
