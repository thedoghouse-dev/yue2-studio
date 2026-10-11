"""Authenticated model installation status and optional MiniMax H3 SGLang service."""
import hmac
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from setup_worker import download, fetch_json

REVISION = '42ed227ee7df40d41602854ae760620d6eb651fe'
REPO = 'MiniMaxAI/MiniMax-H3'
TOKEN = os.environ.get('YUE2_WORKER_TOKEN', '')
if len(TOKEN) < 32:
    raise RuntimeError('A random worker token of at least 32 characters is required.')
WORKLOAD = os.environ.get('YUE2_STUDIO_WORKLOAD', 'h3-download')
ROOT = Path(os.environ.get('H3_ROOT', '/workspace/models/minimax-h3')) / REVISION
ROOT.mkdir(parents=True, exist_ok=True)
state = {'protocol': 'yue2-studio/h3-setup/v1', 'workload': WORKLOAD, 'ready': False, 'stage': 'Preparing MiniMax H3', 'model': REPO, 'revision': REVISION}

def install_model(root, progress):
    info = fetch_json(f'https://huggingface.co/api/models/{REPO}/revision/{REVISION}?blobs=true')
    entries = [item for item in info['siblings'] if item['rfilename'] == 'model_index.json' or item['rfilename'].startswith('FL2VA/')]
    if not entries or not any(item['rfilename'] == 'model_index.json' for item in entries):
        raise RuntimeError('Missing MiniMax model manifest')
    remaining = sum(item['size'] for item in entries if not (root / item['rfilename']).is_file())
    if shutil.disk_usage(root).free < remaining + 10 * 1024**3:
        raise RuntimeError('Insufficient free volume space for MiniMax H3')
    for index, item in enumerate(entries):
        name = item['rfilename']
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts:
            raise RuntimeError('Invalid model file path')
        progress(f'MiniMax H3 file {index + 1}/{len(entries)}: {name}')
        download(f'https://huggingface.co/{REPO}/resolve/{REVISION}/{name}', root / relative, item['size'], (item.get('lfs') or {}).get('sha256'), lambda message: progress(f'{index + 1}/{len(entries)} · {message}'))
    (root / 'studio-installed.json').write_text(json.dumps({'revision': REVISION, 'files': len(entries)}), encoding='utf-8')

def serve_command(model):
    return ['sglang', 'serve', '--model-path', str(model), '--model-variant', 'fl2va', '--num-gpus', '4', '--ulysses-degree', '4', '--encoder-parallel', 'auto', '--performance-mode', 'speed', '--host', '0.0.0.0', '--port', '30010', '--api-key', TOKEN]

def service_ready():
    request = urllib.request.Request('http://127.0.0.1:30010/v1/models', headers={'Authorization': 'Bearer ' + TOKEN})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            models = json.load(response)
        return any('minimax' in model.get('id', '').lower() and 'h3' in model.get('id', '').lower() for model in models.get('data', []))
    except Exception:
        return False

def prepare():
    try:
        if WORKLOAD not in ['h3-download', 'h3-video']:
            raise RuntimeError('Unknown H3 installation mode')
        if WORKLOAD == 'h3-video':
            help_text = subprocess.run(['sglang', 'serve', '--help'], capture_output=True, text=True, check=True, timeout=120).stdout
            if '--api-key' not in help_text or '--model-variant' not in help_text:
                raise RuntimeError('The SGLang image lacks required authenticated H3 serving flags')
            memory = subprocess.run(['nvidia-smi', '--query-gpu=memory.total', '--format=csv,noheader,nounits'], capture_output=True, text=True, check=True, timeout=15).stdout.splitlines()
            if len(memory) != 4 or any(int(value.strip()) < 130000 for value in memory):
                raise RuntimeError('This profile requires four H200-class GPUs')
        install_model(ROOT, lambda stage: state.update(stage=stage))
        if WORKLOAD == 'h3-download':
            state.update(ready=True, stage='MiniMax H3 saved on your network volume. Stop the download Pod to end GPU billing.')
            return
        state.update(stage='Loading MiniMax H3 in SGLang')
        child = subprocess.Popen(serve_command(ROOT), cwd=str(ROOT))
        started = time.monotonic()
        while child.poll() is None:
            ready = service_ready()
            state.update(ready=ready, stage='MiniMax H3 video service ready' if ready else 'Loading MiniMax H3 in SGLang')
            if not ready and time.monotonic() - started > 3600:
                child.terminate()
                raise RuntimeError('MiniMax service did not become ready within one hour')
            time.sleep(5)
        raise RuntimeError('MiniMax service exited; check Pod logs')
    except Exception:
        state.update(ready=False, stage='MiniMax setup failed', error='Check the Pod logs for download, disk, CUDA, or service errors. Stop compute after troubleshooting.')

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN):
            self.send_error(401)
            return
        if self.path != '/health':
            self.send_error(404)
            return
        content = json.dumps(state).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

if __name__ == '__main__':
    threading.Thread(target=prepare, daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
