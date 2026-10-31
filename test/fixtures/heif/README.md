# Authored HEIF fixtures

These tiny HEVC-in-HEIF images contain four solid color rectangles made for this
repository. No personal photo, camera identifier or location is included.
The fixture artwork is dedicated to the public domain under CC0-1.0.

Reproduce with `tools/make-heif-fixtures.py` and Pillow/pillow-heif (generation
validated with Pillow 13.0.0, pillow-heif 1.8.1, libheif 1.23.6/x265).
The eight `exif-*` files patch only the TIFF orientation value after encoding;
`geometry-and-exif-6` has both HEIF rotation and EXIF orientation and must rotate
once; `primary-second` has a magenta non-primary image before the actual chart.
`expected.json` records dimensions and quarter-center pixel colors independently
from the decoder, using Pillow's documented transpose operations.

The decoder library and its LGPL notices are separate from these fixtures.
