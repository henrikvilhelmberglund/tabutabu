"""Split a song into instrument stems with HT-Demucs (6 stems: drums, bass,
other, vocals, guitar, piano), for the reference spectrogram.

Optional: the app works without it. Needs a Python environment with torch
and demucs (see tools/README.md) and ffmpeg on PATH. Uses the GPU when
torch sees one, otherwise the CPU (much slower).

Usage: python separate.py <input audio> <output dir> [model]

Writes <output dir>/<stem>.ogg (Opus) for every stem. Prints lines the
server reads:
    PROGRESS <0..1>
    DEVICE <cuda|cpu>
    DONE
"""

import subprocess
import sys
from pathlib import Path

import numpy as np
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model

SAMPLE_RATE = 44100


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


def encode(samples: np.ndarray, path: Path):
    """float32 (2, samples) -> Opus file."""
    data = np.ascontiguousarray(samples.T, dtype=np.float32).tobytes()
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ac", "2", "-ar", str(SAMPLE_RATE), "-i", "-",
         "-c:a", "libopus", "-b:a", "192k", str(path)],
        input=data,
        check=True,
    )


class Progress:
    """Turns demucs' per-chunk progress bar into PROGRESS lines."""

    def __init__(self, iterable, **_):
        self.items = list(iterable)

    def __iter__(self):
        n = len(self.items)
        for i, item in enumerate(self.items):
            say("PROGRESS", f"{i / n:.3f}")
            yield item
        say("PROGRESS", "1")


def main():
    src, out_dir = sys.argv[1], Path(sys.argv[2])
    model_name = sys.argv[3] if len(sys.argv) > 3 else "htdemucs_6s"
    out_dir.mkdir(parents=True, exist_ok=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    say("DEVICE", device)
    model = get_model(model_name)
    model.eval()

    wav = torch.from_numpy(decode(src))
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav = (wav - mean) / std

    # demucs shows progress with tqdm; route it to our PROGRESS lines.
    import demucs.apply as demucs_apply

    demucs_apply.tqdm.tqdm = Progress
    with torch.no_grad():
        sources = apply_model(model, wav[None], device=device, split=True, overlap=0.25, progress=True)[0]
    sources = sources * std + mean

    for name, audio in zip(model.sources, sources):
        encode(audio.cpu().numpy(), out_dir / f"{name}.ogg")
    say("DONE")


if __name__ == "__main__":
    main()
