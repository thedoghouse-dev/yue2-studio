"""Queue handler: load prepared H3 weights once; return a bounded MP4 per scene."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
import runpod
from h3_worker import ROOT, REVISION, TOKEN, serve_command, service_ready

child = None

def local_json(route, value=None):
    request = urllib.request.Request('http://127.0.0.1:30010' + route, data=json.dumps(value).encode() if value is not None else None, headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)

def ensure_service():
    global child
    manifest = ROOT / 'studio-installed.json'
    if not manifest.is_file() or json.loads(manifest.read_text())['revision'] != REVISION:
        raise RuntimeError('Prepare MiniMax H3 on this network volume in RunPod cloud first.')
    if child is None or child.poll() is not None:
        command = serve_command(ROOT)
        command[command.index('--host') + 1] = '127.0.0.1'
        child = subprocess.Popen(command, cwd=str(ROOT))
    started = time.monotonic()
    while not service_ready():
        if child.poll() is not None or time.monotonic() - started > 1800:
            raise RuntimeError('MiniMax service failed to load. Check serverless worker logs.')
        time.sleep(5)

def handler(job):
    value = job.get('input', {})
    prompt, seconds, ratio, seed = value.get('prompt'), value.get('seconds'), value.get('ratio'), value.get('seed')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 20000 or seconds not in [5, 6, 8, 10, 12, 15] or ratio not in ['16:9', '9:16', '1:1'] or type(seed) is not int or not 0 <= seed <= 2147483647:
        raise ValueError('Invalid video scene request')
    ensure_service()
    result = local_json('/v1/videos', {'task': 't2va', 'prompt': prompt, 'conditions': [], 'target': {'short_edge': 768, 'aspect_ratio': ratio, 'duration_seconds': seconds}, 'seed': seed})
    remote_id = result.get('id', '')
    if not remote_id or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in remote_id):
        raise RuntimeError('Invalid local video job ID')
    started = time.monotonic()
    while True:
        result = local_json('/v1/videos/' + remote_id)
        if result.get('status') == 'completed':
            break
        if result.get('status') in ['failed', 'cancelled'] or time.monotonic() - started > 1800:
            raise RuntimeError('MiniMax scene did not finish')
        time.sleep(3)
    with tempfile.TemporaryDirectory(prefix='h3-scene-') as temporary:
        source, output = Path(temporary) / 'source.mp4', Path(temporary) / 'scene.mp4'
        request = urllib.request.Request('http://127.0.0.1:30010/v1/videos/' + remote_id + '/content', headers={'Authorization': 'Bearer ' + TOKEN})
        with urllib.request.urlopen(request, timeout=120) as response, source.open('wb') as stream:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > 256 * 1024**2:
                    raise RuntimeError('Scene exceeds maximum size')
                stream.write(chunk)
        subprocess.run(['ffmpeg', '-hide_banner', '-nostdin', '-y', '-i', str(source), '-an', '-c:v', 'libx264', '-crf', '24', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-threads', '4', str(output)], check=True, timeout=180)
        if output.stat().st_size > 12 * 1024**2:
            raise RuntimeError('Encoded scene exceeds queue result size. Use a shorter scene.')
        return {'videoBase64': base64.b64encode(output.read_bytes()).decode(), 'mime': 'video/mp4'}

if __name__ == '__main__':
    runpod.serverless.start({'handler': handler})
