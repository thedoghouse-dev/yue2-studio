import { setupVideos, videoProject } from './videos.js';
import { setupMastering } from './mastering.js';
import { setupSheetMusic } from './sheet.js';
import { setupFinder } from './finder.js';
import { setupCompositionScore } from './composition-score.js';
import { setupLyrics } from './lyrics.js';
const $ = id => document.getElementById(id);
// Appearance belongs to this browser, independently of the music workspace.
const themePreference = 'yue2-studio-theme';
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
let explicitTheme = null;
try { const saved = localStorage.getItem(themePreference); if (saved === 'light' || saved === 'dark') explicitTheme = saved; } catch {}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  $('theme-toggle').setAttribute('aria-pressed', String(dark));
  $('theme-toggle').setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} mode`);
  $('theme-icon').textContent = dark ? '☀' : '☾';
  $('theme-label').textContent = dark ? 'Light mode' : 'Dark mode';
}
applyTheme(explicitTheme ?? (systemTheme.matches ? 'dark' : 'light'));
$('theme-toggle').addEventListener('click', () => {
  explicitTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(explicitTheme);
  try { localStorage.setItem(themePreference, explicitTheme); } catch {}
});
systemTheme.addEventListener('change', event => { if (!explicitTheme) applyTheme(event.matches ? 'dark' : 'light'); });
window.addEventListener('storage', event => {
  if (event.key !== themePreference && event.key !== null) return;
  explicitTheme = event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : null;
  applyTheme(explicitTheme ?? (systemTheme.matches ? 'dark' : 'light'));
});

const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let studio = null, selected = null, page = 'create', pollBusy = false, dirty = false, saveTimer, toastTimer, loading = false;
const selectedSongs=new Set();let visibleSongs=[],projectSignature='';
const projectName=id=>studio?.projects?.find(project=>project.id===id)?.name??'Unassigned';
function projectOptions(current='',includeAll=false){return `${includeAll?'<option value="all">All projects</option>':''}<option value="" ${current===''?'selected':''}>Unassigned</option>${(studio?.projects??[]).map(project=>`<option value="${project.id}" ${project.id===current?'selected':''}>${escape(project.name)}</option>`).join('')}`;}
function renderProjects(){
  const projects=(studio.projects??[]).map(p=>({...p,videoCount:(studio.videos?.jobs??[]).filter(v=>videoProject(v,studio.songs)===p.id).length})),unassigned=studio.songs.filter(song=>!song.projectId).length;
  $('project-count').textContent=projects.length;
  const signature=JSON.stringify([projects,unassigned,studio.songs.length]);if(signature===projectSignature)return;projectSignature=signature;
  for(const id of ['song-project','move-project','library-project']){const element=$(id),value=element.value;element.innerHTML=projectOptions(value,id==='library-project')+(id==='move-project'?'<option value="new">＋ New project…</option>':'');if([...element.options].some(option=>option.value===value))element.value=value;else element.value=id==='library-project'?'all':'';}
  $('project-list').innerHTML=`<article class="project-card"><span class="eyebrow">YOUR COLLECTION</span><h3>All songs</h3><p>${studio.songs.length} song${studio.songs.length===1?'':'s'}</p><button type="button" class="secondary" data-project-open="all">Browse all songs ↗</button></article><article class="project-card"><span class="eyebrow">WAITING FOR A HOME</span><h3>Unassigned</h3><p>${unassigned} song${unassigned===1?'':'s'}</p><button type="button" class="secondary" data-project-open="">Organize these songs ↗</button></article>${projects.map(project=>`<article class="project-card"><span class="eyebrow">PROJECT</span><h3>${escape(project.name)}</h3><p>${project.songCount} song${project.songCount===1?'':'s'} · ${project.videoCount} video${project.videoCount===1?'':'s'}</p><div class="song-actions"><button type="button" class="secondary" data-project-open="${project.id}">Open project ↗</button><button type="button" class="secondary" data-project-videos="${project.id}">View videos ↗</button><button type="button" class="text-button" data-project-compose="${project.id}">Create a song here</button></div><details class="advanced"><summary>Manage project</summary><input data-project-name="${project.id}" aria-label="Rename ${escape(project.name)}" maxlength="80" value="${escape(project.name)}"><div class="song-actions"><button type="button" class="secondary" data-project-rename="${project.id}">Save name</button><button type="button" class="text-button" data-project-remove="${project.id}">Remove grouping</button></div><p class="field-help">Songs move to Unassigned. Audio and videos stay saved.</p></details></article>`).join('')}`;
}
function updateSelection(){
  const ids=new Set(visibleSongs.map(song=>song.id));for(const id of selectedSongs)if(!ids.has(id))selectedSongs.delete(id);
  $('selected-song-count').textContent=`${selectedSongs.size} selected`;$('move-songs').disabled=!selectedSongs.size||($('move-project').value==='new'&&!$('move-new-project').value.trim());
  $('select-visible-songs').checked=visibleSongs.length>0&&visibleSongs.every(song=>selectedSongs.has(song.id));
  $('select-visible-songs').indeterminate=selectedSongs.size>0&&!$('select-visible-songs').checked;
}
const presets = {
  folk: 'English, indie folk, intimate warm lead vocal, fingerpicked acoustic guitar, brushed drums, mellow bass, nostalgic, organic live recording',
  pop: 'English, dream pop, airy lead vocal, shimmering synth pads, chorus guitar, soft electronic drums, bittersweet, spacious polished production',
  soul: 'English, neo-soul, expressive warm lead vocal, Rhodes piano, laid-back bass groove, restrained drums, late-night mood, rich harmonies',
  rock: 'English, alternative rock, passionate lead vocal, crunchy electric guitars, driving bass and drums, anthemic chorus, dynamic full-band production',
  country: 'English, modern country, heartfelt lead vocal, acoustic guitar, pedal steel, steady drums, warm bass, hopeful storytelling, natural production',
  techno: 'English, techno, 132 BPM, driving four-on-the-floor kick, pulsing synth bass, hypnotic sequencer patterns, crisp hi-hats, dark club atmosphere, rhythmic vocal hooks, gradual builds and releases',
  metal: 'English, heavy metal, powerful gritty lead vocal, distorted electric guitars, palm-muted riffs, heavy bass, double-kick drums, soaring guitar solos, dramatic energy, tight full-band production',
  house: 'English, house, 124 BPM, soulful vocal hooks, four-on-the-floor drums, warm rolling bass, bright piano chords, rhythmic synth stabs, uplifting dancefloor groove',
  edm: 'English, electronic dance music, energetic melodic lead vocal, bright layered synths, deep bass, punchy electronic drums, rising builds, anthemic chorus, dramatic drops, polished festival production',
  hiphop: 'English, hip hop, rhythmic rap vocal, clear lyrical delivery, punchy kick and snare, deep bass, sampled piano chords, laid-back head-nodding groove, confident storytelling',
  rnb: 'English, contemporary R&B, smooth expressive lead vocal, rich vocal harmonies, warm electric piano, deep bass, syncopated electronic drums, intimate mood, polished soulful production',
  jazz: 'English, vocal jazz, warm expressive lead vocal, swinging acoustic drums, upright bass, piano chords, mellow saxophone fills, intimate small-combo arrangement, relaxed live-room sound',
  blues: 'English, electric blues, soulful gritty lead vocal, expressive electric guitar bends, walking bass, shuffle drums, Hammond organ, heartfelt storytelling, warm live-band sound',
  funk: 'English, funk, energetic soulful lead vocal, syncopated electric bass, tight drums, rhythmic clean guitar, clavinet, punchy brass accents, playful danceable groove',
  reggae: 'English, roots reggae, relaxed melodic lead vocal, offbeat rhythm guitar, deep rounded bass, one-drop drums, warm organ, sunny hopeful mood, organic band production',
  punk: 'English, punk rock, raw energetic lead vocal, fast driving drums, distorted power-chord guitars, punchy bass, short catchy choruses, rebellious spirit, direct live-band energy',
  synthwave: 'English, synthwave, emotive melodic lead vocal, shimmering analog synths, pulsing arpeggios, warm synth bass, gated electronic drums, nostalgic night-drive atmosphere, cinematic chorus',
  latinpop: 'English, Latin pop, bright expressive lead vocal, syncopated Latin percussion, nylon-string guitar, warm bass, catchy piano melody, joyful danceable rhythm, polished pop chorus',
  cinematic: 'English, cinematic orchestral ballad, expressive soaring lead vocal, piano, sweeping strings, warm brass, orchestral percussion, gradual emotional build, spacious dramatic arrangement',
};
const sample = { title: 'After the rain', style: presets.folk, lyrics: '[Verse]\nThe porch light flickers in the rain\nYour old coat hangs here just the same\nI put the kettle on at dawn\nAnd hum the tune you left me on\n\n[Chorus]\nAfter the rain, the road turns gold\nThere is a warmth the sky can hold\nI leave the door a little wide\nFor all the days still waiting outside\n\n[Outro]\nThe clouds move on, the windows shine\nA little light, a little time', mode: 'full', seed: 1234, maxTokens: 3000, steps: 8, temperature: 1, abc: '' };

function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4000); }
async function api(url, method = 'GET', data) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(studio?.token ? { 'X-Studio-Token': studio.token } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await res.json(); if (!res.ok) throw new Error(result.error ?? 'Request failed'); return result;
}
function draft() {
  return { title: $('title').value, projectId:$('song-project').value, style: $('style').value, lyrics: $('lyrics').value, mode: document.querySelector('input[name="mode"]:checked').value,
    seed: Number($('seed').value), durationSeconds: $('duration-auto').checked ? null : Number($('durationSeconds').value), durationMode:$('durationMode').value,scoreUse:$('scoreUse').value,maxTokens: Number($('maxTokens').value), steps: Number($('steps').value), temperature: Number($('temperature').value), abc: $('abc').value, scoreSource: compositionScore.source(), execution: $('execution').value };
}
function loadDraft(value) {
  if('projectId' in value||'lyrics' in value)$('song-project').value=value.projectId??'';
  if('lyrics' in value||'durationMode' in value)$('durationMode').value=value.durationMode??'target';
  if('lyrics' in value||'scoreUse' in value)$('scoreUse').value=value.scoreUse??'follow';
  if ('durationSeconds' in value || 'lyrics' in value) {
    $('duration-auto').checked = value.durationSeconds == null || value.durationSeconds === '';
    $('durationSeconds').value = $('duration-auto').checked ? 90 : value.durationSeconds;
  }
  if (value.maxTokens !== undefined && ![...$('maxTokens').options].some(option => Number(option.value) === value.maxTokens)) $('maxTokens').add(new Option(`Custom limit · ${value.maxTokens.toLocaleString()} tokens`, String(value.maxTokens)));
  if(value.execution!==undefined)$('execution').value=value.execution==='runpod'?'runpod':'local';
  for (const key of ['title', 'style', 'lyrics', 'seed', 'maxTokens', 'steps', 'temperature', 'abc']) if (value[key] !== undefined) $(key).value = value[key];
  const mode = ['full', 'melody', 'off'].includes(value.mode) ? value.mode : 'full';
  document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
  compositionScore.load(value);
  counts();
}
function counts() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  $('mode-help').textContent = {
    full: 'Full composition plans the melody and chords, then renders the song. A good starting point for structured songs or supplied sheet music.',
    melody: 'Melody first plans the tune, while the audio stage has more freedom to shape the accompaniment. Choose it when the melody matters most.',
    off: 'Direct audio generates sound from your description and lyrics without an intermediate score plan. It cannot use supplied sheet music.',
  }[mode];
  $('lyrics-count').textContent = `${$('lyrics').value.length.toLocaleString()} characters`;
  $('temperature-value').textContent = Number($('temperature').value).toFixed(1);
  const automatic = $('duration-auto').checked, seconds = Number($('durationSeconds').value);
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const cap = Number($('maxTokens').value) / 25;
  const capTime = `${Math.floor(cap / 60)}:${String(Math.ceil(cap % 60)).padStart(2, '0')}`;
  $('durationSeconds').disabled = automatic;
  $('durationSeconds').setAttribute('aria-valuetext', `${seconds} seconds, ${time}`);
  $('duration-value').textContent = automatic ? `Automatic · up to ${capTime}` : `${time} · ${seconds} seconds`;
  $('maxTokens').disabled = !automatic;
  $('automatic-length-field').hidden = !automatic;
  $('durationMode').disabled = automatic;
  $('duration-help').textContent = automatic
    ? `YuE2 can end naturally, with a maximum of ${capTime}. This is a cap, not a promise to finish all the lyrics. Choose a higher maximum if the song needs more room; reaching the cap can cut off the ending.`
    : 'Choose 10–360 seconds. Target length prevents early stopping until about two seconds before the limit. Maximum only allows shorter songs. Reaching the limit can cut off an ending, and continuing a short score may repeat musical material.';
}
function markDirty() {
  dirty = true; counts(); $('save-status').textContent = 'Saving draft…';
  clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 700);
  try { localStorage.setItem('yue2-draft', JSON.stringify(draft())); } catch { /* server remains the source of persistence */ }
}
async function saveDraft() {
  if (!studio || !dirty) return;
  const value = draft();
  try { await api('/api/draft', 'PUT', value); if (JSON.stringify(draft()) === JSON.stringify(value)) dirty = false; $('save-status').textContent = dirty ? 'Saving draft…' : 'Draft saved locally'; }
  catch { $('save-status').textContent = 'Draft saved in browser · server offline'; }
}
function showPage(name) {
  if (page === 'sheet' && name !== 'sheet') sheetMusic.leave();
  page = name;
  for (const section of document.querySelectorAll('.page')) section.hidden = section.id !== `page-${name}`;
  for (const button of document.querySelectorAll('[data-page]')) button.classList.toggle('active', button.dataset.page === name || (name === 'videos' && button.dataset.page === 'video-library'));
  $('breadcrumb').textContent = { create: 'Create a song', projects:'Projects', lyrics: 'Write lyrics', library: 'Song library', sheet: 'Sheet music', finder: 'Find a song', 'video-library':'Video library', videos: 'Create a music video', engine: 'Engine settings' }[name];
  if (name === 'lyrics' || name === 'engine') lyricsWorkspace.open().catch(error => toast(error.message));
  if (name === 'finder') finder.render();
  if (name === 'library') renderLibrary();
  if (name === 'video-library' || name === 'videos') videoWorkspace.render();
  if (name === 'sheet') sheetMusic.render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function badge(song) { return `<span class="status-badge ${escape(song.status)}">${escape({ completed: 'Ready to listen', running: 'Generating', queued: 'Queued', failed: 'Needs attention', interrupted: 'Interrupted', cancelled: 'Cancelled' }[song.status])}</span>`; }
function elapsed(song) {
  if (!song.startedAt) return 'Waiting for the engine';
  const seconds = Math.max(0, Math.floor(((song.finishedAt ? Date.parse(song.finishedAt) : Date.now()) - Date.parse(song.startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s ${song.finishedAt ? 'generation time' : 'elapsed'}`;
}
const link = (song, type) => `/api/songs/${song.id}/${type}`;
function actions(song) {
  if(song.deletedAt)return `<div class="song-actions"><button class="secondary" type="button" data-song-restore="${song.id}">Restore song ↗</button></div>`;
  return `<div class="song-actions">${song.hasAudio ? `<button class="secondary" type="button" data-video-song="${song.id}">Create music video</button><button class="secondary" type="button" data-master="${song.id}">Master this song</button><a class="secondary" href="${link(song, 'audio')}?download">Download WAV ↓</a>` : ''}${['running', 'queued'].includes(song.status) ? `<button class="secondary" type="button" data-cancel="${song.id}">Cancel</button>` : ''}<button class="secondary" type="button" data-detail="${song.id}">Details ↗</button><button class="text-button video-delete-button" type="button" data-song-delete="${song.id}">${song.deletionBlockers?.length?'Why deletion is blocked':'Delete song'}</button></div>`;
}
function renderEngine() {
  const ready = studio.runtime.ready;
  const remote=$('execution').value==='runpod',generationReady=remote?studio.runpod?.configured:ready;
  for (const choice of document.querySelectorAll('input[name="engine-choice"]')) choice.checked = choice.value === $('execution').value;
  $('engine-pill').className = `engine-pill ${generationReady ? 'ready' : ''}`;
  $('engine-pill').innerHTML = `<i></i>${remote ? (generationReady?'RunPod connection saved':'RunPod setup required') : (ready?'YuE2 engine ready':'Engine setup required')}`;
  const setup = studio.setup;
  $('setup-banner').hidden = ready || remote;
  let setupText = 'The generation engine needs setup. Run “Setup YuE2.cmd” from the project folder to install it.';
  if (setup?.status === 'downloading') setupText = `Installing YuE2 · ${setup.file} · ${Math.floor(setup.bytes / setup.total * 100)}% downloaded. You can write your lyrics while it installs.`;
  if (setup?.status === 'extracting') setupText = `Installing YuE2 · Unpacking ${setup.file}.`;
  if (setup?.status === 'failed') setupText = `Setup needs attention: ${setup.error}. Run “Setup YuE2.cmd” to retry.`;
  $('setup-banner').innerHTML = `${escape(setupText)} <button type="button" class="text-button" data-page="engine">Engine settings ↗</button>`;
  $('engine-status').innerHTML = ready ? '<span class="status-badge">Runtime and models installed</span>' : `<span class="status-badge failed">Missing engine files</span><ul>${studio.runtime.missing.map(x => `<li>${escape(x)}</li>`).join('')}</ul>`;
  $('generate').disabled = !generationReady || loading || compositionScore.pending();
  $('generate').title = remote ? (generationReady?'Generate with your paid RunPod worker':'Connect RunPod in Engine settings first') : (ready?'Generate with YuE2 on your computer':'Finish engine setup first');
  $('execution-note').textContent=remote?'BF16 weights + F32 decoder. Lyrics, style and sheet music are sent to your RunPod worker. RunPod charges while the pod runs; stop or terminate it when finished. Higher precision may help quality, but does not guarantee correct lyrics.':'Runs on your computer using the precision selected in Engine settings. Your lyrics and sheet music stay local.';
  $('generation-location').textContent=remote?'Generated on RunPod · paid GPU. Audio is downloaded into this library.':'Generated on your computer. Lyrics and drafts stay local.';
  $('runpod-connection-status').textContent=studio.runpod?.configured?'Worker connection saved. Check the worker before generating.':'No RunPod worker connected.';
}
function renderRoom() {
  const songs = studio.songs;
  const song = songs.find(s => s.id === selected) ?? songs.find(s => ['running', 'queued'].includes(s.status)) ?? songs[0];
  if (!song) {
    $('listening-room').innerHTML = '<div class="empty-room"><div class="vinyl"><span class="vinyl-label"></span></div><h3>A space for your sound.</h3><p>Your next song will be right here.<br>Press generate when the idea feels right.</p></div><div class="room-divider"></div><div class="room-meta"><span>READY WHEN YOU ARE</span><span>STEREO / WAV</span></div>';
    return;
  }
  // Keep the audio element alive across polling, so playback never resets.
  const signature = JSON.stringify([song.id, song.status, song.stage, song.hasAudio, song.hasScore, song.error, song.truncated]);
  if ($('listening-room').dataset.signature === signature) {
    const timer = $('listening-room').querySelector('[data-elapsed]'); if (timer) timer.textContent = elapsed(song); return;
  }
  $('listening-room').dataset.signature = signature;
  const working = ['running', 'queued'].includes(song.status);
  $('listening-room').innerHTML = `<div class="room-song ${working ? 'generating' : ''}"><div class="vinyl"><span class="vinyl-label"></span></div>${badge(song)}<h3>${escape(song.title)}</h3><p class="song-style">${escape(song.style)}</p>${working ? `<div class="stage">${escape(song.stage)}</div><div class="working-bar"></div><div class="stage-note" data-elapsed>${escape(elapsed(song))}</div><p class="stage-note">YuE2 works in stages. A longer song can take several minutes.</p>` : ''}${song.hasAudio ? `<audio controls preload="metadata" src="${link(song, 'audio')}"></audio><div class="stage-note" data-elapsed>${escape(elapsed(song))}</div>` : ''}${song.error ? `<p class="error-message">${escape(song.error)}</p>` : ''}${song.truncated ? '<p class="error-message">Generation reached its length limit. The ending may be clipped.</p>' : ''}${actions(song)}</div><div class="room-divider"></div><div class="room-meta"><span>SEED ${song.seed}</span><span>${song.mode === 'off' ? 'DIRECT AUDIO' : 'SCORE + AUDIO'}</span></div>`;
}
function renderRecent() {
  const songs = studio.songs.slice(0, 5);
  const signature = JSON.stringify(songs.map(s => [s.id, s.status]));
  if ($('recent-songs').dataset.signature === signature) return;
  $('recent-songs').dataset.signature = signature;
  $('recent-songs').innerHTML = songs.length ? songs.map(s => `<button type="button" class="session-row" data-select="${s.id}"><span class="session-art">${s.status === 'completed' ? '♫' : '◌'}</span><span class="session-info"><strong>${escape(s.title)}</strong><small>${escape(s.stage)}</small></span><span>↗</span></button>`).join('') : '<div class="empty-recent">Nothing recorded yet.<br>Your sessions will collect here as you create.</div>';
}
function renderLibrary(force = false) {
  if (!studio) return;
  const search = $('search').value.toLowerCase(), filter = $('filter').value,project=$('library-project').value;
  const inTrash=filter==='trash';document.querySelector('.project-bulk').hidden=inTrash;
  const songs = (inTrash?(studio.songTrash??[]):studio.songs).filter(s => `${s.title} ${s.style} ${s.lyrics}`.toLowerCase().includes(search) && (project==='all'||(s.projectId??'')===project) && (inTrash || filter === 'all' || s.status === filter || (filter === 'running' && s.status === 'queued') || (filter === 'failed' && s.status === 'interrupted')));
  visibleSongs=songs;updateSelection();$('library-result-count').textContent=`${songs.length} song${songs.length===1?'':'s'} · ${project==='all'?'All projects':projectName(project)}`;
  const signature = JSON.stringify([search, filter, project,studio.projects,songs.map(s => [s.id, s.status, s.hasAudio, s.stage,s.projectId,s.deletionBlockers])]);
  if (!force && $('library-songs').dataset.signature === signature) return;
  $('library-songs').dataset.signature = signature;
  $('library-songs').innerHTML = songs.length ? songs.map(song => `<article class="song-card"><div class="card-art" aria-hidden="true">${Array.from({ length: 28 }, (_, i) => `<i></i>`).join('')}</div>${inTrash?'':`<label class="song-select"><input type="checkbox" data-song-select="${song.id}" ${selectedSongs.has(song.id)?'checked':''} aria-label="Select ${escape(song.title)}">Select song</label>`}${song.deletedAt?'<span class="status-badge">In Trash</span>':badge(song)}<span class="project-label">${escape(projectName(song.projectId))}</span><h3>${escape(song.title)}</h3><p>${escape(song.style)}</p>${song.hasAudio ? `<audio controls preload="none" src="${link(song, 'audio')}"></audio>` : `<p>${escape(song.stage)}</p>`}${actions(song)}<time>${new Date(song.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time></article>`).join('') : `<div class="empty-library"><h3>${studio.songs.length ? 'No matching tracks.' : 'Your first track is waiting to happen.'}</h3><p>${studio.songs.length ? 'Try another search or filter.' : 'Create a song and it will be saved here, with its lyrics and settings.'}</p><button type="button" class="secondary" data-page="create">Go to the song editor ↗</button></div>`;
}
async function detail(id) {
  const song = studio.songs.find(s => s.id === id); if (!song) return;
  $('song-detail').innerHTML = `${badge(song)}<h2>${escape(song.title)}</h2><p>${escape(song.style)}</p>${song.hasAudio ? `<audio controls preload="metadata" src="${link(song, 'audio')}"></audio>` : ''}${song.error ? `<p class="error-message">${escape(song.error)}</p>` : ''}<div class="song-actions"><button type="button" class="primary" data-reuse="${song.id}">Edit & create a new version ↗</button>${song.hasAudio ? `<button class="secondary" type="button" data-video-song="${song.id}">Create music video</button><button class="secondary" type="button" data-master="${song.id}">Master this song</button><a class="secondary" href="${link(song, 'audio')}?download">Download WAV ↓</a>` : ''}<a class="secondary" href="${link(song, 'request')}?download">Song settings ↓</a><a class="secondary" href="${link(song, 'lyrics')}?download">Lyrics ↓</a>${song.hasScore ? `<a class="secondary" href="${link(song, 'score')}?download">ABC score ↓</a>` : ''}${song.startedAt ? `<a class="secondary" href="${link(song, 'log')}" target="_blank">Generation log ↗</a>` : ''}</div><div class="field"><label for="detail-song-project">Project</label><select id="detail-song-project" data-song-project="${song.id}">${projectOptions(song.projectId??'')}</select><p class="field-help">Changes save automatically.</p></div><h4>LYRICS</h4><pre>${escape(song.lyrics)}</pre><p>${song.execution === 'runpod' ? 'RunPod' : 'Local'} · ${escape(song.modelPrecision ?? 'Q4')} · Seed ${song.seed} · ${song.mode} planning · ${song.maxTokens.toLocaleString()} token limit · ${song.steps} render steps</p>${song.hasScore ? '<h4>COMPOSITION SCORE</h4><pre id="score-preview">Loading score…</pre>' : ''}`;
  $('song-dialog').showModal();
  if (song.hasScore) {
    try { const res = await fetch(link(song, 'score')); if (!res.ok) throw new Error('Could not read the score'); const abc = await res.text(); if ($('score-preview')) $('score-preview').textContent = abc; }
    catch (error) { if ($('score-preview')) $('score-preview').textContent = error.message; }
  }
}
async function refresh(initial = false) {
  if (pollBusy) return; pollBusy = true;
  try {
    studio = await api('/api/studio');
    renderProjects();
    if (initial) {
      let local; try { local = JSON.parse(localStorage.getItem('yue2-draft')); } catch { }
      loadDraft(local ?? studio.draft ?? { title: '', style: '', lyrics: '' });
      for (const [key, value] of Object.entries(studio.settings)) if ($(key)) $(key).value = value;
      $('runpod-url').value=studio.runpod?.url??'';
    }
    $('library-count').textContent = studio.songs.length;
    videoWorkspace.render(); mastering.render(); compositionScore.render(); renderEngine(); renderRoom(); renderRecent(); sheetMusic.render(); finder.render(); if (page === 'library') renderLibrary();
    if (dirty) saveDraft();
  } catch {
    $('engine-pill').className = 'engine-pill'; $('engine-pill').innerHTML = '<i></i>App disconnected'; $('generate').disabled = true;
    if (initial) toast('Could not connect. Start the app with Start YuE2 Studio.cmd.');
  } finally { pollBusy = false; }
}
let deletingSongId=null;
for(const id of ['close-delete-song','cancel-delete-song'])$(id).addEventListener('click',()=>$('delete-song-dialog').close());
$('delete-song-dialog').addEventListener('close',()=>{deletingSongId=null;});
$('confirm-delete-song').addEventListener('click',async()=>{
  if(!deletingSongId)return;const button=$('confirm-delete-song');button.disabled=true;$('delete-song-error').hidden=true;
  try{await api(`/api/songs/${deletingSongId}/trash`,'POST',{});$('delete-song-dialog').close();await refresh();renderLibrary(true);toast('Song moved to Trash. Restore it using the library status filter.');}
  catch(error){$('delete-song-error').textContent=error.message;$('delete-song-error').hidden=false;button.disabled=false;}
});
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  try {
    if(button.dataset.songDelete){
      const song=await api(`/api/songs/${button.dataset.songDelete}`);deletingSongId=song.id;const blockers=song.deletionBlockers??[];
      $('delete-song-title').textContent=song.title;$('delete-song-heading').textContent=blockers.length?'This song is in use.':'Delete this song?';
      $('delete-song-explanation').textContent=blockers.length?'Deletion is blocked to protect these linked assets. Videos in Trash still count as dependencies.':'The song, audio, lyrics, score, and settings move to recoverable Trash. Your project, reference images, and other songs stay saved. Trash retains files and does not free disk space.';
      $('delete-song-blockers').innerHTML=blockers.map(b=>`<li>${escape(b.type==='video'?'Video':b.type==='master'?'Master':'Generation')}: ${escape(b.title)}${b.inTrash?' (in Trash)':''}</li>`).join('');
      $('confirm-delete-song').disabled=Boolean(blockers.length);$('confirm-delete-song').hidden=Boolean(blockers.length);$('delete-song-error').hidden=true;$('delete-song-dialog').showModal();
    }
    if(button.dataset.songRestore){await api(`/api/songs/${button.dataset.songRestore}/restore`,'POST',{});await refresh();renderLibrary(true);toast('Song restored to your library.');}
    if (button.dataset.page) showPage(button.dataset.page);
    if(button.dataset.projectVideos){$('video-library-project').value=button.dataset.projectVideos;$('video-library-search').value='';$('video-library-status').value='all';showPage('video-library');}
    if(button.dataset.projectOpen!==undefined){$('library-project').value=button.dataset.projectOpen;$('search').value='';$('filter').value='all';selectedSongs.clear();showPage('library');}
    if(button.dataset.projectCompose){loadDraft({...sample,title:'',style:'',lyrics:'',abc:'',projectId:button.dataset.projectCompose});markDirty();showPage('create');$('title').focus();}
    if(button.dataset.projectRename){const id=button.dataset.projectRename,name=document.querySelector(`[data-project-name="${id}"]`).value;await api(`/api/projects/${id}`,'PATCH',{name});await refresh();toast('Project renamed');}
    if(button.dataset.projectRemove){await api(`/api/projects/${button.dataset.projectRemove}`,'DELETE',{});await refresh();toast('Grouping removed. Songs are in Unassigned.');}
    if (button.dataset.preset) { $('style').value = presets[button.dataset.preset]; markDirty(); }
    if (button.dataset.section) {
      const editor = $('lyrics'); editor.focus(); const pos = editor.selectionStart;
      const label = `${pos && editor.value[pos - 1] !== '\n' ? '\n\n' : ''}[${button.dataset.section}]\n`;
      editor.setRangeText(label, editor.selectionStart, editor.selectionEnd, 'end'); markDirty();
    }
    if (button.dataset.select) { selected = button.dataset.select; renderRoom(); }
    if (button.dataset.master) mastering.open(button.dataset.master);
    if (button.dataset.detail) await detail(button.dataset.detail);
    if (button.dataset.cancel) { await api(`/api/songs/${button.dataset.cancel}/cancel`, 'POST', {}); await refresh(); toast('Generation cancelled'); }
    if (button.dataset.reuse) {
      const song = studio.songs.find(s => s.id === button.dataset.reuse); const value = { ...song, title: `${song.title.slice(0, 106)} · version 2` };
      if (song.hasScore && song.mode !== 'off') { const res = await fetch(link(song, 'score')); if (!res.ok) throw new Error('Could not load the saved score'); value.abc = await res.text(); }
      loadDraft(value); markDirty(); $('song-dialog').close(); showPage('create'); toast('Song loaded. Edit it, then generate a new version.');
    }
  } catch (error) { toast(error.message); }
});
$('song-form').addEventListener('input', markDirty);
$('song-form').addEventListener('change', markDirty);
$('song-form').addEventListener('submit', async event => {
  event.preventDefault(); if (loading || compositionScore.pending() || !($('execution').value==='runpod'?studio?.runpod?.configured:studio?.runtime.ready)) return;
  $('form-error').hidden = true; loading = true; renderEngine();
  try {
    const song = await api('/api/songs', 'POST', draft()); selected = song.id; await saveDraft(); await refresh(); toast('Song added to the generation queue');
  } catch (error) { $('form-error').textContent = error.message; $('form-error').hidden = false; }
  finally { loading = false; renderEngine(); }
});
$('sample').addEventListener('click', () => { loadDraft(sample); markDirty(); toast('Original example loaded'); });
$('random-seed').addEventListener('click', () => { $('seed').value = crypto.getRandomValues(new Uint32Array(1))[0] % 2147483648; markDirty(); });
$('all-songs').addEventListener('click', () => showPage('library'));
$('new-song').addEventListener('click', () => { loadDraft({ ...sample, title: '', style: '', lyrics: '', abc: '',projectId:$('library-project').value==='all'?'':$('library-project').value }); markDirty(); showPage('create'); $('title').focus(); });
$('search').addEventListener('input', () => renderLibrary());
$('filter').addEventListener('change', () => renderLibrary());
$('library-project').addEventListener('change',()=>{selectedSongs.clear();renderLibrary(true);});
$('library-songs').addEventListener('change',event=>{const id=event.target.dataset.songSelect;if(!id)return;if(event.target.checked)selectedSongs.add(id);else selectedSongs.delete(id);updateSelection();});
$('select-visible-songs').addEventListener('change',event=>{selectedSongs.clear();if(event.target.checked)for(const song of visibleSongs)selectedSongs.add(song.id);for(const checkbox of $('library-songs').querySelectorAll('[data-song-select]'))checkbox.checked=selectedSongs.has(checkbox.dataset.songSelect);updateSelection();});
$('move-project').addEventListener('change',()=>{const creating=$('move-project').value==='new';$('move-new-project').hidden=!creating;$('move-songs').textContent=creating?'Create project & move songs':'Move selected songs';updateSelection();if(creating)$('move-new-project').focus();});
$('move-new-project').addEventListener('input',updateSelection);
$('move-songs').addEventListener('click',async()=>{const ids=[...selectedSongs];if(!ids.length)return;$('move-songs').disabled=true;try{const creating=$('move-project').value==='new';const result=await api('/api/projects/move','POST',{songIds:ids,...(creating?{newProjectName:$('move-new-project').value}:{projectId:$('move-project').value})});if(creating){$('move-project').value='';$('move-new-project').value='';$('move-new-project').hidden=true;$('move-songs').textContent='Move selected songs';}selectedSongs.clear();await refresh();renderLibrary(true);if(creating)$('move-project').value=result.projectId;toast(`${ids.length} song${ids.length===1?'':'s'} moved${creating?' into the new project':''}`);}catch(error){toast(error.message);}finally{updateSelection();}});
$('project-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;$('project-error').hidden=true;try{await api('/api/projects','POST',{name:$('project-name').value});$('project-name').value='';await refresh();toast('Project created');}catch(error){$('project-error').textContent=error.message;$('project-error').hidden=false;}finally{button.disabled=false;}});
document.addEventListener('change',async event=>{const id=event.target.dataset.songProject;if(!id)return;try{await api('/api/projects/move','POST',{songIds:[id],projectId:event.target.value});await refresh();toast('Song project saved');}catch(error){event.target.value=studio.songs.find(song=>song.id===id)?.projectId??'';toast(error.message);}});
$('close-dialog').addEventListener('click', () => { $('song-dialog').close(); $('song-detail').innerHTML = ''; });
$('song-dialog').addEventListener('close', () => { $('song-detail').innerHTML = ''; });
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); $('settings-error').hidden = true;
  const button = event.submitter; button.disabled = true;
  try { await api('/api/settings', 'PUT', Object.fromEntries(['executable', 'modelDir', 'backend', 'modelFile', 'sheetSageModel'].map(key => [key, $(key).value]))); await refresh(); toast('Engine settings saved'); }
  catch (error) { $('settings-error').textContent = error.message; $('settings-error').hidden = false; }
  finally { button.disabled = false; }
});
for (const choice of document.querySelectorAll('input[name="engine-choice"]')) choice.addEventListener('change', () => {
  if (!choice.checked) return;
  $('execution').value = choice.value;
  renderEngine(); markDirty();
});
$('runpod-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;$('runpod-error').hidden=true;
  try{await api('/api/runpod/connection','PUT',{url:$('runpod-url').value,token:$('runpod-token').value});$('runpod-token').value='';await refresh();toast('RunPod connection saved. Check the worker next.');}catch(error){$('runpod-error').textContent=error.message;$('runpod-error').hidden=false;}finally{button.disabled=false;}
});
$('runpod-check').addEventListener('click',async()=>{
  $('runpod-check').disabled=true;$('runpod-error').hidden=true;$('runpod-health').textContent='Checking your RunPod worker…';
  try{const health=await api('/api/runpod/check','POST',{});$('runpod-health').textContent=health.ready?'BF16 worker ready. You can generate songs on RunPod.':(health.error||health.stage);}catch(error){$('runpod-health').textContent='';$('runpod-error').textContent=error.message;$('runpod-error').hidden=false;}finally{$('runpod-check').disabled=false;}
});
$('runpod-disconnect').addEventListener('click',async()=>{
  $('runpod-disconnect').disabled=true;$('runpod-error').hidden=true;
  try{await api('/api/runpod/connection','DELETE');$('runpod-url').value='';$('runpod-token').value='';$('runpod-health').textContent='';await refresh();toast('RunPod disconnected. Manage the pod separately to stop billing.');}catch(error){$('runpod-error').textContent=error.message;$('runpod-error').hidden=false;}finally{$('runpod-disconnect').disabled=false;}
});
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && page === 'create') { event.preventDefault(); $('song-form').requestSubmit(); } });
document.addEventListener('play', event => { if (event.target.tagName === 'AUDIO') for (const audio of document.querySelectorAll('audio')) if (audio !== event.target) audio.pause(); }, true);
const sheetMusic = setupSheetMusic({ getStudio: () => studio, api, refresh, toast, loadDraft, markDirty, showPage });
const finder = setupFinder({ getStudio: () => studio, api, refresh, toast, showPage, selectTranscription: id => sheetMusic.select(id) });
const compositionScore = setupCompositionScore({ getStudio: () => studio, markDirty, renderEngine });
const lyricsWorkspace = setupLyrics({ api, toast, getComposer: () => draft(), useLyrics: value => {
  $('title').value = value.title; $('lyrics').value = value.lyrics;
  markDirty(); showPage('create'); toast('Lyrics loaded. Choose your sound and generate a song.');
} });
$('lyrics-partner').addEventListener('click', async () => {
  showPage('lyrics');
  try { await lyricsWorkspace.importComposer(); } catch (error) { toast(error.message); }
});
const videoWorkspace = setupVideos({ getStudio: () => studio, api, refresh, toast, showPage });
const mastering = setupMastering({ getStudio: () => studio, api, toast, refresh });
await refresh(true);
setInterval(() => refresh(), 2000);

