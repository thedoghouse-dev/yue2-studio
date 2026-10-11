import { createMicrophoneRecorder } from './microphone.js';
const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
export function setupSheetMusic({ getStudio, api, refresh, toast, loadDraft, markDirty, showPage }) {
  let selected = null, signature = '', currentScore = null, uploading = false, previewURL = null;
  let recordingFile = null, recordingURL = null;
  const microphone = createMicrophoneRecorder({
    onState({ state, seconds }) {
      const busy = state !== 'idle';
      $('mic-record').disabled = busy || uploading;
      $('mic-stop').hidden = !busy; $('mic-stop').disabled = state === 'stopping';
      $('mic-stop').textContent = state === 'requesting' ? 'Cancel microphone request' : 'Stop recording';
      $('mic-discard').disabled = busy || uploading; $('audio-source').disabled = busy || uploading;
      $('mic-take').hidden = busy || !recordingFile;
      $('mic-status').textContent = state === 'requesting' ? 'Allow microphone access in your browser to begin.' : state === 'recording' ? `Recording · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} / 2:00 · Hum or sing your melody.` : state === 'stopping' ? 'Finishing your recording…' : recordingFile ? 'Take ready. Listen back, then create sheet music.' : 'Microphone is off. Record when you are ready.';
      render();
    },
    onRecording(file) {
      if (recordingURL) URL.revokeObjectURL(recordingURL);
      recordingFile = file; recordingURL = URL.createObjectURL(file);
      $('mic-preview').src = recordingURL; $('mic-take').hidden = false;
      $('mic-download').href = recordingURL; $('mic-download').download = file.name;
      $('mic-record').textContent = 'Record a new take';
      $('mic-status').textContent = 'Take ready. Listen back, then create sheet music.';
      if (!$('transcription-title').value.trim()) $('transcription-title').value = 'My hummed melody';
      render();
    },
    onError(message) { $('mic-error').textContent = message; $('mic-error').hidden = false; }
  });
  if (!microphone.supported) { $('mic-record').disabled = true; $('mic-status').textContent = 'Microphone recording is unavailable here. Open this studio in Chrome or Edge, or upload a recording.'; }
  $('mic-record').addEventListener('click', () => { $('mic-error').hidden = true; document.querySelectorAll('audio').forEach(audio => audio.pause()); microphone.start(); });
  $('mic-stop').addEventListener('click', () => microphone.stop());
  $('mic-discard').addEventListener('click', () => {
    recordingFile = null; if (recordingURL) URL.revokeObjectURL(recordingURL); recordingURL = null;
    $('mic-preview').pause(); $('mic-preview').removeAttribute('src'); $('mic-take').hidden = true;
    $('mic-download').removeAttribute('href'); $('mic-record').textContent = 'Record melody';
    $('mic-status').textContent = 'Microphone is off. Record when you are ready.'; render();
  });
  $('audio-source').addEventListener('change', () => {
    const mic = $('audio-source').value === 'microphone';
    $('microphone-input').hidden = !mic; $('file-input').hidden = mic;
    $('upload-preview').pause(); $('mic-preview').pause(); $('transcription-error').hidden = true; render();
  });
  window.addEventListener('pagehide', () => microphone.dispose());
  const url = (id, type) => `/api/transcriptions/${id}/${type}`;
  function renderLibrary(jobs) {
    if ($('page-sheet-library').hidden) return;
    const search=$('sheet-library-search').value.trim().toLowerCase(),status=$('sheet-library-status').value;
    const visible=jobs.filter(job=>(!search||`${job.title} ${job.filename??''}`.toLowerCase().includes(search))&&(status==='all'||(status==='ready'?job.hasScore:status==='active'?['queued','running'].includes(job.status):!job.hasScore&&!['queued','running'].includes(job.status))));
    $('sheet-library-count').textContent=`${visible.length} score${visible.length===1?'':'s'}`;
    const grid=$('sheet-library-grid'),key=JSON.stringify(visible.map(job=>[job.id,job.title,job.filename,job.status,job.stage,job.hasScore]));
    if(grid.dataset.signature===key)return;grid.dataset.signature=key;
    grid.innerHTML=visible.length?visible.map(job=>`<article class="song-card sheet-library-card"><button type="button" class="sheet-thumbnail" data-sheet-select="${job.id}" aria-label="Open ${escape(job.title)}"><span aria-hidden="true">♬</span></button><span class="status-badge ${escape(job.status)}">${escape(job.stage)}</span><h3>${escape(job.title)}</h3><p class="field-help">${escape(job.filename??'Audio transcription')}</p><div class="song-actions"><button type="button" class="secondary related-button" data-related="sheet:${job.id}">&#8984; Related assets</button><button type="button" class="secondary" data-sheet-select="${job.id}">${job.hasScore?'Open score':'View session'} ↗</button>${job.hasScore?`<a class="secondary" href="${url(job.id,'score')}?download">Download ABC ↓</a><button type="button" class="secondary" data-sheet-compose="${job.id}">Create a song ↗</button>`:''}</div><p class="field-help">${new Date(job.createdAt).toLocaleDateString()}</p></article>`).join(''):`<div class="empty-library"><h3>${jobs.length?'No matching scores.':'A place for your melodies.'}</h3><p>${jobs.length?'Try a different search or filter.':'Choose New sheet music to upload audio or record a melody with your microphone.'}</p></div>`;
    for(const job of visible.filter(job=>job.hasScore)) {
      const target=grid.querySelector(`[data-sheet-select="${job.id}"]`);
      void fetch(url(job.id,'score')).then(async response=>{
        if(!response.ok||!window.ABCJS)return;
        const abc=await response.text();if(!target.isConnected)return;
        if($('page-sheet-library').hidden){grid.dataset.signature='';return;}
        const notation=document.createElement('div');notation.className='sheet-thumbnail-notation';notation.setAttribute('aria-hidden','true');target.replaceChildren(notation);
        window.ABCJS.renderAbc(notation,abc,{staffwidth:300,oneSvgPerLine:true,paddingtop:8,paddingbottom:8});
        for(const row of [...notation.querySelectorAll('svg')].slice(2))row.remove();
      }).catch(()=>{});
    }
  }
  $('sheet-library-search').addEventListener('input',render);
  $('sheet-library-status').addEventListener('change',render);
  function render() {
    const studio = getStudio(); if (!studio) return;
    const ready = studio.sheetSage?.ready;
    $('sheetsage-pill').textContent = ready ? 'SheetSage2 ready' : 'Setup required';
    $('sheetsage-pill').className = `status-badge ${ready ? '' : 'failed'}`;
    $('transcribe').disabled = !ready || uploading || microphone.state !== 'idle';
    $('mic-record').disabled = !microphone.supported || uploading || microphone.state !== 'idle';
    $('audio-source').disabled = uploading || microphone.state !== 'idle';
    $('mic-discard').disabled = uploading || microphone.state !== 'idle';
    $('sheet-setup').hidden = ready;
    const setup = studio.sheetSageSetup;
    $('sheet-setup').textContent = setup?.status === 'downloading'
      ? `Installing SheetSage2 · ${Math.floor(setup.bytes / setup.total * 100)}% downloaded. You can prepare your audio while it installs.`
      : setup?.status === 'failed' ? `Setup failed: ${setup.error}. Run Setup SheetSage2.cmd to retry.`
      : 'Run Setup SheetSage2.cmd from the project folder to install the local transcription model and audio converter.';
    const jobs = studio.transcriptions ?? [];
    renderLibrary(jobs);
    // abcjs measures text while engraving. Hidden pages produce zero-height staff lines.
    if ($('page-sheet').hidden) return;
    const historyKey = JSON.stringify(jobs.map(j => [j.id, j.status, j.stage]));
    if ($('transcription-history').dataset.signature !== historyKey) {
      $('transcription-history').dataset.signature = historyKey;
      $('transcription-history').innerHTML = jobs.length ? jobs.map(j => `<button type="button" class="session-row" data-sheet-select="${j.id}"><span class="session-art">♬</span><span class="session-info"><strong>${escape(j.title)}</strong><small>${escape(j.stage)}</small></span><span>↗</span></button>`).join('') : '<p class="empty-recent">Your transcribed scores will appear here.</p>';
    }
    const job = jobs.find(j => j.id === selected);
    $('transcribe-form').hidden=Boolean(job);
    $('transcribe-form').closest('.sheet-sidebar').hidden=Boolean(job);
    document.querySelector('.sheet-layout').classList.toggle('viewing-score',Boolean(job));
    if (!job) {
      signature='';currentScore=null;$('score-status').textContent='';
      $('transcription-result').innerHTML='<div class="empty-library"><h3>Hear it. Then see it.</h3><p>Upload audio or record a melody to create a new score. Saved scores are in your sheet music library.</p></div>';
      return;
    }
    const key = JSON.stringify([job.id, job.status, job.stage, job.hasScore, job.error]);
    if (key === signature) return;
    signature = key; currentScore = null;
    $('score-status').textContent = job.stage;
    if (['queued', 'running'].includes(job.status)) {
      $('transcription-result').innerHTML = `<div class="transcription-working"><h3>${escape(job.title)}</h3><div class="stage">${escape(job.stage)}</div><div class="working-bar"></div><p>SheetSage2 is finding the melody, harmony, and musical timing.</p><button type="button" class="secondary" data-sheet-cancel="${job.id}">Cancel transcription</button></div>`;
    } else if (!job.hasScore) {
      $('transcription-result').innerHTML = `<h2>${escape(job.title)}</h2><p class="error-message">${escape(job.error ?? `This transcription was ${job.status}. Choose the audio file again to start another session.`)}</p>${job.startedAt ? `<a class="secondary" href="${url(job.id,'log')}" target="_blank">Session log ↗</a>` : ''}`;
    } else {
      $('transcription-result').innerHTML = `<h2>${escape(job.title)}</h2><p class="print-heading">SheetSage2 transcription · ${escape(job.filename)}</p><div class="song-actions score-actions"><button type="button" class="secondary related-button" data-related="sheet:${job.id}">&#8984; Related assets</button><a class="secondary" href="${url(job.id,'score')}?download">Download ABC ↓</a><button type="button" class="secondary" id="download-sheet-svg" disabled>Download SVG ↓</button><button type="button" class="secondary" id="print-sheet" disabled>Print / Save PDF ↗</button><button type="button" class="secondary" data-sheet-use="${job.id}" disabled>Use score in YuE2 ↗</button><a class="secondary" href="${url(job.id,'log')}" target="_blank">Session log ↗</a></div><audio class="source-player" controls preload="metadata" src="${url(job.id,'audio')}"></audio><p class="transcription-note">This is an estimated melody-and-chord score. Review the notes and timing against your recording before performing or arranging it.</p><p id="notation-warning" class="error-message" hidden></p><div id="sheet-notation" class="score-paper" aria-label="Rendered sheet music"><p>Rendering the score…</p></div><details class="score-raw"><summary>View original ABC notation</summary><pre id="transcription-abc"></pre></details>`;
      renderNotation(job, key);
    }
  }
  async function renderNotation(job, key) {
    try {
      const res = await fetch(url(job.id, 'score')); if (!res.ok) throw new Error('Could not load the score.');
      const abc = await res.text(); if (signature !== key) return;
      if ($('page-sheet').hidden) { signature = ''; return; }
      $('transcription-abc').textContent = abc;
      const withTitle = abc.replace(/^T:.*$/m, `T:${job.title.replace(/[\r\n]/g, ' ')}`);
      if (!window.ABCJS) throw new Error('The notation renderer is missing. Run npm ci, then reload the app.');
      const tunes = window.ABCJS.renderAbc('sheet-notation', withTitle, { responsive: 'resize', staffwidth: 700, oneSvgPerLine: true, paddingtop: 10, paddingbottom: 10, add_classes: true });
      const warnings = tunes.flatMap(tune => tune.warnings ?? []);
      if (!$('sheet-notation').querySelector('svg')) throw new Error('This score could not be rendered. Download the ABC notation to review it.');
      currentScore = { id: job.id, title: job.title, abc };
      if (warnings.length) { $('notation-warning').textContent = 'Some notation could not be interpreted cleanly. Review the original ABC below.'; $('notation-warning').hidden = false; }
      $('print-sheet').disabled = false;
      document.querySelector('[data-sheet-use]').disabled = false;
      try {
        await api(url(job.id,'render'),'POST',{ svg: makeSVG() });
        if (signature === key) $('download-sheet-svg').outerHTML = `<a id="download-sheet-svg" class="secondary" href="${url(job.id,'svg')}?download">Download SVG ↓</a>`;
      } catch (error) { if (signature === key) { $('notation-warning').textContent = `SVG export could not be saved: ${error.message}. ABC download and printing are still available.`; $('notation-warning').hidden = false; } }
    } catch (error) {
      if (signature !== key) return;
      $('sheet-notation').textContent = error.message;
      signature = ''; // Retry transient failures on the next status refresh.
    }
  }
  function makeSVG() {
    const rows = [...$('sheet-notation').querySelectorAll('svg')];
    const serializer = new XMLSerializer(); let y = 0, width = 0;
    const content = rows.map(row => {
      const box = row.viewBox.baseVal; const w = box.width || parseFloat(row.getAttribute('width')) || 750;
      const h = box.height || parseFloat(row.getAttribute('height')) || 120;
      const clone = row.cloneNode(true); clone.setAttribute('x','0'); clone.setAttribute('y',String(y)); clone.setAttribute('width',String(w)); clone.setAttribute('height',String(h));
      y += h; width = Math.max(width, w); return serializer.serializeToString(clone);
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y}" viewBox="0 0 ${width} ${y}"><rect width="100%" height="100%" fill="white"/>${content}</svg>`;
  }
  $('audio-file').addEventListener('change', () => {
    if (previewURL) URL.revokeObjectURL(previewURL);
    const file = $('audio-file').files[0]; $('upload-preview').hidden = !file;
    if (file) {
      previewURL = URL.createObjectURL(file); $('upload-preview').src = previewURL;
      if (!$('transcription-title').value.trim()) $('transcription-title').value = file.name.replace(/\.[^.]+$/,'').slice(0,120);
    } else { $('upload-preview').removeAttribute('src'); previewURL = null; }
  });
  function uploadFile(file, title) {
    return new Promise((resolve,reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/transcriptions?filename=${encodeURIComponent(file.name)}&title=${encodeURIComponent(title)}`);
      xhr.setRequestHeader('X-Studio-Token', getStudio().token); xhr.setRequestHeader('Content-Type','application/octet-stream');
      xhr.upload.onprogress = event => { $('upload-progress').textContent = event.lengthComputable ? `Uploading locally · ${Math.floor(event.loaded/event.total*100)}%` : 'Uploading locally…'; };
      xhr.onerror = () => reject(new Error('Upload failed. Check that the app is running.'));
      xhr.onabort = () => reject(new Error('Upload was interrupted.'));
      xhr.onload = () => {
        let result; try { result = JSON.parse(xhr.responseText); } catch { return reject(new Error('The app returned an invalid upload response.')); }
        if (xhr.status < 200 || xhr.status >= 300) reject(new Error(result.error ?? 'Upload failed.')); else resolve(result);
      };
      xhr.send(file);
    });
  }
  $('transcribe-form').addEventListener('submit', async event => {
    event.preventDefault(); if (uploading || !getStudio()?.sheetSage?.ready) return;
    $('transcription-error').hidden = true;
    if (microphone.state !== 'idle') return;
    const file = $('audio-source').value === 'microphone' ? recordingFile : $('audio-file').files[0];
    if (!file) { $('transcription-error').textContent = $('audio-source').value === 'microphone' ? 'Record a melody first, then stop to create sheet music.' : 'Choose an audio file first.'; $('transcription-error').hidden = false; return; }
    if (file.size > 128*1024*1024) { $('transcription-error').textContent = 'Choose a file that is 128 MB or smaller.'; $('transcription-error').hidden = false; return; }
    uploading = true; render(); $('upload-progress').hidden = false; $('upload-progress').textContent = 'Uploading locally…';
    try { const job = await uploadFile(file,$('transcription-title').value.trim()); selected = job.id; signature = ''; await refresh(); toast('Audio added to the transcription queue'); }
    catch (error) { $('transcription-error').textContent = error.message; $('transcription-error').hidden = false; }
    finally { uploading = false; $('upload-progress').hidden = true; render(); }
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    try {
      if (button.hasAttribute('data-sheet-new')) { selected=null;signature='';showPage('sheet');render(); }
      if (button.dataset.sheetSelect) { selected = button.dataset.sheetSelect; signature = ''; showPage('sheet');render(); }
      if (button.dataset.sheetCompose) {
        const job=getStudio().transcriptions.find(job=>job.id===button.dataset.sheetCompose&&job.hasScore);if(!job)return;
        const response=await fetch(url(job.id,'score'));if(!response.ok)throw new Error('Could not load the score.');
        loadDraft({abc:await response.text(),scoreSource:`transcription:${job.id}`,mode:'full'});markDirty();showPage('create');toast('Score loaded. Add lyrics and choose your sound.');
      }
      if (button.dataset.sheetCancel) { await api(url(button.dataset.sheetCancel,'cancel'),'POST',{}); await refresh(); }
      if (button.id === 'print-sheet' && currentScore) window.print();
      if (button.dataset.sheetUse && currentScore?.id === button.dataset.sheetUse) {
        loadDraft({ abc: currentScore.abc, scoreSource: `transcription:${currentScore.id}`, mode:'full' }); markDirty(); showPage('create');
        toast('Score loaded into YuE2. Add lyrics and your target style, then generate.');
      }
    } catch (error) { toast(error.message); }
  });
  return { render, leave() { microphone.stop(); $('mic-preview').pause(); }, select(id) { selected = id; signature = ''; } };
}
