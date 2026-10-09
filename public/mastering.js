export function setupMastering({ getStudio, api, toast, refresh }) {
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let songId = null, busy = false, signature = '';
  function describe() {
    const preset = getStudio()?.mastering?.presets.find(p => p.id === $('master-preset').value);
    $('master-description').textContent = preset?.description ?? '';
  }
  function render() {
    if (!songId || !$('master-dialog').open) return;
    const jobs = getStudio()?.mastering?.jobs.filter(j => j.songId === songId) ?? [];
    const next = JSON.stringify(jobs);
    if (next === signature) return;
    signature = next;
    $('master-results').innerHTML = jobs.length ? jobs.map(job => {
      const name = getStudio().mastering.presets.find(p => p.id === job.preset)?.name ?? job.preset;
      return `<article class="master-result"><h3>${escape(name)} master</h3><p role="status">${escape(job.stage)}</p>${job.error ? `<p class="error-message">${escape(job.error)}</p>` : ''}${job.hasAudio ? `<audio controls preload="metadata" aria-label="${escape(name)} mastered audio" src="/api/masters/${job.id}/audio"></audio><a class="secondary" href="/api/masters/${job.id}/audio?download">Download ${escape(name)} master ↓</a>` : ''}</article>`;
    }).join('') : '<p class="helper">Your mastered versions will appear here.</p>';
  }
  function open(id) {
    const song = getStudio()?.songs.find(s => s.id === id);
    if (!song?.hasAudio) return;
    if ($('song-dialog').open) $('song-dialog').close();
    songId = id; signature = '';
    $('master-title').textContent = song.title;
    $('master-original').src = `/api/songs/${id}/audio`;
    $('master-preset').innerHTML = getStudio().mastering.presets.map(p => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('');
    $('master-error').hidden = true;
    describe(); $('master-dialog').showModal(); render();
  }
  $('master-preset').addEventListener('change', describe);
  $('close-master').addEventListener('click', () => $('master-dialog').close());
  $('master-dialog').addEventListener('close', () => {
    $('master-dialog').querySelectorAll('audio').forEach(audio => audio.pause());
    $('master-original').removeAttribute('src'); $('master-original').load();
    $('master-results').innerHTML = ''; songId = null; signature = '';
  });
  $('master-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !songId) return;
    busy = true; $('create-master').disabled = true; $('master-error').hidden = true;
    try {
      await api(`/api/songs/${songId}/masters`, 'POST', { preset: $('master-preset').value });
      toast('Mastering started locally. Your original is saved.'); await refresh(); render();
    } catch (error) { $('master-error').textContent = error.message; $('master-error').hidden = false; }
    finally { busy = false; $('create-master').disabled = false; }
  });
  return { open, render };
}
