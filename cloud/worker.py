"""Authenticated async YuE2 worker. Only standard-library dependencies are required."""
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from setup_worker import setup

ROOT = Path(os.environ.get('YUE2_ROOT', '/workspace/yue2'))
ROOT.mkdir(parents=True, exist_ok=True)
TOKEN = os.environ.get('YUE2_WORKER_TOKEN', '')
if len(TOKEN) < 32:
    raise RuntimeError('Set YUE2_WORKER_TOKEN to a random secret of at least 32 characters.')
state = {'protocol': 'yue2-studio/v1', 'ready': False, 'stage': 'Starting', 'model': 'yue2-3b-bf16.gguf', 'vae': 'yue2-vae-f32.gguf'}
jobs = {}
lock = threading.RLock()
engine = {}
MODEL = 'yue2-3b-bf16.gguf'
VAE = 'yue2-vae-f32.gguf'

def prepare():
    try:
        if os.environ.get('YUE2_SKIP_SETUP') == '1':
            engine.update(executable=os.environ['YUE2_EXECUTABLE'], model=os.environ.get('YUE2_MODEL_DIR', str(ROOT / 'models')))
        else:
            gpu = subprocess.run(['nvidia-smi', '--query-gpu=memory.total', '--format=csv,noheader,nounits'], capture_output=True, text=True, check=True, timeout=15)
            memory = int(gpu.stdout.strip().splitlines()[0])
            if memory < 20000:
                raise RuntimeError('Use a GPU with at least 20 GB VRAM; a 24 GB RTX 4090 is recommended.')
            state['gpuMemoryMB'] = memory
            exe, model = setup(ROOT, lambda stage: state.update(stage=stage))
            engine.update(executable=exe, model=model)
        state.update(ready=True, stage='BF16 worker ready')
    except Exception as error:
        state.update(stage='Setup failed', error=str(error))

def validate(data):
    if not isinstance(data, dict):
        raise ValueError('A song request is required.')
    try:
        if str(uuid.UUID(data.get('id', ''))) != data['id']:
            raise ValueError()
    except (ValueError, KeyError, TypeError, AttributeError):
        raise ValueError('A client UUID is required.')
    for key, limit, required in [('title', 120, True), ('style', 2500, True), ('lyrics', 12000, False), ('abc', 30000, False)]:
        value = data.get(key, '')
        if not isinstance(value, str) or len(value) > limit or '\0' in value or (required and not value.strip()):
            raise ValueError('Invalid ' + key)
        data[key] = value
    duration = data.get('durationSeconds')
    if data.get('durationMode', 'maximum') not in ['maximum', 'target'] or data.get('scoreUse', 'follow') not in ['follow', 'motif']:
        raise ValueError('Invalid length mode or sheet music use.')
    if duration is not None:
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not 10 <= duration <= 360 or int(duration) != duration:
            raise ValueError('Song length must be a whole number from 10 to 360 seconds.')
        data['maxTokens'] = int(duration) * 25
    for key, low, high, integer in [('seed', 0, 2147483647, True), ('maxTokens', 200, 9000, True), ('steps', 1, 32, True), ('temperature', .1, 2, False)]:
        value = data.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high or (integer and int(value) != value):
            raise ValueError('Invalid ' + key)
    if data.get('mode') not in ['full', 'melody', 'off'] or (data['abc'] and data['mode'] == 'off'):
        raise ValueError('Choose a score-compatible composition mode.')
    return data

def build_args(data, directory):
    data = {**data, 'lyrics': data['lyrics'] if data['lyrics'].strip() else '[instrumental]', 'style': data['style'] if data['lyrics'].strip() else 'instrumental, no vocals, no singing, ' + data['style']}
    if data['abc'] and data.get('scoreUse') == 'motif':
        data['style'] += ', develop the supplied melody as a recurring motif, variations, contrasting sections, build and release, return to the theme, complete musical ending'
    args = [engine['executable'], '--task', 'gen', '--family', 'yue2', '--model', engine['model'], '--backend', 'cuda', '--threads', '8', '--session-option', 'yue2.model_gguf=' + MODEL, '--session-option', 'yue2.vae_gguf=' + VAE, '--lyrics', data['lyrics'], '--request-option', 'style=' + data['style'], '--request-option', 'cot=' + data['mode'], '--seed', str(data['seed']), '--request-option', 'semantic_max_tokens=' + str(data['maxTokens']), '--request-option', 'semantic_temperature=' + str(data['temperature']), '--request-option', 'num_inference_steps=' + str(data['steps']), '--out', str(directory / 'audio.wav'), '--out-dir', str(directory), '--log']
    if data['abc']:
        args += ['--request-option', 'abc_file=' + str(directory / 'input.abc')]
    minimum = max(200, data['maxTokens'] - 50) if data.get('durationMode') == 'target' and data.get('durationSeconds') else 200
    args += ['--request-option', 'semantic_min_tokens=' + str(minimum)]
    return args

