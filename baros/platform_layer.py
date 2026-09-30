from __future__ import annotations

import json
import logging
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta
from urllib.parse import urlparse

from fastapi import Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from .access import (
    DEFAULT_MANAGER_PERMISSIONS,
    DEFAULT_VENUE_PERMISSIONS,
    VENUE_STATUSES,
    audit,
    can_employee_access,
    can_manager_view,
    effective_permission,
    manager_control,
    manager_permissions,
    venue_control,
    venue_permissions,
)
from .config import COOKIE_SECURE, PUBLIC_BASE_URL
from .ai_service import get_ai_status
from .core import app, current_user, get_db, render
from .db import SessionLocal
from .models import (
    AIGeneration,
    Attempt,
    AuditLog,
    Course,
    Employee,
    GlossaryTerm,
    Lesson,
    ManagerControl,
    ManagerInvite,
    Organization,
    Question,
    Upload,
    User,
    VenueControl,
)
from .security import hash_password, make_session, read_session

log = logging.getLogger("baros.platform")
SESSION_MAX_AGE = 60 * 60 * 24 * 14
PLATFORM_ORG_LIMIT = 200
SYSTEM_ORG_NAME = "__BAROS_PLATFORM__"
INVITE_HOURS = 72

VENUE_PERMISSION_LABELS = {
    "manager_access": "Доступ управляющих",
    "employee_access": "Обучение сотрудников",
    "employees_manage": "Управление сотрудниками",
    "courses_manage": "Управление курсами",
    "uploads_manage": "Загрузка файлов",
    "glossary_manage": "Словарь терминов",
    "ai_use": "AI-методист",
    "onboarding_edit": "Интервью и настройки",
}
MANAGER_PERMISSION_LABELS = {
    k: v for k, v in VENUE_PERMISSION_LABELS.items()
    if k not in {"manager_access", "employee_access"}
}

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
    response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    return response


def _valid_password(password: str) -> bool:
    return (
        len(password) >= 10
        and bool(re.search(r"[A-Za-zА-Яа-яЁё]", password))
        and bool(re.search(r"\d", password))
    )


def _platform_owner(request: Request, db: Session) -> User:
    user = current_user(request, db)
    if not user:
        raise HTTPException(401)
    if user.role != "platform_owner":
        raise HTTPException(403, "Доступ только владельцу платформы BarOS")
    return user


def _platform_owner_from_shadow(request: Request, db: Session) -> User | None:
    data = read_session(request.cookies.get("baros_platform_session", ""))
    if not data:
        return None
    owner = db.get(User, data.get("uid"))
    if owner and owner.role == "platform_owner":
        return owner
    return None


def _audit_actor(request: Request, db: Session) -> User | None:
    return _platform_owner_from_shadow(request, db) or current_user(request, db)


def _system_org(db: Session) -> Organization:
    org = db.scalar(select(Organization).where(Organization.name == SYSTEM_ORG_NAME))
    if not org:
        org = Organization(name=SYSTEM_ORG_NAME, interview_json="{}")
        db.add(org)
        db.flush()
    return org


def _ensure_platform_state(db: Session) -> User | None:
    owner = db.scalar(select(User).where(User.role == "platform_owner").order_by(User.id.asc()))
    if not owner:
        legacy = db.scalar(select(User).where(User.role == "owner").order_by(User.id.asc()))
        if legacy:
            legacy.role = "platform_owner"
            owner = legacy
    if not owner:
        return None

    sys_org = _system_org(db)
    if owner.organization_id != sys_org.id:
        previous_org = owner.organization_id
        owner.organization_id = sys_org.id
        audit(
            db,
            "platform_owner_moved_to_system_org",
            actor_user_id=owner.id,
            organization_id=previous_org,
            details={"system_org_id": sys_org.id},
        )

    orgs = db.scalars(select(Organization).where(Organization.id != sys_org.id)).all()
    for org in orgs:
        venue_control(db, org.id)
    managers = db.scalars(select(User).where(User.role.in_(["manager", "manager_pending"]))).all()
    for manager in managers:
        manager_control(db, manager.id)
    db.commit()
    return owner


