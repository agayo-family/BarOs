import base64, hashlib, hmac, os, secrets
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from .config import SESSION_SECRET

serializer = URLSafeTimedSerializer(SESSION_SECRET, salt="baros-session")

def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 210_000)
    return f"pbkdf2_sha256$210000${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"

def verify_password(password: str, stored: str) -> bool:
    try:
        _, rounds, salt_b64, hash_b64 = stored.split("$", 3)
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(rounds))
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False

def make_session(user_id: int) -> str:
    return serializer.dumps({"uid": user_id})

def read_session(token: str, max_age: int = 60*60*24*14):
    try:
        return serializer.loads(token, max_age=max_age)
    except (BadSignature, SignatureExpired):
        return None

def invite_token() -> str:
    return secrets.token_urlsafe(24)
