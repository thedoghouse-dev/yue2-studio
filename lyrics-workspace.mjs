import path from 'node:path';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createOpenRouterClient } from './openrouter.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function read(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
function write(file, value) { writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(file + '.tmp', file); }
function field(value, name, max) { if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail(`${name} must be text up to ${max} characters.`); return value.trim(); }
function fields(input) {
  if (!input || typeof input !== 'object') fail('A lyric draft is required.');
  const model = field(input.model ?? '', 'Model', 200);
  if (model && !/^[a-zA-Z0-9_./:@+-]+$/.test(model)) fail('Choose a valid OpenRouter model ID.');
  return { title: field(input.title ?? '', 'Title', 120) || 'Untitled lyrics', lyrics: field(input.lyrics ?? '', 'Lyrics', 12000), model };
}

export function createLyricsWorkspace({ data, client = createOpenRouterClient() }) {
  const file = path.join(data, 'lyrics-workspace.json'), keyFile = path.join(data, 'openrouter-connection.json');
  const db = read(file, { sessions: [] });
  let connection = read(keyFile, { key: '' }), catalog = null, catalogTime = 0;
  const busy = new Set();
  const connectionView = () => ({ configured: Boolean(connection.key) });
  const save = () => write(file, db);
  const summary = s => ({ id: s.id, title: s.title, model: s.model, lyrics: s.lyrics, updatedAt: s.updatedAt });
  return {
    list: () => [...db.sessions].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary),
    has: id => db.sessions.some(s => s.id === id),
    async handle(req, res, route, { body, send }) {
      if (!route.startsWith('/api/lyrics') && !route.startsWith('/api/openrouter')) return false;
      if (route === '/api/openrouter/connection' && req.method === 'PUT') {
        if (busy.size) fail('Wait for the lyric reply before changing your connection.', 409);
        const input = await body(req), key = field(input.key ?? '', 'API key', 512);
        if (!key || !/^[\x21-\x7E]+$/.test(key)) fail('Enter your OpenRouter API key.');
        if (busy.size) fail('Wait for the lyric reply before changing your connection.', 409);
        connection = { key }; write(keyFile, connection); catalog = null;
        send(res, 200, connectionView()); return true;
      }
      if (route === '/api/openrouter/connection' && req.method === 'DELETE') {
        if (busy.size) fail('Wait for the lyric reply before disconnecting.', 409);
        connection = { key: '' }; write(keyFile, connection); catalog = null;
        send(res, 200, connectionView()); return true;
      }
      if (route === '/api/openrouter/models' && req.method === 'GET') {
        if (!catalog || Date.now() - catalogTime > 300000) { catalog = await client.models(connection.key); catalogTime = Date.now(); }
        send(res, 200, { models: catalog }); return true;
      }
      if (route === '/api/lyrics' && req.method === 'GET') {
        send(res, 200, { connection: connectionView(), sessions: [...db.sessions].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary) }); return true;
      }
      if (route === '/api/lyrics' && req.method === 'POST') {
        if (db.sessions.length >= 500) fail('The lyrics workspace has reached 500 saved drafts.', 409);
        const input = fields(await body(req)), now = new Date().toISOString();
        const session = { ...input, id: randomUUID(), createdAt: now, updatedAt: now, messages: [] };
        db.sessions.push(session); save(); send(res, 201, session); return true;
      }
      const match = /^\/api\/lyrics\/([a-f0-9-]{36})(\/chat)?$/.exec(route);
      if (match) {
        const session = db.sessions.find(s => s.id === match[1]); if (!session) fail('Lyric draft not found.', 404);
        if (!match[2] && req.method === 'GET') { send(res, 200, session); return true; }
        if (busy.has(session.id)) fail('A reply is already in progress for this draft.', 409);
        if (!match[2] && req.method === 'PUT') {
          const input = fields(await body(req));
          if (busy.has(session.id)) fail('A reply is already in progress for this draft.', 409);
          Object.assign(session, input, { updatedAt: new Date().toISOString() }); save(); send(res, 200, session); return true;
        }
        if (match[2] && req.method === 'POST') {
          if (!connection.key) fail('Connect OpenRouter with your API key first.');
          if (!session.model) fail('Choose a model first.');
          if (session.messages.length >= 120 || session.messages.reduce((n,m) => n + m.content.length, 0) > 180000) fail('This conversation is full. Start a new draft with your current lyrics.', 409);
          if (busy.size >= 3) fail('Three lyric conversations are already waiting for replies.', 409);
          const input = await body(req), message = field(input.message, 'Message', 8000); if (!message) fail('Write a message first.');
          // Recheck after reading the body, so simultaneous requests cannot duplicate paid calls.
          if (busy.has(session.id)) fail('A reply is already in progress for this draft.', 409);
          if (busy.size >= 3) fail('Three lyric conversations are already waiting for replies.', 409);
          busy.add(session.id);
          try {
            const reply = await client.chat(connection.key, session, message);
            session.messages.push({ role: 'user', content: message, createdAt: new Date().toISOString() }, { role: 'assistant', ...reply, createdAt: new Date().toISOString() });
            session.updatedAt = new Date().toISOString(); save(); send(res, 200, session); return true;
          } finally { busy.delete(session.id); }
        }
      }
      fail('Lyrics endpoint not found.', 404);
    },
  };
}
