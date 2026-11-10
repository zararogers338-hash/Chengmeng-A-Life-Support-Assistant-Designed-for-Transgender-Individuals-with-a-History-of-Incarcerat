"""Publish only code and public documentation, never the development workspace."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parent.parent
version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
MODULES = ['agent-core', 'memory-consent', 'pastel-theme', 'startup-animation', 'support-skills', 'appearance-settings', '_template']
rows = [(ROOT / 'LICENSE', 'LICENSE'), (ROOT / 'package.json', 'package.json'),
        (ROOT / '.gitignore', '.gitignore'), (ROOT / 'scripts/build.mjs', 'scripts/build.mjs'),
        (ROOT / 'scripts/data-backup.mjs', 'scripts/data-backup.mjs'),
        (ROOT / 'README.md', 'README.md'), (ROOT / 'CONTRIBUTING.md', 'CONTRIBUTING.md'),
        (ROOT / 'CHANGELOG.md', 'CHANGELOG.md')]
for name in ['docs/USAGE.md', 'docs/ARCHITECTURE.md', 'docs/RELEASE-v0.5.0.md', 'docs/verification-v0.5.0.json', '.github/workflows/test.yml']:
    rows.append((ROOT / name, name))
for directory in ['desktop', 'tests'] + ['plugins/' + name for name in MODULES]:
    for file in sorted((ROOT / directory).rglob('*')):
        if not file.is_file() or any(part in {'node_modules', '__pycache__'} for part in file.parts):
            continue
        if file.suffix.lower() in {'.log', '.tgz', '.pyc', '.exe', '.jpg'}:
            continue
        rows.append((file, file.relative_to(ROOT).as_posix()))
target = ROOT / 'dist' / f'Chengmeng-{version}-source.zip'
target.parent.mkdir(exist_ok=True)
manifest = {'version': version, 'license': 'MIT', 'containsUserData': False, 'files': []}
for file, name in rows:
    contents = file.read_bytes()
    manifest['files'].append({'path': name, 'bytes': len(contents), 'sha256': hashlib.sha256(contents).hexdigest()})
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for file, name in rows:
        archive.write(file, 'chengmeng/' + name)
    archive.writestr('chengmeng/source-manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
with target.open('rb') as handle:
    digest = hashlib.file_digest(handle, 'sha256').hexdigest()
target.with_suffix('.zip.sha256').write_text(f'{digest}  {target.name}\n', encoding='ascii')
print(json.dumps({'file': str(target), 'bytes': target.stat().st_size, 'sha256': digest, 'files': len(rows)}))
