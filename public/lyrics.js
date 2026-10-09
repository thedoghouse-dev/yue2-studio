const $ = id => document.getElementById(id);
const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LOCAL = 'yue2-lyrics-workspace';

export function setupLyrics({ api, toast, useLyrics, getComposer }) {
  let initialized = false, session = null, sessions = [], models = [], configured = false, dirty = false, busy = false, initializing;
  const snapshot = () => ({ id: session?.id ?? null, title: $('lyric-title').value, lyrics: $('lyric-draft').value, model: $('lyric-model').value, prompt: $('lyric-message').value });
  function remember() { try { localStorage.setItem(LOCAL, JSON.stringify(snapshot())); } catch {} }
  function error(message = '') {
    for (const id of ['lyric-error', 'openrouter-error']) { $(id).textContent = message; $(id).hidden = !message; }
  }
  function status() {
    $('lyric-save-status').textContent = busy ? 'Working…' : dirty ? 'Unsaved changes · kept in this browser' : session ? 'Draft saved on this computer' : 'Start a conversation or write your own draft';
    $('openrouter-status').textContent = configured ? 'Your API key is saved on this computer. Choose a writing model below, then open Write lyrics.' : 'No API key saved. Add your OpenRouter API key to start chatting.';
    $('openrouter-status').classList.toggle('saved', configured);
    $('openrouter-key-badge').textContent = configured ? '✓ Key saved' : 'No key saved';
    $('openrouter-key-badge').classList.toggle('saved', configured);
    $('openrouter-key').placeholder = configured ? 'Key saved · enter a new key to replace it' : 'Paste your OpenRouter API key';
    $('openrouter-save').textContent = configured ? 'Update key' : 'Save key';
    const modelId = $('lyric-model').value.trim(), modelName = models.find(m => m.id === modelId)?.name ?? modelId;
    $('lyric-partner-status').textContent = !configured ? 'Set up OpenRouter in Engine settings to chat with a writing partner.' : modelId ? `Writing partner: ${modelName}` : 'Choose your writing model in Engine settings.';
    $('lyric-send').disabled = busy || !configured || !modelId;
    for (const id of ['lyric-save','lyric-use','lyric-new','lyric-import','lyric-title','lyric-draft','lyric-model','lyric-message','openrouter-key','openrouter-save','openrouter-disconnect','lyric-model-refresh']) $(id).disabled = busy;
    $('lyric-use').disabled = busy || !$('lyric-draft').value.trim();
    for (const button of $('lyric-sessions').querySelectorAll('button')) button.disabled = busy;
    for (const button of $('lyric-history').querySelectorAll('button')) button.disabled = busy;
  }
  function list() {
    $('lyric-sessions').innerHTML = sessions.length ? sessions.map(s => `<button type="button" class="lyric-session ${session?.id === s.id ? 'active' : ''}" data-lyric-session="${s.id}"><strong>${escape(s.title)}</strong><small>${escape(s.model || 'Written by you')} · ${escape(new Date(s.updatedAt).toLocaleDateString())}</small></button>`).join('') : '<p class="field-help">Your saved lyric drafts and conversations will collect here.</p>';
  }
  function history() {
    $('lyric-history').innerHTML = session?.messages?.length ? session.messages.map((message,index) => `<article class="lyric-message ${message.role}"><div class="lyric-message-label">${message.role === 'user' ? 'YOU' : escape(message.model || 'WRITING PARTNER')}</div><div class="lyric-message-text">${escape(message.content.replace(/<\/?lyrics>/gi,''))}</div>${message.proposedLyrics ? `<button type="button" class="secondary" data-lyric-apply="${index}">Use this lyric draft ↗</button>` : ''}${message.truncated ? '<p class="error-message">This reply reached its output limit. Ask the model for a shorter, complete draft.</p>' : ''}</article>`).join('') : '<div class="lyric-chat-empty"><h3>Find the words together.</h3><p>Share a theme, a story, a few lines, or the feeling you want. Ask for changes until the lyrics sound like you.</p><p>Try: “Help me write a hopeful folk song about starting over. Let’s work on the chorus first.”</p></div>';
    $('lyric-history').scrollTop = $('lyric-history').scrollHeight;
  }
  function modelInfo() {
    status();
    const model = models.find(m => m.id === $('lyric-model').value);
    if (!model) { $('lyric-model-info').textContent = $('lyric-model').value ? 'Previously selected model. Refresh models to check current availability and pricing.' : 'Pick a model from the dropdown to use as your lyric writing partner.'; return; }
    const price = value => Number.isFinite(Number(value)) && value != null ? `$${(Number(value) * 1000000).toLocaleString(undefined,{maximumFractionDigits:2})}` : 'Unavailable';
    $('lyric-model-info').textContent = `${model.name} · per 1M tokens: input ${price(model.pricing.prompt)}, output ${price(model.pricing.completion)}. OpenRouter usage is billed to your account.`;
  }
  function modelOptions() {
    const selected = $('lyric-model').value;
    const groups = [['anthropic', 'Anthropic · Claude'], ['openai', 'OpenAI · ChatGPT']];
    const matching = models.filter(m => groups.some(([provider]) => m.id.startsWith(provider + '/')));
    $('lyric-model').innerHTML = '<option value="">Choose a Claude or ChatGPT model…</option>' + groups.map(([provider,label]) => {
      const entries = matching.filter(m => m.id.startsWith(provider + '/'));
      return entries.length ? `<optgroup label="${label}">${entries.map(m => `<option value="${escape(m.id)}">${escape(m.name)}</option>`).join('')}</optgroup>` : '';
    }).join('');
    selectModel(selected);
    $('lyric-model-catalog-status').textContent = matching.length ? `${matching.length} Claude and OpenAI models available` : 'No models loaded. Click Refresh models to try again.';
    modelInfo();
  }
  function selectModel(id) {
    if (id && ![...$('lyric-model').options].some(option => option.value === id)) $('lyric-model').add(new Option(`Previously selected · ${id}`, id));
    $('lyric-model').value = id;
  }
  async function catalog() {
    try { models = (await api('/api/openrouter/models')).models; modelOptions(); }
    catch (e) { $('lyric-model-catalog-status').textContent = e.message + ' Click Refresh models to try again.'; }
  }
  function load(value, local) {
    session = value;
    $('lyric-title').value = local?.title ?? value?.title ?? '';
    $('lyric-draft').value = local?.lyrics ?? value?.lyrics ?? '';
    selectModel(local?.model ?? value?.model ?? '');
    $('lyric-message').value = local?.prompt ?? '';
    dirty = Boolean(local && (value ? local.title !== value.title || local.lyrics !== value.lyrics || local.model !== value.model : local.title || local.lyrics || local.model));
    history(); list(); modelInfo(); status(); remember();
  }
  async function save() {
    const value = snapshot();
    session = await api(session ? `/api/lyrics/${session.id}` : '/api/lyrics', session ? 'PUT' : 'POST', { title:value.title, lyrics:value.lyrics, model:value.model });
    $('lyric-title').value = session.title;
    sessions = [{ id:session.id, title:session.title, model:session.model, updatedAt:session.updatedAt }, ...sessions.filter(s => s.id !== session.id)];
    dirty = false; list(); remember(); status(); return session;
  }
  async function action(work) {
    if (busy) return; busy = true; error(); status();
    try { await work(); } catch (e) { error(e.message); } finally { busy = false; status(); }
  }
  async function init() {
    const result = await api('/api/lyrics'); sessions = result.sessions; configured = result.connection.configured;
    let local; try { local = JSON.parse(localStorage.getItem(LOCAL)); } catch {}
    const chosen = local?.id && sessions.find(s => s.id === local.id);
    load(chosen ? await api(`/api/lyrics/${chosen.id}`) : null, local);
    initialized = true; await catalog();
  }
  async function open() {
    if (initialized) return;
    if (!initializing) initializing = init().finally(() => initializing = null);
    return initializing;
  }
  for (const id of ['lyric-title','lyric-draft']) $(id).addEventListener('input', () => { dirty = true; remember(); status(); });
  $('lyric-model').addEventListener('change', () => { dirty = true; remember(); error(); modelInfo(); });
  $('lyric-message').addEventListener('input', remember);
  $('lyric-model-refresh').addEventListener('click', () => action(catalog));
  $('lyric-save').addEventListener('click', () => action(async () => { await save(); toast('Lyrics and conversation saved'); }));
  $('lyric-use').addEventListener('click', () => action(async () => { await save(); useLyrics({title:session.title,lyrics:session.lyrics}); }));
  $('lyric-new').addEventListener('click', () => action(async () => { if (dirty) await save(); const model = $('lyric-model').value; load(null, { title:'',lyrics:'',model,prompt:'' }); $('lyric-title').focus(); }));
  async function importComposer() {
    await open();
    await action(async () => { if (dirty) await save(); const value = getComposer(); load(null, {title:value.title,lyrics:value.lyrics,model:$('lyric-model').value,prompt:''}); toast('Composer lyrics loaded into a new writing draft'); });
  }
  $('lyric-import').addEventListener('click', importComposer);
  $('lyric-sessions').addEventListener('click', event => {
    const id = event.target.closest('[data-lyric-session]')?.dataset.lyricSession; if (!id) return;
    action(async () => { if (dirty) await save(); load(await api(`/api/lyrics/${id}`)); error(); });
  });
  $('lyric-history').addEventListener('click', event => {
    const button = event.target.closest('[data-lyric-apply]'); if (!button || busy) return;
    const proposal = session.messages[Number(button.dataset.lyricApply)].proposedLyrics; if (!proposal) return;
    $('lyric-draft').value = proposal; dirty = true; remember(); status(); toast('Suggested lyrics loaded into your editable draft');
  });
  $('lyric-chat-form').addEventListener('submit', event => {
    event.preventDefault();
    action(async () => {
      if (!configured) throw new Error('Add your OpenRouter API key in Engine settings first.');
      if (!$('lyric-model').value.trim()) throw new Error('Choose a writing model in Engine settings first.');
      const message = $('lyric-message').value.trim(); if (!message) throw new Error('Write a message first.');
      await save();
      $('lyric-chat-status').textContent = 'Your writing partner is thinking…';
      try {
        session = await api(`/api/lyrics/${session.id}/chat`, 'POST', { message });
        $('lyric-message').value = ''; remember(); history();
        sessions = [{id:session.id,title:session.title,model:session.model,updatedAt:session.updatedAt},...sessions.filter(s => s.id !== session.id)]; list();
      } finally { $('lyric-chat-status').textContent = ''; }
    });
  });
  $('openrouter-form').addEventListener('submit', event => {
    event.preventDefault(); const key = $('openrouter-key').value;
    action(async () => { const result = await api('/api/openrouter/connection','PUT',{key}); configured = result.configured; $('openrouter-key').value = ''; toast('OpenRouter key saved locally'); await catalog(); });
  });
  $('openrouter-disconnect').addEventListener('click', () => action(async () => { await api('/api/openrouter/connection','DELETE'); configured = false; $('openrouter-key').value=''; toast('OpenRouter disconnected'); }));
  return { open, importComposer };
}
