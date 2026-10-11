import {createRunpodQueueClient} from './runpod-queue-client.mjs';
import { createRunpodManagement } from './runpod-management.mjs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync, createReadStream, createWriteStream, appendFileSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { copyFileSync } from 'node:fs';
import { createRecordingSource } from './recordings.mjs';
import { createRunpodClient, validateRunpodURL } from './runpod-client.mjs';
import { createLyricsWorkspace } from './lyrics-workspace.mjs';
import { createMastering } from './mastering.mjs';
import { createVideos } from './videos.mjs';
import { createProjects } from './projects.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SIDECARS = ['yue2-model-config.json', 'yue2-generation-config.json', 'yue2-qwen.tiktoken', 'yue2-vae-config.json'];
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.abc': 'text/plain; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
Object.assign(mime,{'.mp4':'video/mp4','.mp3':'audio/mpeg','.ogg':'audio/ogg','.opus':'audio/ogg','.flac':'audio/flac','.m4a':'audio/mp4','.aac':'audio/aac','.aif':'audio/aiff','.aiff':'audio/aiff','.webm':'audio/webm'});
Object.assign(mime,{'.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'});

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function text(value, name, max, required = false) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail(`${name} must be text up to ${max} characters.`);
  if (required && !value.trim()) fail(`${name} is required.`);
  return value.trim();
}
function number(value, name, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`);
  return value;
}
export function validateSong(input) {
  if (!input || typeof input !== 'object') fail('A song request is required.');
  const mode = input.mode ?? 'full';
  if (!['full', 'melody', 'off'].includes(mode)) fail('Choose a valid planning mode.');
  const abc = text(input.abc ?? '', 'Score', 30000);
  const execution = input.execution ?? 'local';
  if (!['local','runpod'].includes(execution)) fail('Choose local or RunPod generation.');
  const durationSeconds = input.durationSeconds === undefined || input.durationSeconds === null || input.durationSeconds === '' ? null : number(input.durationSeconds, 'Song length in seconds', 10, 360, true);
  const durationMode=input.durationMode??'maximum',scoreUse=input.scoreUse??'follow';
  if(!['maximum','target'].includes(durationMode))fail('Choose maximum or target length.');
  if(!['follow','motif'].includes(scoreUse))fail('Choose follow score or develop as a motif.');
  if (abc && mode === 'off') fail('Choose full or melody planning to use an ABC score.');
  const lyricSource = text(input.lyricSource ?? '', 'Lyric source', 36);
  const scoreSource = text(input.scoreSource ?? '', 'Score source', 60);
  if (lyricSource && !/^[a-f0-9-]{36}$/.test(lyricSource)) fail('Choose a saved lyric draft.');
  if (scoreSource && !/^(custom|(?:song|transcription):[a-f0-9-]{36})$/.test(scoreSource)) fail('Choose a valid score source.');
  return {
    lyricSource, scoreSource,
    title: text(input.title, 'Title', 120, true), style: text(input.style, 'Style', 2500, true),
    lyrics: text(input.lyrics ?? '', 'Lyrics', 12000), mode, abc, execution,
    seed: number(input.seed ?? 1234, 'Seed', 0, 2147483647, true),
    durationSeconds, durationMode, scoreUse,
    maxTokens: durationSeconds === null ? number(input.maxTokens ?? 3000, 'Length limit', 200, 9000, true) : durationSeconds * 25,
    steps: number(input.steps ?? 8, 'Render steps', 1, 32, true),
    temperature: number(input.temperature ?? 1, 'Variation', 0.1, 2),
  };
}
export function buildArgs(song, settings, dir) {
  const args = ['--task', 'gen', '--family', 'yue2', '--model', settings.modelDir,
    '--backend', settings.backend, '--threads', '8',
    '--session-option', `yue2.model_gguf=${settings.modelFile}`,
    '--session-option', 'yue2.vae_gguf=yue2-vae-f16.gguf',
    '--lyrics', song.lyrics.trim() ? song.lyrics : '[instrumental]', '--request-option', `style=${song.lyrics.trim() ? song.style : 'instrumental, no vocals, no singing, ' + song.style}${song.abc && song.scoreUse==='motif' ? ', develop the supplied melody as a recurring motif, variations, contrasting sections, build and release, return to the theme, complete musical ending' : ''}`,
    '--request-option', `cot=${song.mode}`, '--seed', String(song.seed),
    '--request-option', `semantic_max_tokens=${song.maxTokens}`,
    '--request-option', `semantic_min_tokens=${song.durationMode==='target'&&song.durationSeconds ? Math.max(200,song.maxTokens-50) : 200}`,
    '--request-option', `semantic_temperature=${song.temperature}`,
    '--request-option', `num_inference_steps=${song.steps}`,
    '--out', path.join(dir, 'audio.wav'), '--out-dir', dir, '--log'];
  if (song.abc) args.push('--request-option', `abc_file=${path.join(dir, 'input.abc')}`);
  return args;
}
export function buildTranscriptionArgs(settings, dir) {
  return ['--task', 'midi', '--family', 'sheetsage2', '--model', settings.sheetSageModel,
    '--backend', settings.backend, '--threads', '8', '--audio', path.join(dir, 'source.wav'),
    '--out', path.join(dir, 'score.abc'), '--out-dir', dir, '--log'];
}
const MAX_UPLOAD = 128 * 1024 * 1024;
export function validateAudioName(value) {
  const name = text(value, 'Audio filename', 255, true);
  if (name !== path.basename(name) || /[\\/]/.test(name)) fail('Use a filename without a folder path.');
  const extension = path.extname(name).toLowerCase();
  if (!['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.aac', '.aiff', '.aif', '.opus', '.webm'].includes(extension)) fail('Choose a WAV, MP3, FLAC, M4A, OGG, AAC, AIFF, Opus, or WebM file.');
  return { name, extension };
}
async function upload(req, file) {
  if (Number(req.headers['content-length']) > MAX_UPLOAD) fail('Audio files must be 128 MB or smaller.', 413);
  let bytes = 0;
  const limiter = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    callback(bytes > MAX_UPLOAD ? Object.assign(new Error('Audio files must be 128 MB or smaller.'), { status: 413 }) : null, chunk);
  } });
  try {
    await pipeline(req, limiter, createWriteStream(file));
    if (bytes < 12) fail('The audio file is empty or too small.');
    return bytes;
  } catch (error) { if (existsSync(file)) unlinkSync(file); throw error; }
}
function atomic(file, value) {
  writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); renameSync(file + '.tmp', file);
}
function readJSON(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${file}: ${e.message}`); }
}
async function body(req, limit = 150000) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) fail('Request is too large.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('Invalid JSON.'); }
}
function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload));
}
function serveFile(req, res, file, download = false, name) {
  if (!existsSync(file) || !statSync(file).isFile()) fail('File not found.', 404);
  const size = statSync(file).size;
  const headers = { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  if (download) headers['Content-Disposition'] = `attachment; filename="${name ?? path.basename(file)}"`;
  const range = req.headers.range;
  let start = 0, end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else start = Number(match[1]);
    if (match[1] && match[2]) end = Math.min(end, Number(match[2]));
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || size === 0) { res.end(); return; }
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}

