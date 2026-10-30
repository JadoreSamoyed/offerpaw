#!/usr/bin/env sh
set -eu
TASK_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TASK_PYTHON="${PYTHON:-python3}"
TASK_VENV="$TASK_ROOT/.cache/asr/venv"
if [ ! -x "$TASK_VENV/bin/python" ]; then
  "$TASK_PYTHON" -m venv "$TASK_VENV"
fi
"$TASK_VENV/bin/python" -m pip install --disable-pip-version-check -r "$TASK_ROOT/services/asr-local/requirements.txt"
"$TASK_VENV/bin/python" "$TASK_ROOT/services/asr-local/download_model.py"
"$TASK_VENV/bin/python" "$TASK_ROOT/services/asr-local/smoke_test.py"
printf 'Local ASR installed. Run: %s %s\n' "$TASK_VENV/bin/python" "$TASK_ROOT/services/asr-local/server.py"
