"""Run the actual cloud HTTP worker with the existing fake audio.cpp CLI."""
import os
import json
from pathlib import Path
import subprocess
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'cloud'))
import worker
original = subprocess.Popen
def fixture(args, **options):
    (Path(args[args.index('--out-dir') + 1]) / 'args.json').write_text(json.dumps(args))
    assert 'yue2.model_gguf=yue2-3b-bf16.gguf' in args
    assert 'yue2.vae_gguf=yue2-vae-f32.gguf' in args
    return original([os.environ['FIXTURE_NODE'], str(Path(__file__).with_name('fixture-cli.mjs')), *args[1:]], **options)
worker.subprocess.Popen = fixture
worker.engine.update(executable=os.environ['FIXTURE_NODE'], model=str(worker.ROOT / 'models'))
worker.state.update(ready=True, stage='Test BF16 worker ready')
server = worker.ThreadingHTTPServer(('127.0.0.1', 0), worker.Handler)
print(server.server_port, flush=True)
server.serve_forever()
