import os
import secrets
from datetime import timedelta
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select, delete, update
from sqlalchemy.exc import IntegrityError
from ..db import get_db
from ..config import COOKIE_SECURE
from .models import Account, LoginSession, RateBucket
from .domain import now, digest, settings, parse, require

SESSION_DAYS = 14
COOKIE = 'baros_v2_session'


def make_session(db, response, account):
    raw = secrets.token_urlsafe(40)
    csrf = secrets.token_urlsafe(32)
    db.add(LoginSession(token_hash=digest(raw), account_id=account.id, csrf=csrf, expires_at=now()+timedelta(days=SESSION_DAYS)))
    db.commit()
    response.set_cookie(COOKIE, raw, httponly=True, secure=COOKIE_SECURE, samesite='lax', max_age=SESSION_DAYS*86400, path='/')
    return csrf


def actor(request: Request, db=Depends(get_db)):
    token = request.cookies.get(COOKIE, '')
    s = db.get(LoginSession, digest(token)) if token else None
    require(s and s.expires_at > now(), 'Войдите в аккаунт', 401)
    account = db.get(Account, s.account_id)
    require(account and account.active, 'Доступ к аккаунту отключён', 403)
    if request.method not in {'GET', 'HEAD', 'OPTIONS'}:
        require(secrets.compare_digest(request.headers.get('x-csrf-token', ''), s.csrf), 'Обновите страницу и повторите действие', 403)
    request.state.csrf = s.csrf
    if not account.last_seen_at or (now()-account.last_seen_at).total_seconds() > 60:
        account.last_seen_at = now(); db.commit()
    return account


def owner(account):
    require(account.role == 'owner', 'Только для владельца BarOS', 403)


def tenant(request, db, account, capability=None, write=False, learning=False):
    if account.role == 'owner':
        raw = request.headers.get('x-organization-id', '')
        try: org_id = int(raw)
        except ValueError: raise HTTPException(400, 'Сначала выберите заведение')
        s = db.get(__import__('baros.v2.models', fromlist=['VenueSettings']).VenueSettings, org_id)
        require(s, 'Заведение не найдено', 404)
        return org_id
    org_id = account.organization_id
    require(org_id, 'Аккаунт не привязан к заведению', 403)
    if request.headers.get('x-organization-id'):
        require(request.headers['x-organization-id'] == str(org_id), 'Нет доступа к этому заведению', 403)
    s = settings(db, org_id)
    perms = parse(s.permissions_json)
    require(s.status not in {'suspended', 'archived'}, 'Доступ к заведению приостановлен. Обратитесь к владельцу BarOS.', 403)
    require(perms.get('employee_access' if learning else 'manager_access', True), 'Доступ временно ограничен владельцем', 403)
    if learning or write:
        require(s.subscription_status not in {'past_due', 'suspended'} and (not s.paid_until or s.paid_until > now()), 'Подписка закончилась. Продлите доступ у владельца BarOS.', 402)
    if capability:
        require(account.role == 'manager', 'Это действие доступно управляющему', 403)
        require(s.status != 'read_only' and perms.get(capability, True) and parse(account.permissions_json).get(capability, True), 'Это действие ограничено владельцем BarOS', 403)
    return org_id


def manager(request, db, account, capability=None, write=False):
    require(account.role in {'owner', 'manager'}, 'Только для управляющего', 403)
    return tenant(request, db, account, capability, write)


def rate(db, key, limit=12, seconds=900):
    """Persistent atomic counters; shared by all server workers."""
    k = digest(key)
    row = db.get(RateBucket, k)
    if not row:
        try:
            with db.begin_nested():
                db.add(RateBucket(key=k, count=0, expires_at=now()+timedelta(seconds=seconds))); db.flush()
        except IntegrityError: pass
    db.execute(update(RateBucket).where(RateBucket.key == k, RateBucket.expires_at <= now()).values(count=0, expires_at=now()+timedelta(seconds=seconds)))
    changed = db.execute(update(RateBucket).where(RateBucket.key == k, RateBucket.count < limit).values(count=RateBucket.count+1))
    db.commit()
    require(changed.rowcount == 1, 'Слишком много попыток. Попробуйте позже.', 429)


def ip(request):
    # Render sanitizes its proxy chain; never trust the client-supplied leftmost address.
    return request.client.host if request.client else 'unknown'
