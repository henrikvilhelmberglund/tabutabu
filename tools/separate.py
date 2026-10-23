"""Split a song into instrument stems with HT-Demucs (6 stems: drums, bass,
other, vocals, guitar, piano), for the reference spectrogram.

Optional: the app works without it. Needs a Python environment with torch
and demucs (see tools/README.md) and ffmpeg on PATH. Uses the GPU when
torch sees one, otherwise the CPU (much slower).

Usage: python separate.py <input audio> <output dir> [model]
                          [--start <seconds>] [--length <seconds>]

Writes <output dir>/<stem>.ogg (Opus, for the app) and <stem>.flac
(lossless 24-bit, for exporting) for every stem. With --start / --length
only that stretch is separated; the stems are silent outside it but keep
the song's full length, so they still line up with it. Prints lines the
server reads:
    PROGRESS <0..1>
    DEVICE <cuda|cpu>
    DONE

The song is separated a minute at a time (crossfaded where pieces meet)
and each piece is streamed straight to the encoders, so memory use stays
the same however long the song is. Separating it in one go needs several
full-length copies of all six stems (about 2 GB each for 15 minutes).
"""

import argparse
import subprocess
from pathlib import Path

import numpy as np
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model

SAMPLE_RATE = 44100
# Demucs works in overlapping segments (7.8 s for HT-Demucs, 25 % overlap).
# Pieces start on that segment grid, so inside a piece the segments are the
# same ones a single pass would use; pieces overlap by a crossfade.
OVERLAP = 0.25
SEGMENT_SEC = 7.8
STRIDE = int((1 - OVERLAP) * int(SAMPLE_RATE * SEGMENT_SEC))
CHUNK = 10 * STRIDE  # about a minute
CROSSFADE_SEC = 2


def say(*parts):
    print(*parts, flush=True)


def decode(path: str) -> np.ndarray:
    """Any audio/video file -> float32 array (2, samples) at 44.1 kHz."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "2", "-ar", str(SAMPLE_RATE), "-"],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()


class Encoder:
    """An ffmpeg process turning streamed float32 stereo into an audio file."""

    def __init__(self, path: Path, codec: list[str]):
        self.path = path
        self.proc = subprocess.Popen(
            ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ac", "2", "-ar", str(SAMPLE_RATE), "-i", "-",
             *codec, str(path)],
            stdin=subprocess.PIPE,
        )

    def write(self, samples: np.ndarray):
        self.proc.stdin.write(np.ascontiguousarray(samples.T, dtype=np.float32).tobytes())

    def close(self):
        self.proc.stdin.close()
        if self.proc.wait() != 0:
            raise RuntimeError(f"ffmpeg failed writing {self.path.name}")

    def discard(self):
        """Stop and delete the half-written file (so it never looks done)."""
        self.proc.kill()
        self.proc.wait()
        self.path.unlink(missing_ok=True)


# Compressed copy the app plays and analyses, and a lossless 24-bit one for
# exporting to a DAW.
OPUS = ["-c:a", "libopus", "-b:a", "192k"]
FLAC = ["-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24"]


class Progress:
    """Turns demucs' per-segment progress bar into PROGRESS lines, scaled to
    the piece being separated (`Progress.done` of `Progress.total` pieces)."""

    done = 0
    total = 1

    def __init__(self, iterable, **_):
        self.items = list(iterable)

    def __iter__(self):
        n = len(self.items)
        for i, item in enumerate(self.items):
            say("PROGRESS", f"{(Progress.done + i / n) / Progress.total:.3f}")
            yield item


def write_silence(encoders: dict, samples: int):
    """Silence before / after the separated stretch, in blocks."""
    block = np.zeros((2, 10 * SAMPLE_RATE), dtype=np.float32)
    while samples > 0:
        n = min(samples, block.shape[-1])
        for pair in encoders.values():
            for enc in pair:
                enc.write(block[:, :n])
        samples -= n


def main():
    args = argparse.ArgumentParser()
    args.add_argument("input")
    args.add_argument("out_dir")
    args.add_argument("model", nargs="?", default="htdemucs_6s")
    args.add_argument("--start", type=float, default=0.0)
    args.add_argument("--length", type=float, default=None)
    opts = args.parse_args()
    src, out_dir, model_name = opts.input, Path(opts.out_dir), opts.model
    out_dir.mkdir(parents=True, exist_ok=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    say("DEVICE", device)
    model = get_model(model_name)
    model.eval()

    song = torch.from_numpy(decode(src))
    total = song.shape[-1]
    # The stretch to separate (the whole song by default).
    first = min(total, max(0, round(opts.start * SAMPLE_RATE)))
    last = total if opts.length is None else min(total, first + max(0, round(opts.length * SAMPLE_RATE)))
    wav = song[:, first:last]
    if wav.shape[-1] == 0:
        raise SystemExit("Nothing to separate: the start is past the end of the song")
    # Normalised over the whole stretch, so every piece is scaled the same.
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    length = wav.shape[-1]

    # demucs shows progress with tqdm; route it to our PROGRESS lines.
    import demucs.apply as demucs_apply

    demucs_apply.tqdm.tqdm = Progress

    encoders = {
        name: (Encoder(out_dir / f"{name}.flac", FLAC), Encoder(out_dir / f"{name}.ogg", OPUS))
        for name in model.sources
    }
    step = CHUNK
    fade_len = CROSSFADE_SEC * SAMPLE_RATE
    # Piece starts; the last piece runs to the end (with its crossfade
    # overlap, a piece may reach the end before the next step would start).
    starts = [0]
    while starts[-1] + step + fade_len < length:
        starts.append(starts[-1] + step)
    Progress.total = len(starts)
    # The end of the previous piece, overlapping the start of this one.
    tail = None
    try:
        write_silence(encoders, first)
        for i, start in enumerate(starts):
            Progress.done = i
            end = min(length, start + step + fade_len)
            piece = (wav[:, start:end] - mean) / std
            with torch.no_grad():
                est = apply_model(model, piece[None], device=device, split=True, overlap=OVERLAP, progress=True)[0]
            est = (est * std + mean).cpu().numpy()
            if tail is not None:
                k = tail.shape[-1]
                fade = np.linspace(0.0, 1.0, k, dtype=np.float32)
                est[..., :k] = tail * (1 - fade) + est[..., :k] * fade
            if end < length:
                out, tail = est[..., :step], est[..., step:].copy()
            else:
                out, tail = est, None
            for name, audio in zip(model.sources, out):
                for enc in encoders[name]:
                    enc.write(audio)
        write_silence(encoders, total - last)
    except BaseException:
        for pair in encoders.values():
            for enc in pair:
                enc.discard()
        raise
    for pair in encoders.values():
        for enc in pair:
            enc.close()
    say("PROGRESS", "1")
    say("DONE")


if __name__ == "__main__":
    main()
