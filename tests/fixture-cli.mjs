import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
if (args.includes('-i')) {
  const audio = readFileSync(value('-i'));
  if (audio.toString().startsWith('FAIL')) { console.error('Invalid audio'); process.exit(1); }
  writeFileSync(args.at(-1), audio); process.exit(0);
}
if (value('--family') === 'sheetsage2') {
  const audio = readFileSync(value('--audio'));
  if (audio.toString().startsWith('SCOREFAIL')) { console.error('Transcriber failed'); process.exit(8); }
  setTimeout(() => {
    writeFileSync(value('--out'), 'X:1\nT:Transcription\nM:4/4\nL:1/4\nK:C\nC D E F |');
    writeFileSync(path.join(value('--out-dir'), 'events.json'), JSON.stringify({events:[]}));
    console.log('sheetsage2.postprocess_ms 3');
  }, 80);
} else {
if (value('--lyrics') === 'FAIL') { console.error('Fixture generation failed'); process.exit(7); }
if (value('--lyrics') === 'SLOW') { setInterval(() => {}, 1000); }
else {
  setTimeout(() => {
    const wav = Buffer.alloc(244);
    wav.write('RIFF'); wav.writeUInt32LE(236, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(200, 40);
    writeFileSync(value('--out'), wav);
    writeFileSync(path.join(value('--out-dir'), 'score.abc'), 'X:1\nK:C\nC D E F |');
    console.log('yue2.semantic.truncated 1');
  }, 80);
}
}