def _management_capability(method: str, path: str) -> str | None:
    if method not in {"POST", "PUT", "PATCH", "DELETE"}:
        return None
    if path == "/onboarding":
        return "onboarding_edit"
    if path == "/uploads" or re.fullmatch(r"/uploads/\d+/delete", path):
        return "uploads_manage"
    if path == "/glossary" or re.fullmatch(r"/glossary/\d+/delete", path):
        return "glossary_manage"
    if path.startswith("/ai/"):
        return "ai_use"
    if path == "/employees" or re.fullmatch(r"/employees/\d+/delete", path):
        return "employees_manage"
    if path == "/courses" or re.fullmatch(r"/courses/\d+(/.*)?", path):
        return "courses_manage"
    return None


def _is_management_path(path: str) -> bool:
    return (
        path == "/app"
        or path == "/onboarding"
        or path.startswith("/courses")
        or path.startswith("/uploads")
        or path.startswith("/glossary")
        or path.startswith("/ai/")
        or path.startswith("/employees")
    )


def _invite_url(token: str) -> str:
    base = PUBLIC_BASE_URL or "https://baros-staging.onrender.com"
    return f"{base}/invite/manager/{token}"


def _new_manager_invite(
    db: Session,
    org: Organization,
    name: str,
    email: str,
    owner: User,
    request: Request,
) -> tuple[User, ManagerInvite]:
    email = email.lower().strip()
    name = name.strip()
    if not name or not email:
        raise HTTPException(400, "Имя и email управляющего обязательны")
    if db.scalar(select(User).where(User.email == email)):
        raise ValueError("email")

    pending = User(
        organization_id=org.id,
        email=email,
        password_hash=hash_password(secrets.token_urlsafe(48)),
        name=name,
        role="manager_pending",
    )
    db.add(pending)
    db.flush()
    manager_control(db, pending.id)

    invite = ManagerInvite(
        organization_id=org.id,
        user_id=pending.id,
        token=secrets.token_urlsafe(32),
        expires_at=datetime.utcnow() + timedelta(hours=INVITE_HOURS),
        created_by_user_id=owner.id,
    )
    db.add(invite)
    audit(
        db,
        "manager_invite_created",
        actor_user_id=owner.id,
        organization_id=org.id,
        details={"manager_user_id": pending.id, "email": email},
        ip=_client_ip(request),
    )
    return pending, invite


def _shadow_user(db: Session, org: Organization) -> User:
    email = f"__platform_shadow_{org.id}@baros.internal"
    user = db.scalar(select(User).where(User.email == email))
    if not user:
        user = User(
            organization_id=org.id,
            email=email,
            password_hash=hash_password(secrets.token_urlsafe(48)),
            name="BarOS Platform",
            role="platform_shadow",
        )
        db.add(user)
        db.flush()
    return user


@app.on_event("startup")
def platform_startup():
    ai_status = get_ai_status()
    log.warning("AI methodologist configured=%s provider=%s model=%s mode=%s", ai_status["configured"], ai_status["provider"], ai_status["model"], ai_status["mode"])
    with SessionLocal() as db:
        _ensure_platform_state(db)


