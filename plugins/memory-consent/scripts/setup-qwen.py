"""Portable explicit CPU setup. No global installation and no GPU requirement."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import venv
import shutil
import json
import hashlib

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', choices=['huggingface', 'modelscope'], default='huggingface')
    parser.add_argument('--direct', action='store_true')
    parser.add_argument('--offline-bundle', type=Path, help='Verified cpu-bundle directory from the Windows x64 / Python 3.13 release')
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[3]
    runtime = project / '.runtime' / 'qwen-embedding'
    environment = runtime / 'venv'
    bundle = args.offline_bundle.resolve() if args.offline_bundle else None
    if bundle:
        if sys.platform != 'win32' or sys.version_info[:2] != (3, 13) or sys.maxsize <= 2**32:
            raise SystemExit('Offline CPU bundle requires Windows x64 and Python 3.13. Use online setup on other platforms.')
        manifest = json.loads((bundle / 'manifest.json').read_text(encoding='utf-8'))
        for item in manifest['files']:
            source = (bundle / item['path']).resolve()
            if not source.is_relative_to(bundle) or not source.is_file():
                raise SystemExit('Invalid offline file path')
            with source.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != item['sha256']:
                    raise SystemExit('Offline checksum mismatch: ' + item['path'])
    if not (environment / 'pyvenv.cfg').exists():
        venv.EnvBuilder(with_pip=True).create(environment)
    python = environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    index = 'https://pypi.org/simple' if sys.platform == 'darwin' else 'https://download.pytorch.org/whl/cpu'
    if bundle:
        subprocess.run([str(python), '-m', 'pip', 'install', '--no-index', '--find-links', str(bundle / 'wheelhouse'),
                        '-r', str(bundle / 'requirements.lock.txt')], check=True)
        shutil.copytree(bundle / 'model', runtime / 'model', dirs_exist_ok=True)
    else:
        subprocess.run([str(python), '-m', 'pip', 'install', '--index-url', index, 'torch==2.10.0'], check=True)
        subprocess.run([str(python), '-m', 'pip', 'install', '--index-url', 'https://pypi.org/simple',
                        'transformers==4.57.6', 'numpy>=2,<3'], check=True)
        command = [str(python), str(Path(__file__).with_name('download-qwen.py')), '--destination', str(runtime / 'model'), '--source', args.source]
        if args.direct:
            command.append('--direct')
        subprocess.run(command, check=True)
    subprocess.run([str(python), '-c', "import torch,transformers; assert torch.version.cuda is None; print('CPU torch',torch.__version__,'transformers',transformers.__version__)"], check=True)
    frozen = subprocess.check_output([str(python), '-m', 'pip', 'freeze'], text=True)
    (runtime / 'requirements.lock.txt').write_text(frozen, encoding='utf-8')
    print('CPU embedding runtime ready. Long-term memory remains user-controlled.')