def generate(job, data):
    directory = ROOT / 'jobs' / data['id']
    directory.mkdir(parents=True, exist_ok=True)
    if data['abc']:
        (directory / 'input.abc').write_bytes(data['abc'].encode('utf-8'))
    try:
        with lock:
            if job['status'] == 'cancelled':
                return
            process = subprocess.Popen(build_args(data, directory), cwd=str(Path(engine['executable']).parent), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', env={**os.environ, 'ENGINE_TIMING': '1'})
            job.update(status='running', stage='Generating with BF16', process=process)
        timer = threading.Timer(1800, process.kill)
        timer.start()
        try:
            with (directory / 'generation.txt').open('w', encoding='utf-8') as output:
                for line in process.stdout:
                    output.write(line)
                    with lock:
                        job['logTail'] = (job.get('logTail', '') + line)[-6000:]
                        if re.search(r'yue2\.semantic\.truncated\s*[:=]?\s*(1|true)', line):
                            job['truncated'] = True
            code = process.wait()
        finally:
            timer.cancel()
        with lock:
            if job['status'] == 'cancelled':
                return
            if code != 0 or not (directory / 'audio.wav').exists():
                raise RuntimeError(f'YuE2 exited with code {code}. Check the session log.')
            score = directory / ('input.abc' if data['abc'] else 'score.abc')
            if score.exists() and score.stat().st_size <= 30000:
                job['abc'] = score.read_text(encoding='utf-8')
            job.update(status='completed', stage='Downloading the recording')
    except Exception as error:
        with lock:
            if job['status'] != 'cancelled':
                job.update(status='failed', error=str(error), stage='Generation failed')

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log bearer tokens or song inputs.

    def respond(self, code, value):
        content = json.dumps(value).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def authorized(self):
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN):
            self.respond(401, {'error': 'Unauthorized'})
            return False
        return True

    def do_GET(self):
        if not self.authorized():
            return
        if self.path == '/health':
            return self.respond(200, state)
        match = re.fullmatch(r'/jobs/([a-f0-9-]{36})(/audio)?', self.path)
        if not match:
            return self.respond(404, {'error': 'Not found'})
        with lock:
            job = jobs.get(match[1])
            if not job:
                return self.respond(404, {'error': 'Job not found'})
            if not match[2]:
                return self.respond(200, {k: v for k, v in job.items() if k != 'process'})
            if job['status'] != 'completed':
                return self.respond(409, {'error': 'Audio is not ready'})
        file = ROOT / 'jobs' / match[1] / 'audio.wav'
        self.send_response(200)
        self.send_header('Content-Type', 'audio/wav')
        self.send_header('Content-Length', str(file.stat().st_size))
        self.end_headers()
        with file.open('rb') as stream:
            while chunk := stream.read(1024 * 1024):
                self.wfile.write(chunk)

    def do_POST(self):
        if not self.authorized():
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 <= size <= 100000:
                return self.respond(413, {'error': 'Request too large'})
            data = json.loads(self.rfile.read(size) or b'{}')
            cancel = re.fullmatch(r'/jobs/([a-f0-9-]{36})/cancel', self.path)
            if cancel:
                with lock:
                    job = jobs.get(cancel[1])
                    if not job:
                        jobs[cancel[1]] = {'id': cancel[1], 'status': 'cancelled', 'stage': 'Cancelled'}
                    if job and job['status'] in ['queued', 'running']:
                        job.update(status='cancelled', stage='Cancelled')
                        if job.get('process'):
                            job['process'].kill()
                return self.respond(200, {'cancelled': True})
            if self.path != '/jobs':
                return self.respond(404, {'error': 'Not found'})
            data = validate(data)
            if not state['ready']:
                return self.respond(503, {'error': state['stage']})
            with lock:
                if data['id'] in jobs:
                    return self.respond(200, {'id': data['id']})
                if any(job['status'] in ['queued', 'running'] for job in jobs.values()):
                    return self.respond(409, {'error': 'Worker busy'})
                job = {'id': data['id'], 'status': 'queued', 'stage': 'Queued'}
                jobs[data['id']] = job
                threading.Thread(target=generate, args=(job, data), daemon=True).start()
            return self.respond(202, {'id': data['id']})
        except (ValueError, TypeError) as error:
            self.respond(400, {'error': str(error)})

if __name__ == '__main__':
    threading.Thread(target=prepare, daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '8000'))), Handler).serve_forever()
