"""Install the small local speaker model with size and SHA-256 verification."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = json.loads(Path(__file__).with_name("speaker-model.json").read_text(encoding="utf-8"))


def install_speaker_model():
    from download_model import download_file
    path = ROOT / ".cache" / "asr" / SPEC["path"]
    # Both official mirrors must match the pinned HF LFS SHA-256 exactly.
    try:
        download_file(SPEC["releaseUrl"], path, SPEC["bytes"], SPEC["sha256"])
    except (OSError, TimeoutError):
        download_file(SPEC["url"], path, SPEC["bytes"], SPEC["sha256"])
    print(f"Verified speaker model: {path}", flush=True)
    return path


if __name__ == "__main__":
    install_speaker_model()
