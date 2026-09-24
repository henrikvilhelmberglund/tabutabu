# Optional: instrument separation

Tabutabu can split the reference audio into instrument stems (guitar, bass,
drums, vocals, piano, other) with [HT-Demucs](https://github.com/facebookresearch/demucs),
so the spectrogram and the pitch probe can show just the guitar. The app works
fine without it — this only adds the "Separate instruments" option.

It runs locally through the dev server. A recent NVIDIA GPU separates a song in
well under a minute; on a CPU it works too, but takes several minutes per song.

## Setup

Needs Python 3.10+ and ffmpeg on `PATH`. From the project root:

```sh
python -m venv .venv
# NVIDIA GPU (CUDA 12.8 builds also cover RTX 50-series):
.venv/Scripts/python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
# …or CPU only:
# .venv/Scripts/python -m pip install torch torchaudio
.venv/Scripts/python -m pip install demucs numpy
```

(On macOS/Linux the interpreter is `.venv/bin/python`.)

Restart the dev server afterwards. The first separation downloads the model
(~80 MB). Stems are cached per song in the system temp folder
(`tabutabu-stems`), so each song is only separated once.
