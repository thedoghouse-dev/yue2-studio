"""Pinned audio.cpp CUDA CLI build + YuE2 BF16/F32 installer for RunPod."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request

REVISION = 'cca74d8980c00f30ab8d52248a367c01ad633ec2'
FILES = ['yue2-3b-bf16.gguf', 'yue2-vae-f32.gguf', 'sidecars/yue2-model-config.json', 'sidecars/yue2-generation-config.json', 'sidecars/yue2-qwen.tiktoken', 'sidecars/yue2-vae-config.json']

def open_url(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'YuE2Studio/1.0'}), timeout=90)

def fetch_json(url):
    with open_url(url) as response:
        return json.load(response)

def digest(file):
    result = hashlib.sha256()
    with file.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()

def download(url, file, size, checksum, progress):
    file.parent.mkdir(parents=True, exist_ok=True)
    if file.exists() and file.stat().st_size == size and (not checksum or digest(file) == checksum):
        return
    temporary = file.with_name(file.name + '.partial')
    progress('Downloading ' + file.name)
    with open_url(url) as response, temporary.open('wb') as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    if temporary.stat().st_size != size or (checksum and digest(temporary) != checksum):
        temporary.unlink(missing_ok=True)
        raise RuntimeError('Download verification failed: ' + file.name)
    temporary.replace(file)

def setup(root, progress):
    runtime = root / 'runtime'
    runtime.mkdir(parents=True, exist_ok=True)
    executable = runtime / 'build' / 'bin' / 'audiocpp_cli'
    if not executable.is_file():
        # The official CUDA Colab archive ships the server only. Build the CLI
        # from the exact v0.9.0 commit, including its pinned submodules.
        source = runtime / 'source'
        progress('Preparing the CUDA CLI build')
        subprocess.run(['python3', '-m', 'pip', 'install', 'cmake==3.31.6', 'ninja==1.11.1.4'], check=True, timeout=180)
        if not (source / '.git').exists():
            subprocess.run(['git', 'clone', '--no-checkout', 'https://github.com/0xShug0/audio.cpp.git', str(source)], check=True, timeout=180)
        subprocess.run(['git', '-C', str(source), 'checkout', '795c45fbde0a7d29c93b22199728ff5caaec02e5'], check=True, timeout=60)
        subprocess.run(['git', '-c', 'url.https://github.com/.insteadOf=git@github.com:', '-C', str(source), 'submodule', 'update', '--init', '--recursive', '--depth', '1'], check=True, timeout=300)
        progress('Building the CUDA song-generation CLI')
        subprocess.run(['cmake', '-S', str(source), '-B', str(runtime / 'build'), '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', '-DENGINE_ENABLE_CUDA=ON', '-DCMAKE_CUDA_ARCHITECTURES=native', '-DAUDIOCPP_DEPLOYMENT_BUILD=ON', '-DAUDIOCPP_MODEL_SET=custom', '-DAUDIOCPP_MODELS=yue2'], check=True, timeout=120)
        subprocess.run(['cmake', '--build', str(runtime / 'build'), '--target', 'audiocpp_cli', '-j', '8'], check=True, timeout=1800)
    subprocess.run([str(executable), '--help'], check=True, capture_output=True, timeout=30)
    model = root / 'models'
    info = fetch_json(f'https://huggingface.co/api/models/audio-cpp/Yue2-3B-GGUF/revision/{REVISION}?blobs=true')
    for name in FILES:
        entry = next(item for item in info['siblings'] if item['rfilename'] == name)
        download(f'https://huggingface.co/audio-cpp/Yue2-3B-GGUF/resolve/{REVISION}/{name}', model / name, entry['size'], (entry.get('lfs') or {}).get('sha256'), progress)
    os.environ['LD_LIBRARY_PATH'] = ':'.join([str(executable.parent), str(runtime), os.environ.get('LD_LIBRARY_PATH', '')])
    return str(executable), str(model)
