// Capture begins only after an explicit Record click. No audio is uploaded here.
export function createMicrophoneRecorder({ mediaDevices = globalThis.navigator?.mediaDevices, Recorder = globalThis.MediaRecorder, onState = () => {}, onRecording = () => {}, onError = () => {}, maxMs = 120000 } = {}) {
  let stream, recorder, timer, ticker, attempt = 0, state = 'idle', started = 0;
  const supported = Boolean(mediaDevices?.getUserMedia && Recorder);
  function emit(next) { state = next; onState({ state, seconds: started ? Math.floor((Date.now() - started) / 1000) : 0 }); }
  function release() {
    clearTimeout(timer); clearInterval(ticker);
    stream?.getTracks().forEach(track => track.stop()); stream = null;
  }
  function message(error) {
    if (['NotAllowedError', 'SecurityError'].includes(error.name)) return 'Microphone access was blocked. Allow the microphone for this page in your browser, then try again.';
    if (error.name === 'NotFoundError') return 'No microphone was found. Connect a microphone and try again.';
    if (error.name === 'NotReadableError') return 'The microphone could not be opened. Check your microphone settings or close another app using it.';
    return 'Recording failed. Try again, or record in Chrome or Edge and upload an audio file.';
  }
  async function start() {
    if (!supported || ['requesting', 'recording', 'stopping'].includes(state)) return;
    const current = ++attempt; started = 0; emit('requesting');
    try {
      const acquired = await mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      if (current !== attempt) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => Recorder.isTypeSupported?.(type));
      recorder = new Recorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = []; let bytes = 0;
      recorder.ondataavailable = event => { if (event.data?.size) { chunks.push(event.data); bytes += event.data.size; if (bytes > 120 * 1024 * 1024) stop(); } };
      recorder.onerror = event => { if (current !== attempt) return; ++attempt; release(); emit('idle'); onError(message(event.error ?? {})); };
      recorder.onstop = () => {
        if (current !== attempt) return;
        release(); emit('idle');
        const type = recorder.mimeType || chunks[0]?.type || mime || 'audio/webm';
        const extension = /mp4/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : /wav/.test(type) ? 'wav' : 'webm';
        const blob = new Blob(chunks, { type });
        if (blob.size < 12) { onError('No audio was captured. Check your microphone and try a longer take.'); return; }
        onRecording(new File([blob], `My-melody-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`, { type }));
      };
      recorder.start(1000); started = Date.now(); emit('recording');
      ticker = setInterval(() => emit('recording'), 1000);
      timer = setTimeout(stop, maxMs);
    } catch (error) { if (current !== attempt) return; release(); emit('idle'); onError(message(error)); }
  }
  function stop() {
    if (state === 'requesting') { ++attempt; release(); emit('idle'); return; }
    if (state !== 'recording') return;
    clearTimeout(timer); clearInterval(ticker); emit('stopping');
    recorder.stop(); release();
  }
  function dispose() { ++attempt; if (recorder?.state === 'recording') recorder.stop(); release(); state = 'idle'; }
  return { supported, start, stop, dispose, get state() { return state; } };
}
