import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
_raw_db = os.getenv("DATABASE_URL", f"sqlite:///{BASE_DIR / 'data' / 'baros.db'}")
# Render/managed PostgreSQL providers may expose postgres://. Normalize it to psycopg v3.
if _raw_db.startswith("postgres://"):
    _raw_db = "postgresql+psycopg://" + _raw_db[len("postgres://"):]
elif _raw_db.startswith("postgresql://") and "+psycopg" not in _raw_db:
    _raw_db = "postgresql+psycopg://" + _raw_db[len("postgresql://"):]
DATABASE_URL = _raw_db
SESSION_SECRET = os.getenv("SESSION_SECRET", "baros-dev-secret-change-me")
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", str(BASE_DIR / "data" / "uploads")))
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "15"))
AI_GATEWAY_API_KEY = os.getenv("AI_GATEWAY_API_KEY", "")
AI_GATEWAY_BASE_URL = os.getenv("AI_GATEWAY_BASE_URL", "https://ai-gateway.vercel.sh/v1")
AI_MODEL = os.getenv("AI_MODEL", "openai/gpt-5.6-sol")
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
FIRST_RUN_TOKEN = os.getenv("FIRST_RUN_TOKEN", "")
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "0").lower() in {"1", "true", "yes", "on"}
