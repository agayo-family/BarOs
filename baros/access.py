from __future__ import annotations

import json
from datetime import datetime
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import AuditLog, ManagerControl, User, VenueControl

DEFAULT_VENUE_PERMISSIONS = {
    "manager_access": True,
    "employee_access": True,
    "employees_manage": True,
    "courses_manage": True,
    "uploads_manage": True,
    "glossary_manage": True,
    "ai_use": True,
    "onboarding_edit": True,
}

DEFAULT_MANAGER_PERMISSIONS = {
    "employees_manage": True,
    "courses_manage": True,
    "uploads_manage": True,
    "glossary_manage": True,
    "ai_use": True,
    "onboarding_edit": True,
}

VENUE_STATUSES = {"active", "read_only", "suspended", "archived"}


def _json_dict(raw: str, defaults: dict[str, bool]) -> dict[str, bool]:
    try:
        data = json.loads(raw or "{}")
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
    result = dict(defaults)
    for key in defaults:
        if key in data:
            result[key] = bool(data[key])
    return result


def venue_control(db: Session, organization_id: int) -> VenueControl:
    rec = db.scalar(select(VenueControl).where(VenueControl.organization_id == organization_id))
    if not rec:
        rec = VenueControl(
            organization_id=organization_id,
            status="active",
            permissions_json=json.dumps(DEFAULT_VENUE_PERMISSIONS),
        )
        db.add(rec)
        db.flush()
    return rec


def manager_control(db: Session, user_id: int) -> ManagerControl:
    rec = db.scalar(select(ManagerControl).where(ManagerControl.user_id == user_id))
    if not rec:
        rec = ManagerControl(
            user_id=user_id,
            permissions_json=json.dumps(DEFAULT_MANAGER_PERMISSIONS),
            blocked=False,
        )
        db.add(rec)
        db.flush()
    return rec


def venue_permissions(control: VenueControl) -> dict[str, bool]:
    return _json_dict(control.permissions_json, DEFAULT_VENUE_PERMISSIONS)


def manager_permissions(control: ManagerControl) -> dict[str, bool]:
    return _json_dict(control.permissions_json, DEFAULT_MANAGER_PERMISSIONS)


def effective_permission(db: Session, user: User, capability: str) -> bool:
    if user.role in {"platform_owner", "platform_shadow"}:
        return True
    if user.role not in {"manager", "manager_pending"}:
        return False

    vc = venue_control(db, user.organization_id)
    mc = manager_control(db, user.id)
    if mc.blocked:
        return False
    vp = venue_permissions(vc)
    mp = manager_permissions(mc)

    if vc.status in {"suspended", "archived"}:
        return False
    if not vp.get("manager_access", True):
        return False
    if vc.status == "read_only":
        return False
    return vp.get(capability, True) and mp.get(capability, True)


def can_manager_view(db: Session, user: User) -> bool:
    if user.role in {"platform_owner", "platform_shadow"}:
        return True
    if user.role not in {"manager", "manager_pending"}:
        return False
    vc = venue_control(db, user.organization_id)
    mc = manager_control(db, user.id)
    return not mc.blocked and vc.status not in {"suspended", "archived"} and venue_permissions(vc).get("manager_access", True)


def can_employee_access(db: Session, organization_id: int) -> bool:
    vc = venue_control(db, organization_id)
    vp = venue_permissions(vc)
    return vc.status not in {"suspended", "archived"} and vp.get("employee_access", True)


def audit(
    db: Session,
    action: str,
    actor_user_id: int | None = None,
    organization_id: int | None = None,
    details: dict | None = None,
    ip: str = "",
) -> None:
    db.add(AuditLog(
        actor_user_id=actor_user_id,
        organization_id=organization_id,
        action=action,
        details_json=json.dumps(details or {}, ensure_ascii=False),
        ip=ip[:100],
        created_at=datetime.utcnow(),
    ))
