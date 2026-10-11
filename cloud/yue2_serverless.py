"""YuE2 queue worker; shared model cache and bounded, authenticated WAV transfer."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import uuid
import worker

CHUNK_BYTES = 4 * 1024 * 1024
MAX_AUDIO = 128 * 1024 * 1024


def handler(job):
    data = job.get('input', {})
    operation = data.get('operation', 'generate')
    try:
        song_id = str(uuid.UUID(data.get('id', '')))
        if song_id != data['id']:
            raise ValueError()
    except (ValueError, KeyError, TypeError, AttributeError):
        raise ValueError('A song UUID is required.')
    directory = worker.ROOT / 'queue-jobs' / song_id
    if operation == 'audio-chunk':
        ticket = data.get('ticket', '')
        manifest = json.loads((directory / 'result.json').read_text(encoding='utf-8'))
        if not isinstance(ticket, str) or not hmac.compare_digest(ticket, manifest['ticket']):
            raise ValueError('Invalid recording transfer ticket.')
        offset = data.get('offset')
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0 or offset >= manifest['bytes'] or offset % CHUNK_BYTES:
            raise ValueError('Invalid recording offset.')
        with (directory / 'audio.wav').open('rb') as audio:
            audio.seek(offset)
            chunk = audio.read(CHUNK_BYTES)
        return {'offset': offset, 'audioBase64': base64.b64encode(chunk).decode('ascii')}
    if operation != 'generate':
        raise ValueError('Unsupported YuE2 operation.')
    song = worker.validate(dict(data))
    # Serialize duplicate deliveries of a song across workers. Never overwrite
    # a completed recording or regenerate automatically after interruption.
    import fcntl
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / '.lock').open('a') as song_lock:
        fcntl.flock(song_lock, fcntl.LOCK_EX)
        result = directory / 'result.json'
        fingerprint = hashlib.sha256(json.dumps(song, sort_keys=True).encode()).hexdigest()
        if result.exists():
            saved = json.loads(result.read_text(encoding='utf-8'))
            if saved['fingerprint'] != fingerprint:
                raise ValueError('Song ID already used with different inputs.')
            return saved
        started = directory / 'started.json'
        if started.exists():
            raise RuntimeError('A previous attempt was interrupted. Start a new song session to retry.')
        started.write_text(json.dumps({'fingerprint': fingerprint}), encoding='utf-8')
        if not worker.state['ready']:
            worker.prepare()
        if not worker.state['ready']:
            # Do not return private setup exceptions through the job API.
            raise RuntimeError('YuE2 setup failed. Reuse the volume and retry a new song session; existing models remain saved.')
        status = {'status': 'queued'}
        worker.generate(status, song)
        if status['status'] != 'completed':
            raise RuntimeError('YuE2 could not finish this recording. Try a new session with a shorter length or another GPU.')
        source = worker.ROOT / 'jobs' / song_id / 'audio.wav'
        size = source.stat().st_size
        if not 44 < size <= MAX_AUDIO:
            raise RuntimeError('Recording exceeds the supported 128 MB size.')
        source.replace(directory / 'audio.wav')
        digest = hashlib.sha256()
        with (directory / 'audio.wav').open('rb') as audio:
            while chunk := audio.read(CHUNK_BYTES):
                digest.update(chunk)
        saved = {'protocol': 'yue2-studio/queue/v1', 'fingerprint': fingerprint,
                 'ticket': uuid.uuid4().hex + uuid.uuid4().hex, 'bytes': size,
                 'sha256': digest.hexdigest(), 'chunkBytes': CHUNK_BYTES,
                 'abc': status.get('abc', ''), 'truncated': bool(status.get('truncated')),
                 'logTail': status.get('logTail', '')[-6000:]}
        temporary = result.with_suffix('.tmp')
        temporary.write_text(json.dumps(saved), encoding='utf-8')
        temporary.replace(result)
        return saved


if __name__ == '__main__':
    import runpod
    runpod.serverless.start({'handler': handler})