@app.middleware("http")
async def baros_security_and_platform_middleware(request: Request, call_next):
    path = request.url.path
    method = request.method.upper()
    ip = _client_ip(request)

    if method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("origin")
        if origin:
            parsed = urlparse(origin)
            host = request.headers.get("host", "")
            if parsed.netloc and parsed.netloc != host:
                return _secure_response(HTMLResponse("Запрос отклонён защитой BarOS.", status_code=403))

    if method == "POST" and path == "/login" and _is_rate_limited(f"login:{ip}", 20, 15 * 60):
        return _secure_response(HTMLResponse("Слишком много попыток входа. Попробуйте позже.", status_code=429))
    if method == "POST" and path.startswith("/platform/") and _is_rate_limited(f"platform-write:{ip}", 80, 60 * 60):
        return _secure_response(HTMLResponse("Слишком много административных действий. Попробуйте позже.", status_code=429))
    if method == "POST" and path == "/uploads" and _is_rate_limited(f"uploads:{ip}", 60, 60 * 60):
        return _secure_response(HTMLResponse("Лимит загрузок на час исчерпан.", status_code=429))
    if method == "POST" and path == "/ai/training-draft" and _is_rate_limited(f"ai:{ip}", 20, 60 * 60):
        return _secure_response(HTMLResponse("Лимит AI-генераций на час исчерпан.", status_code=429))

    platform_session = bool(request.cookies.get("baros_platform_session"))

    if path.startswith("/employee/") and not platform_session:
        match = re.match(r"^/employee/([^/]+)", path)
        if match:
            with SessionLocal() as db:
                employee = db.scalar(select(Employee).where(Employee.invite_token == match.group(1)))
                if employee and not can_employee_access(db, employee.organization_id):
                    return _secure_response(render(request, "restricted.html", {
                        "title": "Обучение временно недоступно",
                        "message": "Доступ сотрудников к BarOS для этого заведения временно ограничен.",
                        "user": None,
                    }, status=403))

    if path == "/app" and method == "GET" and not platform_session:
        session = read_session(request.cookies.get("baros_session", ""))
        if session:
            with SessionLocal() as db:
                user = db.get(User, session.get("uid"))
                if user and user.role == "platform_owner":
                    return _secure_response(RedirectResponse("/platform", 302))

    if _is_management_path(path) and not platform_session:
        session = read_session(request.cookies.get("baros_session", ""))
        if session:
            with SessionLocal() as db:
                user = db.get(User, session.get("uid"))
                if user and user.role in {"manager", "manager_pending"}:
                    vc = venue_control(db, user.organization_id)
                    request.scope["baros_venue_status"] = vc.status
                    request.scope["baros_venue_note"] = vc.note or ""
                    if not can_manager_view(db, user):
                        return _secure_response(RedirectResponse("/restricted", 303))
                    capability = _management_capability(method, path)
                    if capability and not effective_permission(db, user, capability):
                        return _secure_response(RedirectResponse(f"/restricted?cap={capability}", 303))

    response = await call_next(request)

    if method in {"POST", "PUT", "PATCH", "DELETE"} and response.status_code < 400 and _is_management_path(path) and not path.startswith("/platform/"):
        try:
            with SessionLocal() as db:
                actor = _audit_actor(request, db)
                if actor:
                    audit(
                        db,
                        "manager_write",
                        actor_user_id=actor.id,
                        organization_id=actor.organization_id,
                        details={"method": method, "path": path, "status": response.status_code},
                        ip=ip,
                    )
                    db.commit()
        except Exception:
            log.exception("Failed to write generic management audit event")

    if method == "POST" and path == "/logout":
        response.delete_cookie("baros_platform_session")
    return _secure_response(response)


@app.get("/health/platform")
def platform_health():
    return {"status": "ok", "layer": "platform", "version": "major-platform-ux"}

@app.get("/health/ai")
def ai_health():
    status = get_ai_status()
    return {
        "status": "configured" if status["configured"] else "not_configured",
        **status,
    }


@app.get("/favicon.ico")
def favicon():
    return RedirectResponse("/static/baros-icon-192.png", status_code=302)


@app.get("/robots.txt")
def robots():
    return PlainTextResponse("User-agent: *\nDisallow: /\n", media_type="text/plain")


