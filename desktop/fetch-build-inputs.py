"""Fetch only public, pinned build inputs; run with Python 3.12 on Windows x64."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
REVISION = '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3'
WEIGHTS = '0437e45c94563b09e13cb7a64478fc406947a93cb34a7e05870fc8dcd48e23fd'
wheels = ROOT / '.desktop-build/wheels-cp312'
wheels.mkdir(parents=True, exist_ok=True)
pins = (ROOT / 'desktop/requirements-cpu.lock.txt').read_text().splitlines()
for pin in pins:
    if not pin.strip():
        continue
    command = [sys.executable, '-I', '-m', 'pip', 'download', '--dest', str(wheels), '--only-binary=:all:',
               '--no-deps', '--python-version', '3.12', '--platform', 'win_amd64', '--implementation', 'cp', '--abi', 'cp312']
    if pin.startswith('torch=='):
        command += ['--index-url', 'https://download.pytorch.org/whl/cpu']
    subprocess.run(command + [pin], check=True)
model = ROOT / '.runtime/qwen-embedding/model'
model.mkdir(parents=True, exist_ok=True)
for name in ['config.json', 'LICENSE', 'merges.txt', 'model.safetensors', 'README.md', 'tokenizer_config.json', 'tokenizer.json', 'vocab.json']:
    target = model / name
    if not target.is_file():
        partial = target.with_name(name + '.part')
        url = f'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/resolve/{REVISION}/{name}'
        print(f'Downloading {name}', flush=True)
        urllib.request.urlretrieve(url, partial)
        partial.replace(target)
with (model / 'model.safetensors').open('rb') as handle:
    if hashlib.file_digest(handle, 'sha256').hexdigest() != WEIGHTS:
        raise RuntimeError('Model checksum mismatch; do not package this file.')
(model / 'chengmeng-model.json').write_text(json.dumps({'model': 'Qwen/Qwen3-Embedding-0.6B', 'revision': REVISION,
    'license': 'Apache-2.0', 'weights_sha256': WEIGHTS, 'download_source': 'huggingface'}, indent=2), encoding='utf-8')
