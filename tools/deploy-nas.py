"""Deploy only this project to its own SSD directory on the user's NAS.

Credentials are provided through NAS_USER / NAS_PASSWORD, never source files.
"""
import io
import json
import os
import pathlib
import shlex
import sys
import time
import urllib.request
import tarfile
import paramiko

root = pathlib.Path(__file__).resolve().parent.parent
target = '/volume1/docker/lg-nas-cinema'
host = os.environ['NAS_HOST']
password = os.environ['NAS_PASSWORD']
client = paramiko.SSHClient()
client.load_system_host_keys()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=os.environ['NAS_USER'], password=password,
               timeout=15, look_for_keys=False, allow_agent=False)


def sudo(command, payload=None):
    stdin, stdout, stderr = client.exec_command('sudo -S -p "" ' + command, timeout=240)
    stdin.write(password + '\n')
    stdin.flush()
    if payload:
        stdin.channel.sendall(payload)
    stdin.channel.shutdown_write()
    out = stdout.read().decode('utf-8', 'replace')
    error = stderr.read().decode('utf-8', 'replace')
    code = stdout.channel.recv_exit_status()
    if code:
        raise RuntimeError(f'Deployment command failed ({code}): {error[-2000:]}')
    return out, error


try:
    sudo('install -d -m 0755 ' + shlex.quote(target))
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as archive:
        for name in ['server.mjs', 'lib', 'app', 'compose.yaml', 'Dockerfile', '.dockerignore', 'package.json', 'package-lock.json']:
            archive.add(root / name, arcname=name)
        for name in ['configure-nas.mjs', 'pair-code.mjs']:
            archive.add(root / 'tools' / name, arcname='tools/' + name)
        archive.add(root / '.local/bridge/nas.json', arcname='state/nas.json')
    sudo('tar -xf - -C ' + shlex.quote(target), buffer.getvalue())
    sudo('chmod 0700 ' + shlex.quote(target + '/state'))
    sudo('chmod 0600 ' + shlex.quote(target + '/state/nas.json'))
    compose = 'docker compose --project-directory ' + shlex.quote(target) + ' -f ' + shlex.quote(target + '/compose.yaml')
    sudo(compose + ' config --quiet')
    print('Project copied and compose configuration validated.', flush=True)
    out, error = sudo(compose + ' build --pull')
    print('Runtime image ready.', flush=True)
    out, error = sudo(compose + ' up -d')
    print(out[-1200:] + error[-1200:], flush=True)
    out, _ = sudo('docker inspect lg-nas-cinema --format "{{.State.Status}}"')
    print('Container:', out.strip(), flush=True)
    for attempt in range(40):
        try:
            with urllib.request.urlopen(f'http://{host}:8780/health', timeout=2) as response:
                if json.loads(response.read()).get('ok'):
                    break
        except OSError:
            time.sleep(.25)
    else:
        raise RuntimeError('NAS service did not become healthy')
    # Keep the generated code private on the development computer for TV setup.
    out, _ = sudo('cat ' + shlex.quote(target + '/state/pair-code'))
    (root / '.local/nas-pair-code').write_text(out.strip(), encoding='utf-8')
    print('TV pairing code saved privately. Deployment complete.', flush=True)
finally:
    client.close()