@app.get("/manifest.webmanifest")
def web_manifest():
    return JSONResponse({
        "name": "BarOS",
        "short_name": "BarOS",
        "description": "Обучение, аттестация и готовность персонала HoReCa к смене.",
        "start_url": "/",
        "display": "standalone",
        "background_color": "#0b0d10",
        "theme_color": "#d9ff4f",
        "icons": [
            {"src": "/static/baros-icon-192.png?v=2", "sizes": "192x192", "type": "image/png", "purpose": "any maskable"},
            {"src": "/static/baros-icon.svg?v=2", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable"},
        ],
    }, media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    js = """
const CACHE='baros-static-v2';
const ASSETS=['/static/app.css','/static/app.js','/static/baros-icon-32.png?v=2','/static/baros-icon-180.png?v=2','/static/baros-icon-192.png?v=2','/static/baros-icon.svg?v=2'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method==='GET' && u.origin===location.origin && u.pathname.startsWith('/static/')){
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
  }
});
"""
    response = PlainTextResponse(js, media_type="application/javascript")
    response.headers["Service-Worker-Allowed"] = "/"
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/restricted", response_class=HTMLResponse)
def restricted(request: Request, cap: str = "", db: Session = Depends(get_db)):
    user = current_user(request, db)
    if not user:
        return RedirectResponse("/", 302)
    control = venue_control(db, user.organization_id)
    cap_label = MANAGER_PERMISSION_LABELS.get(cap, "")
    if control.status == "read_only":
        message = "Заведение работает в режиме только для чтения. Данные доступны, изменения временно отключены."
    elif control.status == "suspended":
        message = "Работа заведения в BarOS временно приостановлена владельцем платформы."
    elif control.status == "archived":
        message = "Заведение находится в архиве."
    elif cap_label:
        message = f"У вашего аккаунта или заведения отключена возможность: {cap_label}."
    else:
        message = "Доступ к этому разделу временно ограничен владельцем BarOS."
    if control.note:
        message += f" Комментарий: {control.note}"
    return render(request, "restricted.html", {
        "user": user,
        "title": "Доступ ограничен",
        "message": message,
    }, status=403)


@app.get("/platform", response_class=HTMLResponse)
def platform_dashboard(request: Request, db: Session = Depends(get_db)):
    owner = _platform_owner(request, db)
    _ensure_platform_state(db)
    sys_org = _system_org(db)
    organizations = db.scalars(
        select(Organization)
        .where(Organization.id != sys_org.id)
        .order_by(Organization.created_at.desc())
    ).all()

    rows = []
    for org in organizations:
        vc = venue_control(db, org.id)
        managers = db.scalars(
            select(User)
            .where(User.organization_id == org.id, User.role.in_(["manager", "manager_pending"]))
            .order_by(User.id.asc())
        ).all()
        manager_rows = []
        for manager in managers:
            mc = manager_control(db, manager.id)
            active_invite = db.scalar(
                select(ManagerInvite)
                .where(
                    ManagerInvite.user_id == manager.id,
                    ManagerInvite.used_at.is_(None),
                    ManagerInvite.expires_at > datetime.utcnow(),
                )
                .order_by(ManagerInvite.created_at.desc())
            )
            manager_rows.append({
                "user": manager,
                "control": mc,
                "permissions": manager_permissions(mc),
                "invite_url": _invite_url(active_invite.token) if active_invite else None,
            })

        rows.append({
            "org": org,
            "control": vc,
            "permissions": venue_permissions(vc),
            "managers": manager_rows,
            "employees": db.scalar(select(func.count(Employee.id)).where(Employee.organization_id == org.id)) or 0,
            "courses": db.scalar(select(func.count(Course.id)).where(Course.organization_id == org.id)) or 0,
            "uploads": db.scalar(select(func.count(Upload.id)).where(Upload.organization_id == org.id)) or 0,
            "interview_done": bool((org.interview_json or "{}").strip() not in {"", "{}"}),
        })

    logs = db.scalars(select(AuditLog).order_by(AuditLog.created_at.desc()).limit(30)).all()
    return render(request, "platform.html", {
        "user": owner,
        "venues": rows,
        "logs": logs,
        "org_limit": PLATFORM_ORG_LIMIT,
        "error": request.query_params.get("error"),
        "created": request.query_params.get("created"),
        "venue_permission_labels": VENUE_PERMISSION_LABELS,
        "manager_permission_labels": MANAGER_PERMISSION_LABELS,
    })


@app.post("/platform/venues")
def platform_create_venue(
    request: Request,
    venue: str = Form(...),
    manager_name: str = Form(...),
    manager_email: str = Form(...),
    db: Session = Depends(get_db),
):
    owner = _platform_owner(request, db)
    sys_org = _system_org(db)
    count = db.scalar(select(func.count(Organization.id)).where(Organization.id != sys_org.id)) or 0
    if count >= PLATFORM_ORG_LIMIT:
        raise HTTPException(409, "Достигнут защитный лимит количества заведений")

    venue = venue.strip()
    if not venue:
        raise HTTPException(400, "Название заведения обязательно")
    if db.scalar(select(User).where(User.email == manager_email.lower().strip())):
        return RedirectResponse("/platform?error=email", 303)

    org = Organization(name=venue)
    db.add(org)
    db.flush()
    venue_control(db, org.id)
    try:
        _, invite = _new_manager_invite(db, org, manager_name, manager_email, owner, request)
    except ValueError:
        db.rollback()
        return RedirectResponse("/platform?error=email", 303)

    audit(
        db,
        "venue_created",
        actor_user_id=owner.id,
        organization_id=org.id,
        details={"name": org.name, "invite": _invite_url(invite.token)},
        ip=_client_ip(request),
    )
    db.commit()
    return RedirectResponse("/platform?created=1", 303)


@app.post("/platform/venues/{org_id}/managers/invite")
def platform_add_manager_invite(
    org_id: int,
    request: Request,
    manager_name: str = Form(...),
    manager_email: str = Form(...),
    db: Session = Depends(get_db),
):
    owner = _platform_owner(request, db)
    org = db.get(Organization, org_id)
    if not org or org.name == SYSTEM_ORG_NAME:
        raise HTTPException(404)
    try:
        _new_manager_invite(db, org, manager_name, manager_email, owner, request)
    except ValueError:
        db.rollback()
        return RedirectResponse("/platform?error=email", 303)
    db.commit()
    return RedirectResponse("/platform", 303)


@app.get("/invite/manager/{token}", response_class=HTMLResponse)
def manager_invite(token: str, request: Request, db: Session = Depends(get_db)):
    invite = db.scalar(select(ManagerInvite).where(ManagerInvite.token == token))
    if not invite or invite.used_at or invite.expires_at <= datetime.utcnow():
        return render(request, "manager_invite.html", {
            "user": None, "invalid": True, "invite": None, "manager": None, "org": None,
        }, status=410)
    manager = db.get(User, invite.user_id)
    org = db.get(Organization, invite.organization_id)
    return render(request, "manager_invite.html", {
        "user": None, "invalid": False, "invite": invite, "manager": manager, "org": org,
    })


@app.post("/invite/manager/{token}")
def manager_invite_accept(
    token: str,
    request: Request,
    password: str = Form(...),
    db: Session = Depends(get_db),
):
    if _is_rate_limited(f"invite:{_client_ip(request)}", 20, 60 * 60):
        raise HTTPException(429)
    invite = db.scalar(select(ManagerInvite).where(ManagerInvite.token == token))
    if not invite or invite.used_at or invite.expires_at <= datetime.utcnow():
        raise HTTPException(410, "Приглашение истекло")
    if not _valid_password(password):
        return RedirectResponse(f"/invite/manager/{token}?error=password", 303)
    manager = db.get(User, invite.user_id)
    if not manager:
        raise HTTPException(410)
    manager.password_hash = hash_password(password)
    manager.role = "manager"
    invite.used_at = datetime.utcnow()
    audit(
        db,
        "manager_invite_accepted",
        actor_user_id=manager.id,
        organization_id=manager.organization_id,
        details={"email": manager.email},
        ip=_client_ip(request),
    )
    db.commit()
    response = RedirectResponse("/app", 303)
    response.set_cookie(
        "baros_session",
        make_session(manager.id),
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
        max_age=SESSION_MAX_AGE,
    )
    return response


@app.post("/platform/venues/{org_id}/control")
async def platform_update_venue_control(org_id: int, request: Request, db: Session = Depends(get_db)):
    owner = _platform_owner(request, db)
    org = db.get(Organization, org_id)
    if not org or org.name == SYSTEM_ORG_NAME:
        raise HTTPException(404)
    form = await request.form()
    status = str(form.get("status", "active"))
    if status not in VENUE_STATUSES:
        raise HTTPException(400)
    permissions = {key: form.get(f"perm_{key}") == "1" for key in DEFAULT_VENUE_PERMISSIONS}
    control = venue_control(db, org.id)
    control.status = status
    control.permissions_json = json.dumps(permissions)
    control.note = str(form.get("note", "")).strip()
    audit(
        db,
        "venue_control_updated",
        actor_user_id=owner.id,
        organization_id=org.id,
        details={"status": status, "permissions": permissions, "note": control.note},
        ip=_client_ip(request),
    )
    db.commit()
    return RedirectResponse("/platform", 303)


@app.post("/platform/managers/{user_id}/control")
async def platform_update_manager_control(user_id: int, request: Request, db: Session = Depends(get_db)):
    owner = _platform_owner(request, db)
    manager = db.get(User, user_id)
    if not manager or manager.role not in {"manager", "manager_pending"}:
        raise HTTPException(404)
    form = await request.form()
    permissions = {key: form.get(f"perm_{key}") == "1" for key in DEFAULT_MANAGER_PERMISSIONS}
    control = manager_control(db, manager.id)
    control.permissions_json = json.dumps(permissions)
    control.blocked = form.get("blocked") == "1"
    control.note = str(form.get("note", "")).strip()
    audit(
        db,
        "manager_control_updated",
        actor_user_id=owner.id,
        organization_id=manager.organization_id,
        details={
            "manager_user_id": manager.id,
            "blocked": control.blocked,
            "permissions": permissions,
            "note": control.note,
        },
        ip=_client_ip(request),
    )
    db.commit()
    return RedirectResponse("/platform", 303)


@app.post("/platform/venues/{org_id}/enter")
def platform_enter_venue(org_id: int, request: Request, db: Session = Depends(get_db)):
    owner = _platform_owner(request, db)
    org = db.get(Organization, org_id)
    if not org or org.name == SYSTEM_ORG_NAME:
        raise HTTPException(404)

    target = db.scalar(
        select(User)
        .where(User.organization_id == org.id, User.role.in_(["manager", "manager_pending"]))
        .order_by(User.id.asc())
    )
    if not target:
        target = _shadow_user(db, org)

    audit(
        db,
        "platform_owner_entered_venue",
        actor_user_id=owner.id,
        organization_id=org.id,
        details={"as_user_id": target.id},
        ip=_client_ip(request),
    )
    db.commit()
    response = RedirectResponse("/app", 303)
    response.set_cookie(
        "baros_platform_session",
        make_session(owner.id),
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
        max_age=SESSION_MAX_AGE,
    )
    response.set_cookie(
        "baros_session",
        make_session(target.id),
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
        max_age=SESSION_MAX_AGE,
    )
    return response


@app.post("/platform/exit")
def platform_exit_venue(request: Request, db: Session = Depends(get_db)):
    owner = _platform_owner_from_shadow(request, db)
    if not owner:
        raise HTTPException(403)
    audit(
        db,
        "platform_owner_exited_venue",
        actor_user_id=owner.id,
        ip=_client_ip(request),
    )
    db.commit()
    response = RedirectResponse("/platform", 303)
    response.set_cookie(
        "baros_session",
        make_session(owner.id),
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
        max_age=SESSION_MAX_AGE,
    )
    response.delete_cookie("baros_platform_session")
    return response


@app.post("/platform/venues/{org_id}/delete")
def platform_delete_venue(
    org_id: int,
    request: Request,
    confirm_name: str = Form(...),
    db: Session = Depends(get_db),
):
    owner = _platform_owner(request, db)
    org = db.get(Organization, org_id)
    if not org or org.name == SYSTEM_ORG_NAME:
        raise HTTPException(404)
    if confirm_name.strip() != org.name:
        return RedirectResponse("/platform?error=confirm_delete", 303)

    employee_ids = list(db.scalars(select(Employee.id).where(Employee.organization_id == org.id)).all())
    course_ids = list(db.scalars(select(Course.id).where(Course.organization_id == org.id)).all())
    user_ids = list(db.scalars(select(User.id).where(User.organization_id == org.id)).all())

    audit(
        db,
        "venue_hard_delete",
        actor_user_id=owner.id,
        organization_id=org.id,
        details={
            "name": org.name,
            "employees": len(employee_ids),
            "courses": len(course_ids),
            "users": len(user_ids),
        },
        ip=_client_ip(request),
    )
    db.flush()

    if employee_ids or course_ids:
        conditions = []
        if employee_ids:
            conditions.append(Attempt.employee_id.in_(employee_ids))
        if course_ids:
            conditions.append(Attempt.course_id.in_(course_ids))
        db.execute(delete(Attempt).where(or_(*conditions)))
    if course_ids:
        db.execute(delete(Lesson).where(Lesson.course_id.in_(course_ids)))
        db.execute(delete(Question).where(Question.course_id.in_(course_ids)))
    db.execute(delete(AIGeneration).where(AIGeneration.organization_id == org.id))
    db.execute(delete(GlossaryTerm).where(GlossaryTerm.organization_id == org.id))
    db.execute(delete(Upload).where(Upload.organization_id == org.id))
    db.execute(delete(ManagerInvite).where(ManagerInvite.organization_id == org.id))
    if user_ids:
        db.execute(delete(ManagerControl).where(ManagerControl.user_id.in_(user_ids)))
    db.execute(delete(VenueControl).where(VenueControl.organization_id == org.id))
    db.execute(delete(Employee).where(Employee.organization_id == org.id))
    db.execute(delete(Course).where(Course.organization_id == org.id))
    db.execute(delete(User).where(User.organization_id == org.id))
    db.execute(delete(Organization).where(Organization.id == org.id))
    db.commit()
    return RedirectResponse("/platform", 303)


@app.post("/employees/{employee_id}/delete")
def delete_employee(employee_id: int, request: Request, db: Session = Depends(get_db)):
    user = current_user(request, db)
    if not user:
        raise HTTPException(401)
    employee = db.get(Employee, employee_id)
    if not employee or employee.organization_id != user.organization_id:
        raise HTTPException(404)
    db.execute(delete(Attempt).where(Attempt.employee_id == employee.id))
    db.delete(employee)
    actor = _audit_actor(request, db)
    audit(
        db,
        "employee_deleted",
        actor_user_id=actor.id if actor else None,
        organization_id=user.organization_id,
        details={"employee_id": employee_id, "name": employee.name},
        ip=_client_ip(request),
    )
    db.commit()
    return RedirectResponse("/app#employees", 303)


@app.post("/courses/{course_id}/delete")
def delete_course(course_id: int, request: Request, db: Session = Depends(get_db)):
    user = current_user(request, db)
    if not user:
        raise HTTPException(401)
    course = db.get(Course, course_id)
    if not course or course.organization_id != user.organization_id:
        raise HTTPException(404)
    db.execute(delete(Attempt).where(Attempt.course_id == course.id))
    db.execute(delete(Lesson).where(Lesson.course_id == course.id))
    db.execute(delete(Question).where(Question.course_id == course.id))
    db.delete(course)
    actor = _audit_actor(request, db)
    audit(
        db,
        "course_deleted",
        actor_user_id=actor.id if actor else None,
        organization_id=user.organization_id,
        details={"course_id": course_id, "title": course.title},
        ip=_client_ip(request),
    )
    db.commit()
    return RedirectResponse("/app#courses", 303)


@app.post("/platform/managers/{user_id}/delete")
def platform_delete_manager(user_id: int, request: Request, db: Session = Depends(get_db)):
    owner = _platform_owner(request, db)
    manager = db.get(User, user_id)
    if not manager or manager.role not in {"manager", "manager_pending"}:
        raise HTTPException(404)
    org_id = manager.organization_id
    email = manager.email
    db.execute(delete(ManagerInvite).where(ManagerInvite.user_id == manager.id))
    db.execute(delete(ManagerControl).where(ManagerControl.user_id == manager.id))
    db.delete(manager)
    audit(
        db,
        "manager_deleted",
        actor_user_id=owner.id,
        organization_id=org_id,
        details={"manager_user_id": user_id, "email": email},
        ip=_client_ip(request),
    )
    db.commit()
    return RedirectResponse("/platform", 303)


@app.post("/uploads/{upload_id}/delete")
def delete_upload(upload_id: int, request: Request, db: Session = Depends(get_db)):
    user = current_user(request, db)
    if not user:
        raise HTTPException(401)
    rec = db.get(Upload, upload_id)
    if not rec or rec.organization_id != user.organization_id:
        raise HTTPException(404)
    actor = _audit_actor(request, db)
    filename = rec.filename
    db.delete(rec)
    audit(
        db,
        "upload_deleted",
        actor_user_id=actor.id if actor else None,
        organization_id=user.organization_id,
        details={"upload_id": upload_id, "filename": filename},
        ip=_client_ip(request),
    )
    db.commit()
    return RedirectResponse("/app#files", 303)


@app.post("/glossary/{term_id}/delete")
def delete_glossary_term(term_id: int, request: Request, db: Session = Depends(get_db)):
    user = current_user(request, db)
    if not user:
        raise HTTPException(401)
    term = db.get(GlossaryTerm, term_id)
    if not term or term.organization_id != user.organization_id:
        raise HTTPException(404)
    actor = _audit_actor(request, db)
    term_text = term.term
    db.delete(term)
    audit(
        db,
        "glossary_term_deleted",
        actor_user_id=actor.id if actor else None,
        organization_id=user.organization_id,
        details={"term_id": term_id, "term": term_text},
        ip=_client_ip(request),
    )
    db.commit()
    return RedirectResponse("/app#glossary", 303)
