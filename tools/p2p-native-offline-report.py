"""Read an owner's official APK ELF metadata; never load or execute its code.

Research dependency: pyelftools. This is not needed by the television app.
No archive member is extracted and no NAS state/credentials are read.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import zipfile

from elftools.elf.elffile import ELFFile


def metadata(name, raw):
    elf = ELFFile(io.BytesIO(raw))
    dynamic = elf.get_section_by_name('.dynamic')
    dependencies = [tag.needed for tag in dynamic.iter_tags() if tag.entry.d_tag == 'DT_NEEDED'] if dynamic else []
    symbols = list(elf.get_section_by_name('.dynsym').iter_symbols())
    provided = {s.name for s in symbols if s.name and s['st_shndx'] != 'SHN_UNDEF'}
    required = {s.name for s in symbols if s.name and s['st_shndx'] == 'SHN_UNDEF' and s['st_info']['bind'] != 'STB_WEAK'}
    weak = {s.name for s in symbols if s.name and s['st_shndx'] == 'SHN_UNDEF' and s['st_info']['bind'] == 'STB_WEAK'}
    android = None
    note = elf.get_section_by_name('.note.android.ident')
    if note:
        notes = list(note.iter_notes())
        if notes:
            data = notes[0]['n_descdata']
            android = {'minimumApi': struct.unpack('<I', data[:4])[0], 'ndk': data[4:68].split(b'\0')[0].decode(errors='replace')}
    capi = [{'name': s.name, 'address': s['st_value'], 'size': s['st_size']} for s in symbols if s.name.startswith('sdk_') and s['st_shndx'] != 'SHN_UNDEF']
    report = {'name': name, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw), 'bits': elf.elfclass, 'machine': elf['e_machine'], 'flags': elf['e_flags'], 'dependencies': dependencies, 'android': android, 'cExports': capi, 'strongImports': len(required), 'weakImports': len(weak)}
    return report, provided, required, weak


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk', type=Path)
    parser.add_argument('--runtime', type=Path, help='Optional local ARMv7 Bionic runtime directory for symbol-closure inspection')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    reports, symbols = [], []
    with zipfile.ZipFile(args.apk) as archive:
        for name in archive.namelist():
            if not name.endswith(('/libugagentsdk.so', '/libpgJniTunnel.so')):
                continue
            if archive.getinfo(name).file_size > 32 * 1024 * 1024:
                raise ValueError('Native library exceeds the research size bound')
            item = metadata(name, archive.read(name))
            reports.append(item[0])
            if '/armeabi-v7a/' in name:
                symbols.append((name, *item[1:]))
    result = {'apkSha256': hashlib.sha256(args.apk.read_bytes()).hexdigest(), 'libraries': reports, 'runtimeExecutionProved': False, 'p2pEstablished': False}
    if args.runtime:
        for name in ['linker', 'libc.so', 'libdl.so', 'libm.so', 'liblog.so', 'libz.so', 'libstdc++.so']:
            p = args.runtime / name
            if not p.is_file():
                raise FileNotFoundError(name)
            item = metadata(name, p.read_bytes())
            symbols.append((name, *item[1:]))
        available = set().union(*(s[1] for s in symbols))
        result['armv7SymbolClosure'] = {
            'missingStrongImports': [{'library': name, 'symbol': s} for name, _, required, _ in symbols for s in sorted(required - available)],
            'unresolvedWeakImports': [{'library': name, 'symbol': s} for name, _, _, weak in symbols for s in sorted(weak - available)],
            'note': 'Symbol names alone do not prove version compatibility, initialization, sandbox execution or P2P.',
        }
    text = json.dumps(result, indent=2)
    if args.output:
        args.output.write_text(text, encoding='utf8')
        print('Offline report written; no library was loaded or executed.')
    else:
        print(text)


if __name__ == '__main__':
    main()
