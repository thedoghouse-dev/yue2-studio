import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, statSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';

export const MASTER_PRESETS = {
  balanced: { name: 'Balanced', description: 'Gentle low-rumble cleanup and even loudness, with room for dynamics.', filters: 'highpass=f=25', loudness: -14, range: 11 },
  warm: { name: 'Warm', description: 'A little low-mid warmth and softer highs, with even loudness.', filters: 'highpass=f=25,equalizer=f=180:t=o:w=1:g=1.5,equalizer=f=5000:t=o:w=1:g=-1.5', loudness: -14, range: 11 },
  punchy: { name: 'Punchy', description: 'Gentle compression and a louder, tighter presentation.', filters: 'highpass=f=30,acompressor=threshold=0.125:ratio=1.8:attack=20:release=150:knee=2:makeup=1', loudness: -12, range: 9 },
};
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function atomic(file, value) { writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); renameSync(file + '.tmp', file); }
export function readLoudness(log) {
  const block = log.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
  if (!block) throw new Error('Could not measure this audio.');
  const values = JSON.parse(block);
  for (const key of ['input_i','input_tp','input_lra','input_thresh','target_offset']) if (!Number.isFinite(Number(values[key]))) throw new Error('This audio is silent or too quiet to master reliably.');
  return values;
}

export async function masterAudio(executable, source, output, presetId, { onStage = () => {}, onChild = () => {} } = {}) {
  if (!Object.hasOwn(MASTER_PRESETS,presetId)) fail('Choose Balanced, Warm, or Punchy.');
  const preset = MASTER_PRESETS[presetId];
  const normalizer = `loudnorm=I=${preset.loudness}:TP=-1.5:LRA=${preset.range}`;
  function run(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore','ignore','pipe'] });
      onChild(child); let log = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 600000);
      child.stderr.on('data', chunk => { log = (log + chunk.toString()).slice(-64000); });
      child.on('error', error => { clearTimeout(timer); reject(new Error(`Could not start the local audio processor: ${error.code ?? 'unknown error'}.`)); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(log) : reject(new Error(timedOut ? 'Mastering took too long. Try again.' : 'Audio processing stopped. The original recording is safe.')); });
    });
  }
  const input = ['-hide_banner','-nostdin','-y','-threads','2','-i',source,'-map','0:a:0','-vn'];
  const temporary = output + '.partial.wav';
  try {
    onStage('Analyzing loudness');
    const measured = readLoudness(await run([...input,'-af',`${preset.filters},${normalizer}:print_format=json`,'-f','null','-']));
    onStage('Applying mastering');
    const filter = `${preset.filters},${normalizer}:measured_I=${Number(measured.input_i)}:measured_TP=${Number(measured.input_tp)}:measured_LRA=${Number(measured.input_lra)}:measured_thresh=${Number(measured.input_thresh)}:offset=${Number(measured.target_offset)}:linear=true:print_format=json`;
    const result = readLoudness(await run([...input,'-af',filter,'-ar','48000','-ac','2','-c:a','pcm_s24le',temporary]));
    if (!existsSync(temporary) || statSync(temporary).size <= 44) throw new Error('No mastered audio was produced.');
    renameSync(temporary, output);
    return { targetLufs: preset.loudness, truePeakLimit: -1.5, outputLufs: Number(result.output_i), outputTruePeak: Number(result.output_tp), normalization: result.normalization_type, sampleRate: 48000, bitDepth: 24 };
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function createMastering({ data, executable }) {
  const dir = path.join(data,'masters'), file = path.join(dir,'jobs.json'); mkdirSync(dir,{recursive:true});
  const jobs = existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : [];
  for (const job of jobs) if (['queued','running'].includes(job.status)) { job.status='interrupted'; job.stage='Interrupted'; job.error='The app stopped during mastering. You can start a new master.'; }
  const save = () => atomic(file,jobs); save();
  let running = null, child = null, closing = false;
  const audio = id => path.join(dir,id,'master.wav');
  const view = job => ({...job, hasAudio:job.status === 'completed' && existsSync(audio(job.id))});
  function next() {
    if (running || closing) return;
    const job = jobs.find(j=>j.status==='queued'); if (!job) return;
    job.status='running'; job.startedAt=new Date().toISOString(); save();
    running = (async () => {
      try {
        job.measurements = await masterAudio(executable, path.join(data,'songs',job.songId,'audio.wav'), audio(job.id), job.preset, {onChild:value=>{child=value;if(closing)value.kill();},onStage:stage=>{job.stage=stage;save();}});
        job.status='completed'; job.stage='Master ready';
      } catch (error) { job.status=closing?'interrupted':'failed';job.stage=closing?'Interrupted':'Mastering failed';job.error=error.message; }
      finally { job.finishedAt=new Date().toISOString();save();child=null;running=null;setImmediate(next); }
    })();
  }
  return {
    list: (songId) => jobs.filter(j=>!songId || j.songId === songId).map(view).reverse(),
    presets: Object.entries(MASTER_PRESETS).map(([id,p])=>({id,name:p.name,description:p.description})),
    get: id => { const job=jobs.find(j=>j.id===id); if(!job)fail('Master not found.',404);return view(job); },
    audio,
    enqueue(song,preset) {
      if (!Object.hasOwn(MASTER_PRESETS,preset)) fail('Choose Balanced, Warm, or Punchy.');
      if (!existsSync(executable)) fail('The local audio processor is missing. Run Setup SheetSage2.cmd to install it.',503);
      if (jobs.filter(j=>['queued','running'].includes(j.status)).length >= 5) fail('The mastering queue is full. Wait for a master to finish.',409);
      const existing = jobs.find(j=>j.songId===song.id && j.preset===preset && ['queued','running'].includes(j.status)); if(existing)return view(existing);
      const job={id:randomUUID(),songId:song.id,title:song.title,preset,status:'queued',stage:'Queued',createdAt:new Date().toISOString()};
      mkdirSync(path.join(dir,job.id));jobs.push(job);save();setImmediate(next);return view(job);
    },
    async close() { closing=true;child?.kill();await running; },
  };
}
