"""Pinned audio.cpp CUDA CLI build + YuE2 BF16/F32 installer for RunPod."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid
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

def recover_checkout_lock(source, progress):
    lock = source / '.git' / 'index.lock'
    if not lock.exists():
        return
    # Fresh locks may belong to an active checkout. Never remove those.
    if time.time() - lock.stat().st_mtime < 300:
        raise RuntimeError('A recent Git checkout lock exists. Wait five minutes before retrying setup.')
    # Legacy installers did not use our setup lock. Refuse recovery while a
    # local Git process is alive, even if the lock is older than five minutes.
    proc = Path('/proc')
    if proc.is_dir():
        for entry in proc.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                if (entry / 'comm').read_text().strip() in ['git', 'git-remote-https', 'git-index-pack']:
                    raise RuntimeError('Git is still preparing files. Wait before retrying setup.')
            except (FileNotFoundError, PermissionError):
                pass
    if lock.is_symlink() or not lock.is_file():
        raise RuntimeError('Unexpected Git checkout lock; refusing recovery.')
    progress('Recovering an interrupted source checkout')
    # Preserve the abandoned file for diagnosis instead of deleting it.
    lock.rename(lock.with_name('index.lock.interrupted-' + uuid.uuid4().hex))


def checkout_source(source, progress):
    revision = '795c45fbde0a7d29c93b22199728ff5caaec02e5'
    command = ['git', '-C', str(source), 'checkout', revision]
    result = subprocess.run(command, capture_output=True, text=True, timeout=600, env={**os.environ, 'GIT_LFS_SKIP_SMUDGE': '1'})
    if result.returncode and 'untracked working tree files would be overwritten' in result.stderr:
        # A killed checkout can leave files without an index. Preserve the
        # entire failed source cache and start a fresh checkout, never delete
        # existing files or use force checkout on a shared volume.
        if source.is_symlink():
            raise RuntimeError('Refusing recovery of a linked source directory')
        progress('Preserving interrupted source files and preparing a clean checkout')
        source.rename(source.with_name('source.interrupted-' + uuid.uuid4().hex))
        subprocess.run(['git', 'clone', '--no-checkout', 'https://github.com/0xShug0/audio.cpp.git', str(source)], check=True, timeout=600)
        result = subprocess.run(command, capture_output=True, text=True, timeout=600, env={**os.environ, 'GIT_LFS_SKIP_SMUDGE': '1'})
    if result.returncode:
        raise RuntimeError('Git checkout failed: ' + result.stderr[-2000:])


def setup(root, progress):
    # Locks are released by the OS if a Pod dies. A shared volume must not have
    # two installers modifying the source/build cache at the same time.
    import fcntl
    root.mkdir(parents=True, exist_ok=True)
    with (root / '.studio-setup.lock').open('a') as lock:
        progress('Waiting for exclusive access to the shared model setup')
        fcntl.flock(lock, fcntl.LOCK_EX)
        return setup_locked(root, progress)


def setup_locked(root, progress):
    runtime = root / 'runtime'
    runtime.mkdir(parents=True, exist_ok=True)
    # A shared volume may be attached to a different GPU on the next launch.
    architecture = subprocess.run(['nvidia-smi', '--query-gpu=compute_cap', '--format=csv,noheader'], capture_output=True, text=True, check=True, timeout=15).stdout.strip().splitlines()[0].replace('.', '')
    if not architecture.isdigit():
        raise RuntimeError('Could not determine CUDA GPU architecture')
    build = runtime / ('build-sm' + architecture)
    executable = build / 'bin' / 'audiocpp_cli'
    if not executable.is_file():
        # The official CUDA Colab archive ships the server only. Build the CLI
        # from the exact v0.9.0 commit, including its pinned submodules.
        source = runtime / 'source'
        progress('Preparing the CUDA CLI build')
        subprocess.run(['python3', '-m', 'pip', 'install', 'cmake==3.31.6', 'ninja==1.11.1.4'], check=True, timeout=180)
        if not (source / '.git').exists():
            subprocess.run(['git', 'clone', '--no-checkout', 'https://github.com/0xShug0/audio.cpp.git', str(source)], check=True, timeout=600)
        recover_checkout_lock(source, progress)
        checkout_source(source, progress)
        subprocess.run(['git', '-c', 'url.https://github.com/.insteadOf=git@github.com:', '-C', str(source), 'submodule', 'update', '--init', '--recursive', '--depth', '1'], check=True, timeout=300)
        progress('Building the CUDA song-generation CLI')
        subprocess.run(['cmake', '-S', str(source), '-B', str(build), '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', '-DENGINE_ENABLE_CUDA=ON', '-DCMAKE_CUDA_ARCHITECTURES=' + architecture, '-DAUDIOCPP_DEPLOYMENT_BUILD=ON', '-DAUDIOCPP_MODEL_SET=custom', '-DAUDIOCPP_MODELS=yue2'], check=True, timeout=120)
        subprocess.run(['cmake', '--build', str(build), '--target', 'audiocpp_cli', '-j', '8'], check=True, timeout=1800)
    subprocess.run([str(executable), '--help'], check=True, capture_output=True, timeout=30)
    model = root / 'models'
    info = fetch_json(f'https://huggingface.co/api/models/audio-cpp/Yue2-3B-GGUF/revision/{REVISION}?blobs=true')
    for name in FILES:
        entry = next(item for item in info['siblings'] if item['rfilename'] == name)
        download(f'https://huggingface.co/audio-cpp/Yue2-3B-GGUF/resolve/{REVISION}/{name}', model / name, entry['size'], (entry.get('lfs') or {}).get('sha256'), progress)
    os.environ['LD_LIBRARY_PATH'] = ':'.join([str(executable.parent), str(runtime), os.environ.get('LD_LIBRARY_PATH', '')])
    return str(executable), str(model)
