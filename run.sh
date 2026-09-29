#!/usr/bin/env bash
set -e
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
mkdir -p data/uploads
python -m uvicorn baros.main:app --host 0.0.0.0 --port 8000
