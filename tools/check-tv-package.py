"""Check the distributable's identity, service and absence of local state/hooks."""
import io
import json
import pathlib
import re
import struct
import hashlib
import sys
import tarfile

root = pathlib.Path(__file__).resolve().parent.parent
path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'dist/CloudFrame.ipk'
raw = path.read_bytes()
assert raw[:8] == b'!<arch>\n', 'Invalid IPK archive'
position, data = 8, None
while position + 60 <= len(raw):
    header = raw[position:position + 60]
    size = int(header[48:58].strip())
    name = header[:16].decode().strip().rstrip('/')
    if name == 'data.tar.gz':
        data = raw[position + 60:position + 60 + size]
    position += 60 + size + size % 2
assert data, 'Missing IPK data'
with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
    files = {m.name: archive.extractfile(m).read() for m in archive.getmembers() if m.isfile()}
app = next(json.loads(v) for k, v in files.items() if k.endswith('/appinfo.json'))
assert app['id'] == 'top.hrhome.nascinema' and app['title'] == '云映' and app['version'] == json.loads((root / 'package.json').read_text())['version']
app_prefix = next(k.rsplit('/', 1)[0] for k in files if k.endswith('/applications/top.hrhome.nascinema/index.html'))
index = files[app_prefix + '/index.html'].decode()
for asset in re.findall(r'(?:src|href)="([^"/#]+\.(?:js|css))"', index):
    assert app_prefix + '/' + asset in files, 'Missing app asset: ' + asset
assert app_prefix + '/heif-assets.js' in files, 'Missing lazy HEIF decoder'
for notice in ['HEIF-NOTICES.md', 'libde265-COPYING.txt', 'libheif-COPYING.txt', 'libheif-js-LGPL-3.0.txt']:
    assert app_prefix + '/licenses/heif/' + notice in files, 'Missing HEIF notice: ' + notice
service = next(v for k, v in files.items() if k.endswith('/top.hrhome.nascinema.service/service.js'))
assert b'ownerTest' not in service and b'qaCandidate' not in service and b'Invalid test capability' not in service
assert b'require("sharp")' not in service and b'require("./' not in service
native_prefix=next(k.rsplit('/',1)[0] for k in files if k.endswith('/native-assets/worker-manifest.json'))
native={k.rsplit('/',1)[1]:value for k,value in files.items() if k.startswith(native_prefix+'/')}
expected={'linker','libc.so','libdl.so','libm.so','liblog.so','libz.so','libstdc++.so','NOTICE.AOSP.txt','AOSP-RUNTIME-PROVENANCE.json','p2p-connect-worker','worker-manifest.json'}
assert set(native)==expected, 'Native package contains unexpected or missing files'
provenance=json.loads(native['AOSP-RUNTIME-PROVENANCE.json'])
for name,pin in provenance['files'].items():
    assert len(native[name])==pin['size'] and hashlib.sha256(native[name]).hexdigest()==pin['sha256'], name
assert hashlib.sha256(native['NOTICE.AOSP.txt']).hexdigest()==provenance['selectedNoticeSha256']
worker=json.loads(native['worker-manifest.json'])
assert worker==json.loads((root/'native/worker-manifest.json').read_text())
assert len(native['p2p-connect-worker'])==worker['size'] and hashlib.sha256(native['p2p-connect-worker']).hexdigest()==worker['sha256']
assert native['p2p-connect-worker'][:5]==b'\x7fELF\x01' and struct.unpack_from('<H',native['p2p-connect-worker'],18)[0]==40
assert b'worker-fpe' not in native['p2p-connect-worker'] and b'worker-divzero' not in native['p2p-connect-worker']
for name in files:
    parts = pathlib.PurePosixPath(name).parts
    assert not any(p in {'.local', '.state', 'state', '_ares', 'node_modules'} for p in parts), name
    assert pathlib.PurePosixPath(name).name not in {'session.json', 'device-id', 'nas.json', 'clients.json', 'pair-code'}, name
    assert pathlib.PurePosixPath(name).name not in {'libugagentsdk.so','libpgJniTunnel.so','private-configuration.json','owner-access.json','worker-fpe.h','worker-divzero.h'}, name
for filename, expected in [(app['icon'], (80, 80)), (app['largeIcon'], (130, 130))]:
    png = next(v for k, v in files.items() if k.endswith('/applications/top.hrhome.nascinema/' + filename))
    assert png[:8] == b'\x89PNG\r\n\x1a\n' and struct.unpack('>II', png[16:24]) == expected
print(json.dumps({'package': path.name, 'title': app['title'], 'version': app['version'], 'files': len(files), 'nativeFiles':len(native),'proprietarySdkIncluded':False,'workerSha256':worker['sha256'],'onDeviceService': True, 'privateStateAndDebugHooks': False}, ensure_ascii=True))
