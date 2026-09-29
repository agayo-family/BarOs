from pathlib import Path
import uuid
from .config import UPLOAD_DIR

class LocalStorage:
    def __init__(self):
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    async def save(self, filename: str, data: bytes) -> str:
        safe = Path(filename).name.replace(" ", "_")
        path = UPLOAD_DIR / f"{uuid.uuid4().hex}_{safe}"
        path.write_bytes(data)
        return str(path)

storage = LocalStorage()
