"""Synthesize a short two-person planning meeting with espeak-ng.

Lines alternate between two voices with pauses between turns, so the
recording has the silences read_audio cuts at. Output: meeting.mp3.
Usage: python make_meeting.py <out_dir>
"""

import subprocess
import sys
import tempfile
from pathlib import Path

LINES = [
    ("en-us", "Okay, let's start. The goal today is to agree on the jobs endpoint for the relay gateway."),
    ("en-gb+f3", "I looked at the current routes. Right now we have slash v1 slash chat and slash v1 slash audio."),
    ("en-us", "For job submission, I suggest slash v1 slash relay slash jobs. It keeps everything under one prefix."),
    ("en-gb+f3", "Agreed. And the request limit should stay at one hundred twenty requests per minute for now."),
    ("en-us", "One more decision: retries. Failed jobs go to the dead letter queue after three attempts."),
    ("en-gb+f3", "Fine. Action items: Joe writes the endpoint by Friday, and I update the docs."),
    ("en-us", "Great. Decision recap: slash v1 slash relay slash jobs, one hundred twenty per minute, three retries. Thanks."),
]


def main(out: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        parts = []
        for i, (voice, text) in enumerate(LINES):
            wav = Path(tmp) / f"{i:02d}.wav"
            subprocess.run(["espeak-ng", "-v", voice, "-s", "150", "-w", str(wav), text], check=True)
            parts.append(wav)
        inputs, filters = [], []
        for i, wav in enumerate(parts):
            inputs += ["-i", str(wav)]
            filters.append(f"[{i}]aresample=16000,apad=pad_dur=1.2[a{i}]")
        concat = "".join(f"[a{i}]" for i in range(len(parts))) + f"concat=n={len(parts)}:v=0:a=1[out]"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs,
                        "-filter_complex", ";".join(filters) + ";" + concat, "-map", "[out]",
                        "-c:a", "libmp3lame", "-b:a", "48k", str(out / "meeting.mp3")], check=True)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
