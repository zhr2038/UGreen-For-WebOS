# Synthetic audio fixture

`photo-music-tone.mp3` is an authored 0.5-second 440Hz sine wave, stereo 22.05kHz,
32kbps MPEG Layer III. It contains no recording, personal metadata or copyrighted
music. The generated tone is dedicated to the public domain under CC0-1.0.

Reproduce with FFmpeg:

```sh
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=22050:duration=0.5 -ac 2 -c:a libmp3lame -b:a 32k -metadata title="Synthetic test tone" photo-music-tone.mp3
```

The browser regression keeps every WebAudio Gain at zero; this test tone is
decoded and clocked but never intentionally sent at audible volume.
