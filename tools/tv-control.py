"""Operate the user's paired LG TV over its public SSAP remote interface."""
import argparse
import asyncio
import json
import pathlib
import ssl
import urllib.request
from aiowebostv import WebOsClient


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--app')
    parser.add_argument('--wait', type=float, default=1)
    parser.add_argument('--buttons', nargs='*', default=[])
    parser.add_argument('--capture', action='store_true')
    parser.add_argument('--return-pc', action='store_true')
    args = parser.parse_args()
    saved = json.loads(pathlib.Path('.local/lg-tv.json').read_text())
    client = WebOsClient(saved['host'], saved['clientKey'], connect_timeout=10)
    try:
        await client.connect()
        if args.app:
            await client.launch_app(args.app)
        await asyncio.sleep(args.wait)
        for button in args.buttons:
            await client.button(button)
            await asyncio.sleep(.4)
        if args.capture:
            await asyncio.sleep(.8)
            shot = await client.request('tv/executeOneShot')
            with urllib.request.urlopen(shot['imageUri'], context=ssl._create_unverified_context(), timeout=10) as response:
                pathlib.Path('.local/tv-shot.jpg').write_bytes(response.read())
            print('TV screenshot saved privately.')
        if args.return_pc:
            await client.launch_app('com.webos.app.hdmi1')
    finally:
        await client.disconnect()


if __name__ == '__main__':
    asyncio.run(main())
