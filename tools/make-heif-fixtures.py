"""Regenerate authored color charts; requires Pillow and pillow-heif, no photos."""
import argparse
import json
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--deps')
parser.add_argument('--out', default='test/fixtures/heif')
parser.add_argument('--large', action='store_true')
args = parser.parse_args()
if args.deps:
    sys.path.insert(0, args.deps)
from PIL import Image, ImageDraw
import pillow_heif

out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)
chart = Image.new('RGB', (96, 64))
draw = ImageDraw.Draw(chart)
for rectangle, color in [((0, 0, 47, 31), (255, 0, 0)), ((48, 0, 95, 31), (0, 255, 0)), ((0, 32, 47, 63), (0, 0, 255)), ((48, 32, 95, 63), (255, 255, 0))]:
    draw.rectangle(rectangle, fill=color)
exif = Image.Exif()
exif[274] = 1
image = pillow_heif.from_bytes('RGB', chart.size, chart.tobytes())
base = out / 'exif-1.heic'
image.save(base, quality=95, exif=exif.tobytes())
encoded = base.read_bytes()
tiff = exif.tobytes()[6:]
assert encoded.count(tiff) == 1
transpose = {2: Image.Transpose.FLIP_LEFT_RIGHT, 3: Image.Transpose.ROTATE_180, 4: Image.Transpose.FLIP_TOP_BOTTOM, 5: Image.Transpose.TRANSPOSE, 6: Image.Transpose.ROTATE_270, 7: Image.Transpose.TRANSVERSE, 8: Image.Transpose.ROTATE_90}
expected = {}
for orientation in range(1, 9):
    exif[274] = orientation
    # Patch only the TIFF value; no HEIF irot/imir property is introduced.
    name = f'exif-{orientation}.heic'
    (out / name).write_bytes(encoded.replace(tiff, exif.tobytes()[6:]))
    reference = chart.transpose(transpose[orientation]) if orientation != 1 else chart
    w, h = reference.size
    expected[name] = {'width': w, 'height': h, 'colors': [reference.getpixel((x, y)) for x, y in [(w//4, h//4), (w*3//4, h//4), (w//4, h*3//4), (w*3//4, h*3//4)]]}
exif[274] = 6
image.save(out / 'geometry-and-exif-6.heic', quality=95, exif=exif.tobytes())
expected['geometry-and-exif-6.heic'] = expected['exif-6.heic']
multiple = pillow_heif.from_bytes('RGB', (32, 32), Image.new('RGB', (32, 32), 'magenta').tobytes())
multiple.add_frombytes('RGB', chart.size, chart.tobytes())
multiple.save(out / 'primary-second.heic', quality=95, primary_index=1)
expected['primary-second.heic'] = expected['exif-1.heic']
(out / 'expected.json').write_text(json.dumps(expected, indent=2) + '\n')
if args.large:
    large = chart.resize((4032, 3024), resample=Image.Resampling.NEAREST)
    pillow_heif.from_bytes('RGB', large.size, large.tobytes()).save(out / 'synthetic-12mp.heic', quality=80)
print(json.dumps({'fixtures': len(expected), 'encoder': pillow_heif.libheif_info()['libheif']}))
