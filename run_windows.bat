@echo off
python -m venv .venv
call .venv\Scripts\activate
python -m pip install -r requirements.txt
if not exist data mkdir data
if not exist data\uploads mkdir data\uploads
python -m uvicorn baros.main:app --host 0.0.0.0 --port 8000
