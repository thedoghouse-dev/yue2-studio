import test from 'node:test';
import assert from 'node:assert/strict';
import { createMicrophoneRecorder } from '../public/microphone.js';

function fixture(options = {}) {
  let released = 0; const recordings = [], errors = [], states = [];
  const stream = { getTracks: () => [{ stop: () => released++ }] };
  class Recorder {
    static isTypeSupported(type) { return type.includes(options.mp4 ? 'mp4' : 'webm'); }
    constructor(_stream, config) { this.mimeType = config.mimeType; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['a recorded melody with audio bytes'], { type: this.mimeType }) }); queueMicrotask(() => this.onstop()); }
  }
  const recorder = createMicrophoneRecorder({ Recorder, mediaDevices: { getUserMedia: options.acquire ?? (async constraints => { assert.equal(constraints.video, false); assert.equal(constraints.audio.noiseSuppression, false); return stream; }) }, onRecording: file => recordings.push(file), onState: value => states.push(value.state), onError: error => errors.push(error), maxMs: options.maxMs ?? 120000 });
  return { recorder, recordings, errors, states, stream, released: () => released };
}
test('microphone take keeps a matching upload format and releases the microphone on stop', async () => {
  for (const mp4 of [false, true]) {
    const f = fixture({ mp4 }); await f.recorder.start(); assert.equal(f.recorder.state, 'recording');
    f.recorder.stop(); await Promise.resolve();
    assert.equal(f.recorder.state, 'idle'); assert.equal(f.released(), 1); assert.equal(f.recordings.length, 1);
    assert.match(f.recordings[0].name, mp4 ? /\.m4a$/ : /\.webm$/); assert.ok(f.recordings[0].size > 12);
    assert.equal(f.errors.length, 0); f.recorder.dispose();
  }
});
test('cancelled permission request releases a late-arriving microphone without recording', async () => {
  let resolve; const f = fixture({ acquire: () => new Promise(r => resolve = r) });
  const pending = f.recorder.start(); assert.equal(f.recorder.state, 'requesting');
  f.recorder.stop(); resolve(f.stream); await pending;
  assert.equal(f.released(), 1); assert.equal(f.recordings.length, 0); assert.equal(f.recorder.state, 'idle');
});
test('denied microphone permission is recoverable and the duration limit stops capture', async () => {
  const denied = fixture({ acquire: async () => { throw Object.assign(new Error(), { name: 'NotAllowedError' }); } });
  await denied.recorder.start(); assert.match(denied.errors[0], /Allow the microphone/); assert.equal(denied.recorder.state, 'idle');
  const limited = fixture({ maxMs: 10 }); await limited.recorder.start(); await new Promise(r => setTimeout(r, 30));
  assert.equal(limited.released(), 1); assert.equal(limited.recordings.length, 1); assert.equal(limited.recorder.state, 'idle');
});
test('leaving the document releases a recording without saving an unwanted take', async () => {
  const f = fixture(); await f.recorder.start(); f.recorder.dispose(); await Promise.resolve();
  assert.equal(f.released(), 1); assert.equal(f.recordings.length, 0);
});
