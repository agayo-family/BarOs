from __future__ import annotations

import logging
import re
import time
from collections import defaultdict, deque

from fastapi import Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import COOKIE_SECURE
from .core import app, current_user, get_db, render
from .db import SessionLocal
from .models import Course, Employee, Organization, Upload, User
from .security import hash_password, make_session, read_session

log = logging.getLogger("baros.platform")
SESSION_MAX_AGE = 60 * 60 * 24 * 14
PLATFORM_ORG_LIMIT = 200

_rate_buckets: dict[str, deque[float]] = defaultdict(deque)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()[:80]
    return (request.client.host if request.client else "unknown")[:80]


def _is_rate_limited(key: str, limit: int, window_seconds: int) -> bool:
    now = time.monotonic()
    bucket = _rate_buckets[key]
    while bucket and bucket[0] <= now - window_seconds:
        bucket.popleft()
    if len(bucket) >= limit:
        return True
    bucket.append(now)
    return False


def _secure_response(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    return response


def _valid_password(password: str) -> bool:
    return len(password) >= 10 and bool(re.search(r"[A-Za-zА-Яа-яЁё]", password)) and bool(re.search(r"\d", password))


def _platform_owner(request: Request, db: Session) -> User:
    user = current_user(request, db)
    if not user:
        raise HTTPException(401)
    if user.role != "platform_owner":
        raise HTTPException(403, "Доступ только владельцу платформы BarOS")
    return user


@app.on_event("startup")
def promote_legacy_platform_owner():
    with SessionLocal() as db:
        existing = db.scalar(select(User).where(User.role == "platform_owner"))
        if existing:
            return
        legacy = db.scalar(select(User).where(User.role == "owner").order_by(User.id.asc()))
        if legacy:
            legacy.role = "platform_owner"
            db.commit()
            log.warning("Promoted legacy BarOS owner user id=%s to platform_owner", legacy.id)


@app.middleware("http")
async def baros_security_and_platform_middleware(request: Request, call_next):
    path = request.url.path
    method = request.method.upper()
    ip = _client_ip(request)

    if method == "POST" and path == "/login" and _is_rate_limited(f"login:{ip}", 20, 15 * 60):
        return _secure_response(HTMLResponse("Слишком много попыток входа. Попробуйте позже.", status_code=429))

    if method == "POST" and path.startswith("/platform/") and _is_rate_limited(f"platform-write:{ip}", 40, 60 * 60):
        return _secure_response(HTMLResponse("Слишком много административных действий. Попробуйте позже.", status_code=429))

    if method == "POST" and path == "/uploads" and _is_rate_limited(f"uploads:{ip}", 60, 60 * 60):
        return _secure_response(HTMLResponse("Лимит загрузок на час исчерпан.", status_code=429))

    if method == "POST" and path == "/ai/training-draft" and _is_rate_limited(f"ai:{ip}", 20, 60 * 60):
        return _secure_response(HTMLResponse("Лимит AI-генераций на час исчерпан.", status_code=429))

    if method == "GET" and path == "/app" and not request.cookies.get("baros_platform_session"):
        session = read_session(request.cookies.get("baros_session", ""))
        if session:
            with SessionLocal() as db:
                user = db.get(User, session.get("uid"))
                if user and user.role == "platform_owner":
                    return _secure_response(RedirectResponse("/platform", 302))

    response = await call_next(request)
    if method == "POST" and path == "/logout":
        response.delete_cookie("baros_platform_session")
    return _secure_response(response)


@app.get("/platform", response_class=HTMLResponse)
def platform_dashboard(request: Request, db: Session = Depends(get_db)):
    owner = _platform_owner(request, db)
    organizations = db.scalars(select(Organization).order_by(Organization.created_at.desc())).all()
    rows = []
    for org in organizations:
        managers = db.scalars(select(User).where(User.organization_id == org.id, User.role == "manager").order_by(User.id.asc())).all()
        rows.append({
            "org": org,
            "managers": managers,
            "employees": db.scalar(select(func.count(Employee.id)).where(Employee.organization_id == org.id)) or 0,
            "courses": db.scalar(select(func.count(Course.id)).where(Course.organization_id == org.id)) or 0,
            "uploads": db.scalar(select(func.count(Upload.id)).where(Upload.organization_id == org.id)) or 0,
            "interview_done": bool((org.interview_json or "{}").strip() not in {"", "{}"}),
        })
    return render(request, "platform.html", {
        "user": owner,
        "venues": rows,
        "org_limit": PLATFORM_ORG_LIMIT,
        "error": request.query_params.get("error"),
        "created": request.query_params.get("created"),
    })


@app.post("/platform/venues")
def platform_create_venue(
    request: Request,
    venue: str = Form(...),
    manager_name: str = Form(...),
    manager_email: str = Form(...),
    manager_password: str = Form(...),
    db: Session = Depends(get_db),
):
    owner = _platform_owner(request, db)
    if (db.scalar(select(func.count(Organization.id))) or 0) >= PLATFORM_ORG_LIMIT:
        raise HTTPException(409, "Достигнут защитный лимит количества заведений")

    venue = venue.strip()
    email = manager_email.lower().strip()
    manager_name = manager_name.strip()
    if not venue or not manager_name:
        raise HTTPException(400, "Название заведения и имя управляющего обязательны")
    if not _valid_password(manager_password):
        return RedirectResponse("/platform?error=password", 303)
    if db.scalar(select(User).where(User.email == email)):
        return RedirectResponse("/platform?error=email", 303)

    org = Organization(name=venue)
    db.add(org)
    db.flush()
    manager = User(
        organization_id=org.id,
        email=email,
        password_hash=hash_password(manager_password),
        name=manager_name,
        role="manager",
    )
    db.add(manager)
    db.commit()
    log.warning("platform_owner id=%s created organization id=%s and manager id=%s", owner.id, org.id, manager.id)
    return RedirectResponse("/platform?created=1", 303)


@app.post("/platform/venues/{org_id}/managers")
def platform_add_manager(
    org_id: int,
    request: Request,
    manager_name: str = Form(...),
    manager_email: str = Form(...),
    manager_password: str = Form(...),
    db: Session = Depends(get_db),
):
    owner = _platform_owner(request, db)
    org = db.get(Organization, org_id)
    if not org:
        raise HTTPException(404)
    email = manager_email.lower().strip()
    if not _valid_password(manager_password):
        return RedirectResponse("/platform?error=password", 303)
    if db.scalar(select(User).where(User.email == email)):
        return RedirectResponse("/platform?error=email", 303)
    manager = User(
        organization_id=org.id,
        email=email,
        password_hash=hash_password(manager_password),
        name=manager_name.strip(),
        role="manager",
    )
    db.add(manager)
    db.commit()
    log.warning("platform_owner id=%s added manager id=%s to organization id=%s", owner.id, manager.id, org.id)
    return RedirectResponse("/platform", 303)


@app.post("/platform/venues/{org_id}/enter")
def platform_enter_venue(org_id: int, request: Request, db: Session = Depends(get_db)):
    owner = _platform_owner(request, db)
    org = db.get(Organization, org_id)
    if not org:
        raise HTTPException(404)

    if org.id == owner.organization_id:
        target = owner
    else:
        target = db.scalar(select(User).where(User.organization_id == org.id, User.role == "manager").order_by(User.id.asc()))
        if not target:
            return RedirectResponse("/platform?error=no_manager", 303)

    response = RedirectResponse("/app", 303)
    response.set_cookie("baros_platform_session", make_session(owner.id), httponly=True, samesite="lax", secure=COOKIE_SECURE, max_age=SESSION_MAX_AGE)
    response.set_cookie("baros_session", make_session(target.id), httponly=True, samesite="lax", secure=COOKIE_SECURE, max_age=SESSION_MAX_AGE)
    log.warning("platform_owner id=%s entered organization id=%s as user id=%s", owner.id, org.id, target.id)
    return response


@app.post("/platform/exit")
def platform_exit_venue(request: Request, db: Session = Depends(get_db)):
    session = read_session(request.cookies.get("baros_platform_session", ""))
    if not session:
        raise HTTPException(403)
    owner = db.get(User, session.get("uid"))
    if not owner or owner.role != "platform_owner":
        raise HTTPException(403)
    response = RedirectResponse("/platform", 303)
    response.set_cookie("baros_session", make_session(owner.id), httponly=True, samesite="lax", secure=COOKIE_SECURE, max_age=SESSION_MAX_AGE)
    response.delete_cookie("baros_platform_session")
    return response