export function createStudio({ root = ROOT, spawnRunner = spawn, checkRuntime, checkSheetSage, recordingSource = createRecordingSource(), runpodClient = createRunpodClient(), runpodQueueClient = createRunpodQueueClient(), openRouterClient, masteringExecutable, videoProviders, runpodControlClient } = {}) {
  const data = path.join(root, 'data');
  const songsDir = path.join(data, 'songs');
  mkdirSync(songsDir, { recursive: true });
  const lyricsWorkspace = createLyricsWorkspace({ data, client: openRouterClient });
  const transcriptionsDir = path.join(data, 'transcriptions');
  mkdirSync(transcriptionsDir, { recursive: true });
  const dbFile = path.join(data, 'studio.json');
  const defaults = { executable: path.join(root, 'runtime', 'audiocpp_cli.exe'), modelDir: path.join(root, 'models', 'YuE2'), modelFile: 'yue2-3b-q4_0.gguf', backend: 'cuda', sheetSageModel: path.join(root, 'models', 'SheetSage2', 'sheetsage2-orig.gguf') };
  const db = readJSON(dbFile, { songs: [], draft: null, settings: defaults });
  db.settings = { ...defaults, ...db.settings };
  db.transcriptions ??= [];
  db.recordings ??= [];
  const recordingsDir = path.join(data, 'recordings'); mkdirSync(recordingsDir, { recursive: true });
  const downloading = new Set();
  const cloudFile=path.join(data,'runpod-connection.json');
  let cloud=readJSON(cloudFile,{url:'',token:''});
  const cloudView=()=>({url:cloud.url??'',mode:cloud.mode??'pod',endpointId:cloud.endpointId??'',configured:cloud.mode==='serverless'?Boolean(cloud.endpointId&&runpodManagement.inferenceKey()&&runpodManagement.state().inventory?.endpoints.find(e=>e.id===cloud.endpointId)?.maxWorkers!==0):Boolean(cloud.url&&cloud.token),model:'BF16 + F32 VAE'});
  for (const song of [...db.songs, ...db.transcriptions]) if (['running', 'queued'].includes(song.status)) { song.status = 'interrupted'; song.stage = 'Interrupted'; song.error = 'The app stopped before this session finished. Start a new session to try again.'; }
  for (const song of db.songs) if (/yue2\.semantic\.truncated\s*[:=]?\s*(1|true)/.test(song.logTail ?? '')) song.truncated = true;
  const save = () => atomic(dbFile, db);
  const projects=createProjects({db,save,onRemove:id=>videos.clearProject(id)});
  save();
  let active = null, closing = false;
  const token = randomBytes(32).toString('hex');
  const directory = id => path.join(db.transcriptions.some(s => s.id === id) ? transcriptionsDir : songsDir, id);
  const converter = path.join(root, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
  const mastering = createMastering({ data, executable: masteringExecutable ?? converter });
  const videos = createVideos({ onRunpodActivity:config=>runpodManagement.recordUsage({endpointId:config.runpodMode==='serverless'?config.endpointId:undefined,podURL:config.podURL},'Video generation requested'),getRunpodAccountKey:()=>runpodManagement.inferenceKey(),validProject:projects.validProject, data, executable: masteringExecutable ?? converter, providers: videoProviders, getSource: (songId, masterId) => {
    const song = db.songs.find(s => s.id === songId);
    if (!song || song.deletedAt || song.status !== 'completed' || !existsSync(path.join(songsDir,songId,'audio.wav'))) fail('Choose a finished song with audio.',409);
    if (masterId) {
      const master = mastering.get(masterId);
      if (master.songId !== songId || !master.hasAudio) fail('Choose a finished master of this song.',409);
      return { file: mastering.audio(masterId), title: song.title };
    }
    return { file: path.join(songsDir,songId,'audio.wav'), title: song.title };
  }});
  const jobs = () => [...db.songs, ...db.transcriptions];
  const runpodManagement=createRunpodManagement({root,data,client:runpodControlClient,workerClient:runpodClient,
    connectVideo:config=>videos.connectRunpod(config),connectServerless:config=>videos.connectServerless(config),
    connectSongServerless:async config=>{if(active||jobs().some(s=>s.status==='queued'))fail('Wait for the song queue before changing the engine.',409);cloud=config;atomic(cloudFile,cloud);},
    connectWorker:async config=>{if(active||jobs().some(s=>s.status==='queued'))fail('Wait for the generation queue before changing the worker.',409);cloud=config;atomic(cloudFile,cloud);},
    isBusy:id=>{const songBusy=cloud.url===`https://${id}-8000.proxy.runpod.net`&&db.songs.some(s=>s.execution==='runpod'&&['queued','running'].includes(s.status));const state=videos.state();return songBusy||(state.connection.podURL===`https://${id}-30010.proxy.runpod.net`&&state.jobs.some(v=>v.provider==='runpod'&&['queued','running'].includes(v.status)));}
  });
  function sheetReady() {
    if (checkSheetSage) return checkSheetSage(db.settings);
    const missing = [];
    for (const [file, label] of [[db.settings.executable, 'Windows generation runtime'], [db.settings.sheetSageModel, 'SheetSage2 model'], [converter, 'Audio converter']]) if (!existsSync(file) || statSync(file).size === 0) missing.push(label);
    return { ready: !missing.length, missing };
  }
  function ready() {
    if (checkRuntime) return checkRuntime(db.settings);
    const missing = [];
    if (!existsSync(db.settings.executable)) missing.push('Windows generation runtime');
    for (const name of [db.settings.modelFile, 'yue2-vae-f16.gguf', ...SIDECARS.map(x => `sidecars/${x}`)]) {
      const file = path.join(db.settings.modelDir, name);
      if (!existsSync(file) || statSync(file).size === 0) missing.push(name);
    }
    return { ready: missing.length === 0, missing };
  }
  function songDeletionBlockers(song){
    const videoState=videos.state();
    return [
      ...([...videoState.jobs,...videoState.trash].filter(j=>j.songId===song.id).map(j=>({type:'video',title:j.title,inTrash:Boolean(j.deletedAt)}))),
      ...mastering.list(song.id).map(j=>({type:'master',title:j.title+' · '+j.preset})),
      ...((active?.song.id===song.id||['running','queued'].includes(song.status))?[{type:'generation',title:'Song generation is still active'}]:[])
    ];
  }
  function view(song) {
    const result = { ...song };
    if(song.kind!=='transcription')result.deletionBlockers=songDeletionBlockers(song);
    result.hasAudio = song.status === 'completed' && existsSync(path.join(directory(song.id), 'audio.wav'));
    result.hasScore = (song.kind !== 'transcription' || song.status === 'completed') && existsSync(path.join(directory(song.id), song.abc ? 'input.abc' : 'score.abc'));
    return result;
  }
  function runNext() {
    if (active || closing) return;
    const song = jobs().filter(s => s.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!song) return;
    const dir = directory(song.id);
    song.status = 'running'; song.stage = 'Loading model'; song.startedAt = new Date().toISOString(); save();
    let child;
    const done = (code, error) => {
      if (active?.song.id !== song.id) return;
      song.finishedAt = new Date().toISOString();
      if (song.status !== 'cancelled') {
        const transcription = song.kind === 'transcription';
        const file = path.join(dir, transcription ? 'score.abc' : 'audio.wav');
        const valid = existsSync(file) && (transcription ? /^X:/m.test(readFileSync(file, 'utf8')) && /^K:/m.test(readFileSync(file, 'utf8')) : statSync(file).size > 44);
        song.status = !error && code === 0 && valid ? 'completed' : 'failed';
        song.stage = song.status === 'completed' ? (transcription ? 'Score ready' : 'Ready to listen') : (transcription ? 'Transcription failed' : 'Generation failed');
        if (song.status === 'failed') song.error = error?.message ?? `${transcription ? 'SheetSage2' : 'YuE2'} exited with code ${code}. Open the session log for details.`;
      }
      active = null; save(); setImmediate(runNext);
    };
    const launch = (executable, args, converting = false) => {
      try {
      child = spawnRunner(executable, args, {
        cwd: path.dirname(executable), windowsHide: true,
        env: { ...process.env, ENGINE_TIMING: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      active = { child, song };
      const log = chunk => {
        const content = chunk.toString();
        appendFileSync(path.join(dir, 'generation.txt'), content);
        song.logTail = ((song.logTail ?? '') + content).slice(-6000);
        if (song.kind === 'transcription') {
          if (!converting) song.stage = /postprocess|artifact_out/.test(content) ? 'Writing the score' : 'Transcribing melody and chords';
        } else if (/yue2\.vae|vae_decode/.test(content)) song.stage = 'Decoding stereo audio';
        else if (/yue2\.nar|synthesize|flow_matching/.test(content)) song.stage = 'Rendering music';
        else if (/abc_generate_ms|abc_generated_tokens|generate_cfg/.test(content)) song.stage = 'Composing audio';
        else if (/yue2\.ar|abc.*prefill/.test(content) && song.stage === 'Loading model') song.stage = song.mode === 'off' ? 'Composing audio' : 'Planning the composition';
        if (/yue2\.semantic\.truncated\s*[:=]?\s*(1|true)/.test(content)) song.truncated = true;
        save();
      };
      child.stdout.on('data', log); child.stderr.on('data', log);
      child.on('error', error => done(null, error)); child.on('close', code => {
        if (active?.song.id !== song.id) return;
        if (converting && code === 0 && song.status !== 'cancelled') {
          song.stage = 'Loading SheetSage2'; save(); launch(db.settings.executable, buildTranscriptionArgs(db.settings, dir));
        } else done(code);
      });
    } catch (error) {
      active = { song, child: null }; done(null, error);
    }
    };
    if (song.kind === 'transcription') {
      song.stage = 'Preparing the audio'; save();
      // Decode only the selected local file. Disable network protocols and cap duration at 10 minutes.
      launch(converter, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', path.join(dir, `upload${song.extension}`), '-t', '600', '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-y', path.join(dir, 'source.wav')], true);
    } else if(song.execution==='runpod') {
      const controller=new AbortController();const connection={...cloud,key:cloud.mode==='serverless'?runpodManagement.inferenceKey():undefined};
      active={song,child:{kill:()=>controller.abort(new Error('RunPod generation cancelled.'))}};
      song.stage='Connecting to RunPod';save();
      runpodManagement.recordUsage({endpointId:cloud.mode==='serverless'?cloud.endpointId:undefined,url:cloud.url},'Song generation requested');
      active.promise=(cloud.mode==='serverless'?runpodQueueClient:runpodClient).run(song,dir,connection,{signal:controller.signal,onProgress:job=>{
        if(song.status==='cancelled')return;
        if(job.remoteJobId)song.remoteJobId=job.remoteJobId;song.stage=job.stage||'Generating on RunPod';song.logTail=String(job.logTail??'').slice(-6000);song.truncated=Boolean(job.truncated);save();
      }}).then(job=>{
        if(song.status==='cancelled')return;
        if(!song.abc&&typeof job.abc==='string'&&job.abc.length<=30000)writeFileSync(path.join(dir,'score.abc'),job.abc);
        writeFileSync(path.join(dir,'generation.txt'),song.logTail??'');done(0);
      }).catch(error=>done(null,error)).finally(()=>{if(active?.song.id===song.id)done(null);});
    } else launch(db.settings.executable, buildArgs(song, db.settings, dir));
  }
  function cancel(song) {
    if (!['queued', 'running'].includes(song.status)) fail('This song is no longer generating.', 409);
    song.status = 'cancelled'; song.stage = 'Cancelled'; song.finishedAt = new Date().toISOString();
    if (active?.song.id === song.id) active.child?.kill(); save();
  }
  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'");
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) fail('Local access only.', 403);
      if (req.headers.origin && ![`http://${host}`].includes(req.headers.origin)) fail('Cross-origin requests are not allowed.', 403);
      const url = new URL(req.url, `http://${host}`);
      const route = url.pathname;
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-studio-token'] !== token) fail('Refresh the app and try again.', 403);
      if (await runpodManagement.handle(req,res,route,{body,send})) return;
      if (await videos.handle(req,res,route,{body,send,serveFile})) return;
      if (await projects.handle(req,res,route,{body,send})) return;
      if (await lyricsWorkspace.handle(req, res, route, { body, send })) return;
      if (route === '/api/studio' && req.method === 'GET') {
        return send(res, 200, { token, lyricSessions:lyricsWorkspace.list(), projects:projects.list(), videos: videos.state(), mastering: { presets: mastering.presets, jobs: mastering.list() }, settings: db.settings, runpod:cloudView(), runpodManagement:runpodManagement.state(), draft: db.draft, songs: db.songs.filter(s=>!s.deletedAt).map(view).reverse(), songTrash:db.songs.filter(s=>s.deletedAt).map(view).reverse(), transcriptions: db.transcriptions.map(view).reverse(), recordings: [...db.recordings].reverse(), sheetSage: sheetReady(), sheetSageSetup: readJSON(path.join(data, 'setup-sheetsage.json'), null), runtime: ready(), setup: readJSON(path.join(data, 'setup.json'), null) });
      }
      if(route==='/api/runpod/connection'&&req.method==='PUT'){
        if(active||jobs().some(s=>s.status==='queued'))fail('Wait for the current queue to finish before changing the RunPod connection.',409);
        const input=await body(req);const tokenValue=text(input.token??'','Worker token',256);
        const cloudToken=tokenValue||cloud.token;if(!/^[a-zA-Z0-9_-]{32,256}$/.test(cloudToken))fail('Use a random worker token with 32–256 letters, digits, underscores or hyphens.');
        let cloudURL;try{cloudURL=validateRunpodURL(text(input.url,'RunPod URL',300,true));}catch(error){fail(error.message);}
        cloud={url:cloudURL,token:cloudToken};atomic(cloudFile,cloud);return send(res,200,cloudView());
      }
      if(route==='/api/runpod/connection'&&req.method==='DELETE'){
        if(active||jobs().some(s=>s.status==='queued'))fail('Wait for the current queue to finish before disconnecting RunPod.',409);
        cloud={url:'',token:''};atomic(cloudFile,cloud);return send(res,200,cloudView());
      }
      if(route==='/api/runpod/check'&&req.method==='POST'){
        if(!cloudView().configured)fail('Connect your RunPod worker first.',400);
        return send(res,200,await (cloud.mode==='serverless'?runpodQueueClient.health({...cloud,key:runpodManagement.inferenceKey()}):runpodClient.health(cloud)));
      }
      if (route === '/api/recordings/search' && req.method === 'POST') {
        const input = await body(req); return send(res, 200, await recordingSource.search(input.query));
      }
      if (route === '/api/recordings' && req.method === 'POST') {
        const {pageId} = await body(req);
        if (!Number.isSafeInteger(pageId) || pageId <= 0) fail('Choose a valid recording.');
        const existing = db.recordings.find(r => r.pageId === pageId);
        if (existing) return send(res, 200, existing);
        if (downloading.has(pageId) || downloading.size >= 3) fail('A download is already in progress. Try again shortly.', 409);
        downloading.add(pageId);
        try {
          const item = await recordingSource.resolve(pageId);
          const id = randomUUID(), dir = path.join(recordingsDir,id); mkdirSync(dir);
          const bytes = await recordingSource.download(item,path.join(dir,`audio.${item.extension}`));
          const saved = {...item,id,bytes,downloadedAt:new Date().toISOString()};
          atomic(path.join(dir,'source.json'),saved); db.recordings.push(saved);save();return send(res,201,saved);
        } finally { downloading.delete(pageId); }
      }
      const recordingMatch = /^\/api\/recordings\/([a-f0-9-]{36})\/(audio|source|transcribe)$/.exec(route);
      if (recordingMatch) {
        const item = db.recordings.find(r=>r.id===recordingMatch[1]); if(!item) fail('Recording not found.',404);
        const file = path.join(recordingsDir,item.id,`audio.${item.extension}`);
        if(recordingMatch[2]==='transcribe' && req.method==='POST') {
          const runtime=sheetReady();if(!runtime.ready)fail(`SheetSage2 setup required: ${runtime.missing.join(', ')}`,503);
          if(jobs().filter(s=>['queued','running'].includes(s.status)).length>=10)fail('The queue is full.',409);
          const id=randomUUID(),dir=path.join(transcriptionsDir,id);mkdirSync(dir);
          copyFileSync(file,path.join(dir,`upload.${item.extension}`));
          const job={id,kind:'transcription',title:item.title.slice(0,120),filename:`${item.title.slice(0,100)}.${item.extension}`,extension:`.${item.extension}`,bytes:item.bytes,recordingId:item.id,status:'queued',stage:'Queued',createdAt:new Date().toISOString()};
          db.transcriptions.push(job);save();setImmediate(runNext);return send(res,201,view(job));
        }
        if(!['GET','HEAD'].includes(req.method))fail('Method not allowed.',405);
        if(recordingMatch[2]==='source')return serveFile(req,res,path.join(recordingsDir,item.id,'source.json'),true,'recording-source.json');
        if(recordingMatch[2]==='audio')return serveFile(req,res,file,url.searchParams.has('download'),`${item.title.replace(/[^a-zA-Z0-9 _-]/g,'').slice(0,100)||'recording'}.${item.extension}`);
        fail('Method not allowed.',405);
      }
      if (route === '/api/draft' && req.method === 'PUT') {
        const input = await body(req);
        if (JSON.stringify(input).length > 65000) fail('Draft is too large.');
        db.draft = input; save(); return send(res, 200, { saved: true });
      }
      if (route === '/api/settings' && req.method === 'PUT') {
        if (active || jobs().some(s => s.status === 'queued')) fail('Wait for generation or transcription to finish before changing the engine.', 409);
        const input = await body(req);
        const executable = text(input.executable, 'Runtime path', 1000, true);
        const modelDir = text(input.modelDir, 'Model folder', 1000, true);
        if (!path.isAbsolute(executable) || !path.isAbsolute(modelDir)) fail('Use full paths for the engine and model folder.');
        if (!['cuda', 'cpu', 'vulkan'].includes(input.backend)) fail('Choose a valid backend.');
        if (!['yue2-3b-q4_0.gguf', 'yue2-3b-q8_0.gguf', 'yue2-3b-bf16.gguf'].includes(input.modelFile)) fail('Choose a supported model file.');
        const sheetSageModel = text(input.sheetSageModel ?? db.settings.sheetSageModel, 'SheetSage2 model path', 1000, true);
        if (!path.isAbsolute(sheetSageModel)) fail('Use a full path for the SheetSage2 model.');
        db.settings = { executable, modelDir, backend: input.backend, modelFile: input.modelFile, sheetSageModel }; save();
        return send(res, 200, { settings: db.settings, runtime: ready() });
      }
      if (route === '/api/songs' && req.method === 'POST') {
        const input=await body(req),params = {...validateSong(input),projectId:projects.validProject(input.projectId)};
        if(params.lyricSource && !lyricsWorkspace.has(params.lyricSource)) fail('The source lyric draft no longer exists.');
        if(params.scoreSource && params.scoreSource !== 'custom') {
          const [kind,id] = params.scoreSource.split(':');
          if(!(kind === 'song' ? db.songs : db.transcriptions).some(s => s.id === id)) fail('The source score no longer exists.');
        }
        if(params.execution==='runpod'){
          if(!cloudView().configured)fail('Connect your RunPod worker in Engine settings first.',503);
        }else{const runtime = ready();if (!runtime.ready) fail(`Engine setup required: ${runtime.missing.join(', ')}`, 503);}
        if (jobs().filter(s => ['queued', 'running'].includes(s.status)).length >= 10) fail('The queue is full. Wait for a session to finish.', 409);
        const song = { ...params, modelPrecision:params.execution==='runpod'?'BF16 + F32 VAE':db.settings.modelFile, id: randomUUID(), status: 'queued', stage: 'Queued', createdAt: new Date().toISOString() };
        const dir = directory(song.id); mkdirSync(dir);
        atomic(path.join(dir, 'request.json'), params);
        writeFileSync(path.join(dir, 'lyrics.txt'), params.lyrics);
        if (params.abc) writeFileSync(path.join(dir, 'input.abc'), params.abc);
        db.songs.push(song); save(); setImmediate(runNext); return send(res, 201, view(song));
      }
      if (route === '/api/transcriptions' && req.method === 'POST') {
        const runtime = sheetReady();
        if (!runtime.ready) fail(`SheetSage2 setup required: ${runtime.missing.join(', ')}`, 503);
        if (jobs().filter(s => ['queued', 'running'].includes(s.status)).length >= 10) fail('The queue is full.', 409);
        const filename = validateAudioName(url.searchParams.get('filename'));
        const title = text(url.searchParams.get('title'), 'Title', 120, true);
        const id = randomUUID(), dir = path.join(transcriptionsDir, id); mkdirSync(dir);
        const bytes = await upload(req, path.join(dir, `upload${filename.extension}`));
        const job = { id, kind: 'transcription', title, filename: filename.name, extension: filename.extension, bytes, status: 'queued', stage: 'Queued', createdAt: new Date().toISOString() };
        db.transcriptions.push(job); save(); setImmediate(runNext); return send(res, 201, view(job));
      }
      const transcriptionMatch = /^\/api\/transcriptions\/([a-f0-9-]{36})\/(cancel|score|audio|events|log|render|svg)$/.exec(route);
      if (transcriptionMatch) {
        const job = db.transcriptions.find(s => s.id === transcriptionMatch[1]); if (!job) fail('Transcription not found.', 404);
        const action = transcriptionMatch[2];
        if (action === 'cancel' && req.method === 'POST') { cancel(job); return send(res, 200, view(job)); }
        if (action === 'render' && req.method === 'POST') {
          if (job.status !== 'completed') fail('The score is not ready.', 409);
          const input = await body(req, 3000000);
          const svg = text(input.svg, 'Rendered score', 2900000, true);
          if (!svg.startsWith('<svg ') || !svg.endsWith('</svg>') || /<script|<foreignObject|\son[a-z]+\s*=/i.test(svg)) fail('Invalid rendered score.');
          writeFileSync(path.join(directory(job.id), 'rendered.svg'), svg);
          return send(res, 200, { saved: true });
        }
        if (['GET', 'HEAD'].includes(req.method) && !['cancel', 'render'].includes(action)) {
          if (['score', 'events', 'svg'].includes(action) && job.status !== 'completed') fail('The score is not ready.', 409);
          const file = { score: 'score.abc', audio: 'source.wav', events: 'events.json', log: 'generation.txt', svg: 'rendered.svg' }[action];
          return serveFile(req, res, path.join(directory(job.id), file), action === 'svg' || url.searchParams.has('download'), `${job.title.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 80) || 'score'}${path.extname(file)}`);
        }
      }
      const masterMatch = /^\/api\/masters\/([a-f0-9-]{36})\/audio$/.exec(route);
      if (masterMatch && ['GET','HEAD'].includes(req.method)) {
        const job = mastering.get(masterMatch[1]); if (!job.hasAudio) fail('Mastered audio is not ready.',409);
        return serveFile(req,res,mastering.audio(job.id),url.searchParams.has('download'),`${job.title.replace(/[^a-zA-Z0-9 _-]/g,'').slice(0,70)||'song'}-${job.preset}-master.wav`);
      }
      const songMatch = /^\/api\/songs\/([a-f0-9-]{36})(?:\/(cancel|audio|score|request|lyrics|log|masters|trash|restore))?$/.exec(route);
      if (songMatch) {
        const song = db.songs.find(s => s.id === songMatch[1]); if (!song) fail('Song not found.', 404);
        const action = songMatch[2];
        if(action==='trash'&&req.method==='POST'){
          const blockers=songDeletionBlockers(song);if(blockers.length)fail('This song cannot be deleted because it is used by: '+blockers.map(b=>b.title+(b.inTrash?' (video in Trash)':'')).join(', ')+'.',409);
          song.deletedAt??=new Date().toISOString();save();return send(res,200,{deleted:true,recoverable:true});
        }
        if(action==='restore'&&req.method==='POST'){delete song.deletedAt;save();return send(res,200,view(song));}
        if(song.deletedAt&&req.method==='POST')fail('Restore this song from Trash first.',409);
        if (action === 'masters' && req.method === 'POST') {
          if (!view(song).hasAudio) fail('Finish generating the song before mastering it.',409);
          const input = await body(req);return send(res,202,mastering.enqueue(song,input.preset));
        }
        if (action === 'masters' && req.method === 'GET') return send(res,200,{masters:mastering.list(song.id)});
        if (action === 'cancel' && req.method === 'POST') { cancel(song); return send(res, 200, view(song)); }
        if (!action && req.method === 'GET') return send(res, 200, view(song));
        if (['GET', 'HEAD'].includes(req.method)) {
          if (action === 'audio' && song.status !== 'completed') fail('Audio is not ready.', 409);
          const files = { audio: 'audio.wav', score: song.abc ? 'input.abc' : 'score.abc', request: 'request.json', lyrics: 'lyrics.txt', log: 'generation.txt' };
          if (files[action]) return serveFile(req, res, path.join(directory(song.id), files[action]), url.searchParams.has('download'), `${song.title.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 80) || 'song'}${path.extname(files[action])}`);
        }
      }
      if (route.startsWith('/api/')) fail('Endpoint not found.', 404);
      if (!['GET', 'HEAD'].includes(req.method)) fail('Method not allowed.', 405);
      const publicFiles = { '/': 'index.html', '/app.js': 'app.js', '/mastering.js': 'mastering.js', '/videos.js': 'videos.js', '/lyrics.js': 'lyrics.js', '/assets.js': 'assets.js', '/runpod.js': 'runpod.js', '/sheet.js': 'sheet.js', '/microphone.js': 'microphone.js', '/finder.js': 'finder.js', '/composition-score.js': 'composition-score.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg' };
      if (route === '/abcjs.js') return serveFile(req, res, path.join(root, 'node_modules', 'abcjs', 'dist', 'abcjs-basic-min.js'));
      if (route === '/abcjs_basic.LICENSE') return serveFile(req, res, path.join(root, 'node_modules', 'abcjs', 'dist', 'abcjs-basic-min.js.LICENSE'), true);
      if (!publicFiles[route]) fail('Page not found.', 404);
      if (route === '/favicon.svg') res.setHeader('Content-Type', 'image/svg+xml');
      serveFile(req, res, path.join(root, 'public', publicFiles[route]));
    } catch (error) {
      if (!res.headersSent) send(res, error.status ?? 500, { error: error.status ? error.message : 'The app could not complete this request. Check the server console.' });
      else res.destroy();
      if (!error.status) console.error(error);
    }
  });
  async function close() {
    closing = true;
    await videos.close();
    await mastering.close();
    const child = active?.child;
    const exited = active?.promise ?? (child && child.exitCode === null && child.signalCode === null ? new Promise(resolve => child.once('close', resolve)) : Promise.resolve());
    if (active && ['queued', 'running'].includes(active.song.status)) { cancel(active.song); }
    await new Promise(resolve => server.close(resolve));
    await exited;
  }
  return { server, close, ready };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3210);
  const app = createStudio();
  app.server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  app.server.listen(port, '127.0.0.1', () => console.log(`YuE2 Studio is open at http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().then(() => process.exit()));
}
