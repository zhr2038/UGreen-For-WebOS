"""Read the Matroska cue index and create independent HDR10 HLS segments."""
import hashlib
import hmac
import json
import re
import struct
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import BoundedSemaphore
import math
import os
import subprocess
from dataclasses import dataclass

SEGMENT, INFO, CUES = 0x18538067, 0x1549A966, 0x1C53BB6B
SEEK_HEAD, CLUSTER = 0x114D9B74, 0x1F43B675

def vint(stream, *, identifier=False):
    first = stream.read(1)
    if not first or not first[0]:
        raise ValueError("Invalid Matroska integer")
    mask = 0x80
    length = 1
    while not first[0] & mask:
        length += 1
        mask >>= 1
    if identifier and length > 4:
        raise ValueError("Invalid Matroska element ID")
    rest = stream.read(length - 1)
    if len(rest) != length - 1:
        raise ValueError("Truncated Matroska integer")
    start = first[0] if identifier else first[0] & (mask - 1)
    value = int.from_bytes(bytes((start,)) + rest, "big")
    if not identifier and value == (1 << (length * 7)) - 1:
        return None
    return value

def element(stream, offset, limit):
    stream.seek(offset)
    kind, size = vint(stream, identifier=True), vint(stream)
    data = stream.tell()
    end = limit if size is None else data + size
    if not (offset < data <= end <= limit):
        raise ValueError("Invalid Matroska element range")
    return kind, data, end

def children(stream, start, end):
    while start < end:
        item = element(stream, start, end)
        yield item
        start = item[2]

def uint(stream, start, end):
    if not 1 <= end - start <= 8:
        raise ValueError("Invalid Matroska element value")
    stream.seek(start)
    return int.from_bytes(stream.read(end - start), "big")

def first_child(stream, parent, kind):
    if parent is None:
        return None
    return next((item for item in children(stream, parent[1], parent[2]) if item[0] == kind), None)

@dataclass(frozen=True)
class MovieTimeline:
    starts: tuple
    duration_ms: int

    @classmethod
    def load(cls, filename):
        with open(filename, "rb") as stream:
            size = os.fstat(stream.fileno()).st_size
            segment = first_child(stream, (0, 0, size), SEGMENT)
            if not segment:
                raise ValueError("A seekable Matroska segment is required")
            indexes = {}
            info = None
            for item in children(stream, segment[1], segment[2]):
                if item[0] == CLUSTER or (info and CUES in indexes):
                    break
                if item[0] == INFO:
                    info = item
                if item[0] == SEEK_HEAD:
                    for record in children(stream, item[1], item[2]):
                        seek_id = first_child(stream, record, 0x53AB)
                        seek_pos = first_child(stream, record, 0x53AC)
                        if record[0] == 0x4DBB and seek_id and seek_pos:
                            indexes[uint(stream, *seek_id[1:])] = segment[1] + uint(stream, *seek_pos[1:])
            if not info or CUES not in indexes:
                raise ValueError("Matroska cue index is required")
            cues = element(stream, indexes[CUES], segment[2])
            if cues[0] != CUES or cues[2] - cues[1] > 4 * 1024 * 1024:
                raise ValueError("Invalid Matroska cue index")
            scale_item = first_child(stream, info, 0x2AD7B1)
            scale = uint(stream, *scale_item[1:]) if scale_item else 1_000_000
            dur = first_child(stream, info, 0x4489)
            if not dur or dur[2] - dur[1] not in (4, 8):
                raise ValueError("Matroska duration is required")
            stream.seek(dur[1])
            duration_ms = round(struct.unpack(">d" if dur[2] - dur[1] == 8 else ">f", stream.read(dur[2] - dur[1]))[0] * scale / 1_000_000)
            keyframes = []
            for item in children(stream, cues[1], cues[2]):
                if item[0] != 0xBB:
                    continue
                time = first_child(stream, item, 0xB3)
                for position in children(stream, item[1], item[2]):
                    if position[0] != 0xB7:
                        continue
                    cue_track = first_child(stream, position, 0xF7)
                    if cue_track and uint(stream, *cue_track[1:]) == 1 and time:
                        keyframes.append(round(uint(stream, *time[1:]) * scale / 1_000_000))
                        break
            anchors = sorted(set(value for value in keyframes if 0 <= value < duration_ms))
            if not anchors or anchors[0] > 200 or duration_ms <= 0:
                raise ValueError("Matroska video cue index is incomplete")
            # Intermediate starts are actual video keyframes. Keep a small
            # buffer per HTTP request and make seeking independent of play time.
            starts = [anchors[0]]
            for value in anchors[1:]:
                if value - starts[-1] >= 5000 and duration_ms - value >= 750:
                    starts.append(value)
            if any(b - a > 20_000 for a, b in zip(starts, starts[1:] + [duration_ms])):
                raise ValueError("Video cue gaps are too large")
            return cls(tuple(starts), duration_ms)

    def segment(self, index):
        start = self.starts[index]
        end = self.starts[index+1] if index + 1 < len(self.starts) else self.duration_ms
        return start, end

    def ffmpeg(self, filename, index):
        start, end = self.segment(index)
        # Matroska seeks to the preceding cluster. Seek just inside this GOP
        # and keep the original timestamps and the audio from its start.
        seek = start + 250 if index else 0
        return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                "-ss", f"{seek / 1000:.3f}", "-noaccurate_seek", "-i", filename,
                "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-c:a", "eac3", "-b:a", "640k",
                "-af", f"atrim=start={start / 1000:.3f}", "-copyts", "-to", f"{end / 1000:.3f}",
                "-muxdelay", "0",
                "-mpegts_flags", "+resend_headers", "-f", "mpegts", "pipe:1"]

    def playlist(self):
        lengths = [self.segment(i)[1] - self.segment(i)[0] for i in range(len(self.starts))]
        lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-PLAYLIST-TYPE:VOD",
                 "#EXT-X-INDEPENDENT-SEGMENTS", "#EXT-X-MEDIA-SEQUENCE:0",
                 f"#EXT-X-TARGETDURATION:{math.ceil(max(lengths) / 1000)}"]
        for i, length in enumerate(lengths):
            lines += [f"#EXTINF:{length / 1000:.3f},", f"{i}.ts"]
        return "\n".join(lines + ["#EXT-X-ENDLIST", ""])


