#!/usr/bin/env python3
"""Score local benchmark recordings; ASR and DNSMOS are proxies, not listening acceptance.

Evaluation dependencies are separate from the locked product runtime:
mlx-whisper, librosa, soundfile, numpy, onnxruntime. All model paths must already
exist locally. No speech is uploaded and this script does not download models.
"""

import argparse
import hashlib
import json
from pathlib import Path
import unicodedata


def normalize(text):
    text = unicodedata.normalize("NFKC", text).casefold()
    return " ".join("".join(c if c.isalnum() or c.isspace() else " " for c in text).split())


def error_rate(reference, hypothesis):
    if not reference:
        return None
    previous = list(range(len(hypothesis) + 1))
    for i, token in enumerate(reference, 1):
        row = [i]
        for j, other in enumerate(hypothesis, 1):
            row.append(min(row[-1] + 1, previous[j] + 1, previous[j-1] + (token != other)))
        previous = row
    return previous[-1] / len(reference)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", required=True, type=Path)
    parser.add_argument("--reports", nargs="+", type=Path, default=[])
    parser.add_argument("--whisper-model", required=True, type=Path)
    parser.add_argument("--dnsmos-model", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.whisper_model = args.whisper_model.resolve(strict=True)
    if args.output.exists():
        raise ValueError(f"Output already exists: {args.output}")
    import librosa
    import mlx_whisper
    import numpy as np
    import soundfile as sf
    session = None
    if args.dnsmos_model:
        import onnxruntime as ort
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        session = ort.InferenceSession(str(args.dnsmos_model.resolve(strict=True)), opts, providers=["CPUExecutionProvider"])
    sources = json.loads(args.sources.read_text())["sources"]
    files = [(entry, "source", "source", args.sources.parent / entry["path"], entry["sha256"]) for entry in sources]
    for report_file in args.reports:
        for case in json.loads(report_file.read_text())["cases"]:
            files.append((next(x for x in sources if x["id"] == case["sourceId"]),
                          report_file.parent.name, case["profile"], report_file.parent / case["output"], case["outputSha256"]))
    source_asr = {}
    results = []
    for entry, run, profile, file, sha256 in files:
        if hashlib.sha256(file.read_bytes()).hexdigest() != sha256:
            raise ValueError(f"Audio digest mismatch: {file}")
        samples, rate = sf.read(file, dtype="float32", always_2d=True)
        samples = samples.mean(axis=1)
        if not len(samples) or not np.isfinite(samples).all():
            raise ValueError(f"Invalid audio: {file}")
        pcm16 = librosa.resample(samples, orig_sr=rate, target_sr=16000)
        asr = mlx_whisper.transcribe(
            pcm16, path_or_hf_repo=str(args.whisper_model), language=entry["language"],
            temperature=0, condition_on_previous_text=False, fp16=True, verbose=None,
        )["text"]
        recognized = normalize(asr)
        truth = normalize(entry["transcript"])
        if profile == "source":
            source_asr[entry["id"]] = recognized
        original_asr = source_asr[entry["id"]]
        result = {
            "sourceId": entry["id"], "language": entry["language"], "run": run, "profile": profile,
            "file": str(file), "sha256": sha256, "transcript": asr,
            "referenceCer": error_rate(truth.replace(" ", ""), recognized.replace(" ", "")),
            "sourceAsrCer": error_rate(original_asr.replace(" ", ""), recognized.replace(" ", "")),
            "referenceWer": error_rate(truth.split(), recognized.split()) if entry["language"] in ("ru", "en") else None,
            "sourceAsrWer": error_rate(original_asr.split(), recognized.split()) if entry["language"] in ("ru", "en") else None,
        }
        if session:
            # Microsoft DNSMOS P.835, non-personalized calibration. This does not measure speaker likeness.
            # https://github.com/microsoft/DNS-Challenge/blob/master/DNSMOS/dnsmos_local.py
            window = int(9.01 * 16000)
            extended = pcm16
            while len(extended) < window:
                extended = np.concatenate([extended, extended])
            scores = []
            for start in range(0, len(extended) - window + 1, 16000):
                sig, bak, ovr = session.run(None, {"input_1": extended[start:start + window][None].astype("float32")})[0][0]
                scores.append([
                    np.polyval([-0.08397278, 1.22083953, 0.0052439], sig),
                    np.polyval([-0.13166888, 1.60915514, -0.39604546], bak),
                    np.polyval([-0.06766283, 1.11546468, 0.04602535], ovr),
                ])
            result["dnsmosSig"], result["dnsmosBak"], result["dnsmosOvrl"] = np.mean(scores, axis=0).tolist()
        results.append(result)
        args.output.write_text(json.dumps({
            "scope": "ASR intelligibility and DNSMOS signal quality proxies; not human naturalness or speaker acceptance",
            "whisperModel": str(args.whisper_model),
            "dnsmosModelSha256": hashlib.sha256(args.dnsmos_model.read_bytes()).hexdigest() if args.dnsmos_model else None,
            "cases": results,
        }, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
