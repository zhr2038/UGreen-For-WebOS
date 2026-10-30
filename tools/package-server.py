"""Create the credential-free server ZIP attached to GitHub Releases."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
output = root / 'dist' / f'lg-nas-cinema-server-v{version}.zip'
output.parent.mkdir(exist_ok=True)
entries = ['server.mjs', 'package.json', 'package-lock.json', 'Dockerfile', '.dockerignore',
           'compose.yaml', 'README.md', 'docs', 'lib', 'app', 'tools/configure-nas.mjs', 'tools/pair-code.mjs']
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for entry in entries:
        path = root / entry
        for file in sorted(path.rglob('*')) if path.is_dir() else [path]:
            if file.is_file():
                archive.write(file, 'lg-nas-cinema/' + file.relative_to(root).as_posix())
print(output)
