"""Build a ZIP64 self-extracting EXE from an allowlisted, prepared public stage."""
import hashlib
import json
from pathlib import Path
import shutil
import struct
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
stage = ROOT / '.desktop-build' / 'stage'
version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
output = ROOT / 'dist' / f'Chengmeng-{version}-Windows-x64.exe'
output.parent.mkdir(exist_ok=True)
payload = ROOT / '.desktop-build' / 'payload.zip'
allowed = {'app', 'plugins', 'embedding', 'licenses', 'prepare.cjs', 'README.md', 'LICENSE', 'distribution.json'}
files = []
for file in sorted(stage.rglob('*')):
    if not file.is_file():
        continue
    rel = file.relative_to(stage)
    if rel.parts[0] not in allowed:
        continue
    if rel.parts[:2] == ('embedding', 'venv') or str(rel).replace('\\', '/') == 'embedding/ready.json':
        continue
    # Python regenerates these caches; local imports can embed developer paths.
    if '__pycache__' in rel.parts or file.suffix == '.pyc':
        continue
    if any(p in {'.credentials.yaml', '.dsh-dev', 'desktop-ui', '.anonymous-user-id'} for p in rel.parts):
        raise RuntimeError(f'Private/development file in staging: {rel}')
    files.append((file, rel.as_posix()))
if '--reuse-payload' not in sys.argv:
    print(f'Packaging {len(files)} public files', flush=True)
    with zipfile.ZipFile(payload, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=4, allowZip64=True) as archive:
        for i, (file, name) in enumerate(files):
            archive.write(file, name, compress_type=zipfile.ZIP_STORED if file.suffix in {'.safetensors', '.whl', '.pak', '.zip', '.png', '.jpg', '.jpeg'} else zipfile.ZIP_DEFLATED)
            if i % 2000 == 0:
                print(f'{i}/{len(files)}', flush=True)
digest = hashlib.file_digest(payload.open('rb'), 'sha256').digest()
stub = ROOT / '.desktop-build' / 'Launcher.exe'
with output.open('wb') as result:
    with stub.open('rb') as source:
        shutil.copyfileobj(source, result)
    offset = result.tell()
    with payload.open('rb') as source:
        shutil.copyfileobj(source, result, 8 * 1024 * 1024)
    result.write(b'CHGMEXE1' + struct.pack('<qq', offset, payload.stat().st_size) + digest)
checksum = hashlib.file_digest(output.open('rb'), 'sha256').hexdigest()
output.with_suffix('.exe.sha256').write_text(f'{checksum}  {output.name}\n', encoding='ascii')
print(json.dumps({'exe': str(output), 'bytes': output.stat().st_size, 'sha256': checksum}, ensure_ascii=False), flush=True)
