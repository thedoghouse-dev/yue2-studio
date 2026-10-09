const BASE = 'https://openrouter.ai/api/v1';
const problem = (message, status = 502) => Object.assign(new Error(message), { status });

export const LYRIC_SYSTEM = `You are a collaborative songwriting partner. Help the user write original, singable lyrics through conversation. Ask focused questions when useful and follow their language, theme, rhyme, meter, and genre preferences. Discuss ideas naturally. When proposing a complete or revised lyric draft, wrap ONLY the complete lyrics in <lyrics> and </lyrics>, with discussion outside those tags. Use simple section tags such as [Verse], [Chorus], [Bridge], and [Outro]. Include all sections, not just changed lines, in each proposed draft. Do not include a title or production commentary inside the lyrics block. The user's editable draft is the current source of truth, even if it differs from earlier suggestions. Do not claim to save lyrics or generate audio; the user does that in the app.`;

export function extractLyrics(content) {
  const match = /<lyrics>\s*([\s\S]*?)\s*<\/lyrics>/i.exec(content);
  return match && match[1].trim().length <= 12000 ? match[1].trim() : null;
}

export function createOpenRouterClient({ fetchImpl = fetch } = {}) {
  async function request(endpoint, key, payload) {
    let response;
    try {
      response = await fetchImpl(BASE + endpoint, {
        method: payload ? 'POST' : 'GET', redirect: 'error',
        headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(payload ? { 'Content-Type': 'application/json' } : {}), 'X-Title': 'YuE2 Studio' },
        ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(payload ? 120000 : 20000),
      });
    } catch (error) {
      throw problem(error.name === 'TimeoutError' ? 'OpenRouter took too long. Your draft is saved; try again.' : 'Could not reach OpenRouter. Check your connection and try again.');
    }
    let result;
    try { result = await response.json(); } catch { throw problem('OpenRouter returned an unreadable response. Try again.'); }
    if (!response.ok || result.error) {
      const code = Number(result.error?.code ?? response.status);
      const messages = { 401: 'OpenRouter rejected the API key. Update your key.', 402: 'Your OpenRouter account needs credits for this model.', 403: 'OpenRouter denied this request. Check your key and account settings.', 429: 'OpenRouter is rate limiting requests. Wait a moment and try again.' };
      // Do not echo provider errors: they can contain credentials or request content.
      throw problem(messages[code] ?? 'The selected model could not complete this request. Try again or choose another model.', code >= 400 && code < 600 ? code : 502);
    }
    return result;
  }
  return {
    async models(key) {
      const result = await request('/models', key);
      if (!Array.isArray(result.data)) throw problem('OpenRouter returned no model catalog.');
      return result.data.filter(m => m.architecture?.input_modalities?.includes('text') && m.architecture?.output_modalities?.includes('text')).map(m => ({ id: m.id, name: m.name, pricing: { prompt: m.pricing?.prompt, completion: m.pricing?.completion }, contextLength: m.context_length })).sort((a,b) => a.name.localeCompare(b.name));
    },
    async chat(key, session, message) {
      const messages = [{ role: 'system', content: LYRIC_SYSTEM }, ...session.messages.map(m => ({ role: m.role, content: m.content })), { role: 'user', content: `Current song title: ${JSON.stringify(session.title)}\nCurrent editable lyric draft:\n<current_draft>\n${session.lyrics}\n</current_draft>\n\nMy request:\n${message}` }];
      const result = await request('/chat/completions', key, { model: session.model, messages, max_tokens: 4096, stream: false });
      const choice = result.choices?.[0], content = choice?.message?.content;
      if (typeof content !== 'string' || !content.trim() || content.length > 40000) throw problem('The model returned no usable text. Try another model.');
      const truncated = choice.finish_reason === 'length';
      return { content, proposedLyrics: truncated ? null : extractLyrics(content), model: result.model ?? session.model, truncated };
    },
  };
}
