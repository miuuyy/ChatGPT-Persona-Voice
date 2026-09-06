#!/usr/bin/env python3
"""Run model-free Chatterbox stream/protocol tests with only NumPy and soxr."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
for name in ("chatterbox-streaming.test.py", "chatterbox-worker.test.py", "chatterbox-download.test.py"):
    subprocess.run([sys.executable, str(root / "tests" / name)], cwd=root, check=True)
