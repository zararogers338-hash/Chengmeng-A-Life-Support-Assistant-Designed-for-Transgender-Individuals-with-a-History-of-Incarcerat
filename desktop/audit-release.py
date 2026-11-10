"""Verify the actual EXE/ZIP, report only metadata, and fail on private artifacts."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import struct
import zipfile

ROOT = Path(__file__).resolve().parent.parent
version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
exe = ROOT / 'dist' / f'Chengmeng-{version}-Windows-x64.exe'
source = ROOT / 'dist' / f'Chengmeng-{version}-source.zip'
forbidden = {'.credentials.yaml', '.anonymous-user-id', '.dsh-dev', 'desktop-ui', 'integration-backups', '__pycache__',
             'attachments', 'memory-pending', '.env', '.git', 'launcher.log', 'installation.json'}
identifiers = [Path.home().name.encode('utf-8'), str(Path.home()).encode('utf-8'), str(Path.home()).replace('\\', '/').encode('utf-8')]
violations = []
report = {'version': version, 'containsUserData': False, 'archives': []}
with exe.open('rb') as handle:
    handle.seek(-56, 2)
    footer = handle.read(56)
    assert footer[:8] == b'CHGMEXE1', 'Missing EXE footer'
    offset, length = struct.unpack('<qq', footer[8:24])
    assert offset + length + 56 == exe.stat().st_size, 'Invalid payload offsets'
    handle.seek(offset)
    digest = hashlib.sha256()
    remaining = length
    while remaining:
        chunk = handle.read(min(8 * 1024 * 1024, remaining))
        if not chunk:
            raise AssertionError('Truncated payload')
        digest.update(chunk)
        remaining -= len(chunk)
    assert digest.digest() == footer[24:], 'Payload checksum mismatch'
# Python ZipFile recognizes a prepended EXE and a small trailing footer.
for archive_path in [exe, source]:
    own_text = 0
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        assert len(names) == len(set(names)), 'Duplicate ZIP paths'
        for name in names:
            parts = PurePosixPath(name).parts
            if any(p in forbidden for p in parts) or '..' in parts or name.startswith('/'):
                violations.append(name)
            if archive_path == exe:
                if parts[0] not in {'app', 'plugins', 'embedding', 'licenses', 'prepare.cjs', 'README.md', 'LICENSE', 'distribution.json'}:
                    violations.append(name)
                if name.startswith(('embedding/venv/', 'sessions/', 'chengmeng/memory/')) or name == 'embedding/ready.json':
                    violations.append(name)
                owned = name.startswith('plugins/') or name in {'prepare.cjs', 'README.md', 'distribution.json'}
            else:
                owned = not name.startswith('chengmeng/desktop/licenses/')
                public_docs = {'chengmeng/docs/USAGE.md', 'chengmeng/docs/ARCHITECTURE.md',
                               'chengmeng/docs/RELEASE-v0.5.0.md', 'chengmeng/docs/verification-v0.5.0.json'}
                if (name.startswith('chengmeng/docs/') and name not in public_docs) or name.startswith(('chengmeng/.runtime/', 'chengmeng/dist/')):
                    violations.append(name)
            if owned and PurePosixPath(name).suffix.lower() in {'.json', '.js', '.mjs', '.cjs', '.md', '.txt', '.ts', '.yml', '.yaml', '.ps1', '.py', '.cs'}:
                contents = archive.read(name)
                own_text += 1
                if any(len(marker) > 3 and marker.lower() in contents.lower() for marker in identifiers):
                    violations.append(name + ' (local identity/path)')
        bad = archive.testzip()
        assert bad is None, f'CRC failure: {bad}'
    with archive_path.open('rb') as handle:
        checksum = hashlib.file_digest(handle, 'sha256').hexdigest()
    report['archives'].append({'file': archive_path.name, 'bytes': archive_path.stat().st_size,
                               'files': len(names), 'ownTextFilesScanned': own_text, 'sha256': checksum})
if violations:
    raise RuntimeError('Private or unexpected files: ' + ', '.join(sorted(set(violations))))
(ROOT / 'dist' / 'public-release-audit.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2))