def serve(settings):
    configured = Path(settings["source"])
    expected = (settings["device"], settings["inode"], settings["size"])

    def source_path():
        def matches(path):
            try:
                entry = path.lstat()
                return not path.is_symlink() and (entry.st_dev, entry.st_ino, entry.st_size) == expected
            except FileNotFoundError:
                return False
        if matches(configured):
            return configured
        # A library rename keeps the inode. Only look in the configured folder.
        return next((entry for entry in configured.parent.iterdir() if matches(entry)), None)

    initial = source_path()
    if initial is None:
        raise FileNotFoundError("Configured audio source is missing")
    timeline = MovieTimeline.load(initial)
    metadata = initial.stat()
    stat_key = (metadata.st_size, metadata.st_mtime_ns, metadata.st_ino)
    playlist = timeline.playlist().encode("ascii")
    secret = bytes.fromhex(settings["key"])
    if len(secret) != 32:
        raise ValueError("A 32 byte signing key is required")
    slots = BoundedSemaphore(2)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def authorized(self):
            if self.client_address[0] != settings["peer"]:
                return False
            raw_time = self.headers.get("X-CloudFrame-Time", "")
            signature = self.headers.get("X-CloudFrame-Signature", "")
            if not re.fullmatch(r"[0-9]{10}", raw_time) or abs(int(time.time()) - int(raw_time)) > 45:
                return False
            expected = hmac.new(secret, f"GET\n{self.path}\n{raw_time}".encode("ascii"), hashlib.sha256).hexdigest()
            return hmac.compare_digest(signature, expected)

        def send_bytes(self, data, mime):
            value = self.headers.get("Range")
            match = re.fullmatch(r"bytes=(\d+)-(\d*)", value or "")
            if value and not match:
                self.send_error(416)
                return
            start = int(match[1]) if match else 0
            stop = min(len(data), int(match[2]) + 1) if match and match[2] else len(data)
            if start >= stop:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{len(data)}")
                self.end_headers()
                return
            self.send_response(206 if match else 200)
            if match:
                self.send_header("Content-Range", f"bytes {start}-{stop-1}/{len(data)}")
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(stop-start))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(memoryview(data)[start:stop])

        def do_GET(self):
            match = re.fullmatch(r"/([0-9]{1,5})\.ts", self.path)
            if not (self.path == "/playlist.m3u8" or match) or not self.authorized():
                self.send_error(404)
                return
            filename = source_path()
            if filename is None:
                self.send_error(409)
                return
            current = filename.stat()
            if (current.st_size, current.st_mtime_ns, current.st_ino) != stat_key:
                self.send_error(409)
                return
            if self.path == "/playlist.m3u8":
                self.send_bytes(playlist, "application/vnd.apple.mpegurl")
                return
            segment = int(match[1])
            if segment >= len(timeline.starts):
                self.send_error(404)
                return
            if not slots.acquire(timeout=10):
                self.send_error(503)
                return
            try:
                result = subprocess.run(timeline.ffmpeg(str(filename), segment), capture_output=True, timeout=18, check=True)
                if not result.stdout or len(result.stdout) > 192 * 1024 * 1024:
                    self.send_error(502)
                    return
                self.send_bytes(result.stdout, "video/mp2t")
            except (BrokenPipeError, ConnectionResetError):
                pass
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                self.send_error(502)
            finally:
                slots.release()

    ThreadingHTTPServer((settings["listen"], settings["port"]), Handler).serve_forever()


if __name__ == "__main__":
    import sys
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 nas-movie-audio.py /private/settings.json")
    serve(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")))
