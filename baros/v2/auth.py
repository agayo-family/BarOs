import os
import secrets
from datetime import timedelta
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select, delete, update
from sqlalchemy.exc import IntegrityError
from ..db import get_db
from ..config import COOKIE_SECURE
from .models import Account, LoginSession, RateBucket, VenueMembership, VenueSettings, GroupMembership, GroupVenue
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
    require(account.role == 'owner', 'Только для администратора платформы', 403)


SENSITIVE_PERMISSIONS = {'shifts_manage', 'uploads_manage', 'exports_access', 'ai_use'}


def venue_membership(db, account, oid, lock=False):
    query = select(VenueMembership).where(VenueMembership.account_id == account.id,
                                          VenueMembership.organization_id == oid)
    row = db.scalar(query.with_for_update(read=True) if lock else query)
    if row is None:
        require(oid == account.organization_id, 'Нет доступа к этому заведению', 403)
    else:
        require(row.active, 'Нет доступа к этому заведению', 403)
        if row.group_id is not None:
            link = db.get(GroupVenue, oid)
            require(link and link.group_id == row.group_id and
                    db.get(GroupMembership, (row.group_id, account.id)),
                    'Нет доступа к этому заведению', 403)
    return row


def selected_venue(request, db, account, lock=False, media_venue=None):
    raw = request.headers.get('x-organization-id')
    if raw is None and account.role == 'manager' and media_venue is not None:
        raw = str(media_venue)
    if raw is not None:
        valid = raw.isascii() and raw.isdecimal() and len(raw) <= 10
        require(valid and 0 < int(raw) <= 2147483647 and raw == str(int(raw)),
                'Нет доступа к этому заведению', 400 if account.role == 'owner' else 403)
        oid = int(raw)
    else:
        oid = account.organization_id
    require(oid, 'Сначала выберите заведение', 400 if account.role == 'owner' else 403)
    if account.role == 'owner':
        require(db.get(VenueSettings, oid), 'Заведение не найдено', 404)
        return oid, None
    if account.role == 'manager':
        return oid, venue_membership(db, account, oid, lock)
    require(oid == account.organization_id, 'Нет доступа к этому заведению', 403)
    return oid, None


def venue_permissions(db, account, oid, keys, membership=None):
    if account.role == 'owner':
        return dict.fromkeys(keys, True)
    if membership is None and account.role == 'manager':
        membership = venue_membership(db, account, oid)
    extra = oid != account.organization_id or bool(membership and membership.group_id)
    point = parse(settings(db, oid).permissions_json)
    person = parse(account.permissions_json)
    grant = parse(membership.permissions_json) if membership else {}
    return {key: bool(point.get(key, True) and person.get(key, True) and
                      grant.get(key, not extra or key not in SENSITIVE_PERMISSIONS)) for key in keys}


def check_venue_permission(db, account, oid, key, membership=None):
    require(venue_permissions(db, account, oid, [key], membership)[key],
            'Это действие ограничено. Обратитесь в поддержку.', 403)


def tenant(request, db, account, capability=None, write=False, learning=False, media_venue=None):
    oid, membership = selected_venue(request, db, account, lock=write, media_venue=media_venue)
    if account.role == 'owner':
        return oid
    cfg = settings(db, oid)
    perms = parse(cfg.permissions_json)
    require(cfg.status not in {'suspended', 'archived'}, 'Доступ к заведению приостановлен. Обратитесь в поддержку.', 403)
    require(perms.get('employee_access' if learning else 'manager_access', True),
            'Доступ временно ограничен. Обратитесь в поддержку.', 403)
    if learning or write:
        require(cfg.subscription_status not in {'past_due', 'suspended'} and
                (not cfg.paid_until or cfg.paid_until > now()),
                'Подписка закончилась. Обратитесь в поддержку для продления.', 402)
    if write and account.role == 'manager':
        require(cfg.status != 'read_only', 'Заведение доступно только для чтения', 403)
    if capability:
        require(account.role == 'manager', 'Это действие доступно управляющему', 403)
        check_venue_permission(db, account, oid, capability, membership)
    return oid


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
