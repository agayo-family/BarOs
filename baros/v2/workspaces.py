"""Scoped venue access, aggregate learning metrics and shared standard versions."""
import re
import secrets
from collections import defaultdict
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import Field, StrictBool, StrictInt
from sqlalchemy import func, select, text, update
from sqlalchemy.orm import defer

from ..db import get_db
from ..models import Course, Organization
from .auth import SENSITIVE_PERMISSIONS, actor, check_venue_permission, owner
from .domain import POSITIONS, PERMISSIONS, dump, iso, learner_stats_many, log, now, parse, positions, require
from .models import (Account, BusinessGroup, CourseMedia, Exam, GroupDistribution, GroupMembership,
                     GroupStandard, GroupVenue, ImportedAssessment, SourceFile, VenueMembership,
                     VenueSettings, WrittenAttempt)
from .schemas import CourseIn, StrictModel

router = APIRouter()
MEDIA = re.compile(r'/api/media/([A-Za-z0-9_-]{20,80})')
GROUP_EDITOR_ROLES = {'lead', 'methodist'}


def migrate_memberships(db):
    db.execute(text("""
        INSERT INTO v2_venue_memberships (account_id, organization_id, active, permissions_json)
        SELECT id, organization_id, true, '{}' FROM v2_accounts
        WHERE role = 'manager' AND organization_id IS NOT NULL
        ON CONFLICT (account_id, organization_id) DO NOTHING
    """))


def available(cfg):
    return cfg.status not in {'suspended', 'archived'} and parse(cfg.permissions_json).get('manager_access', True)


def writable(cfg):
    return (available(cfg) and cfg.status != 'read_only' and cfg.subscription_status not in {'past_due', 'suspended'}
            and (not cfg.paid_until or cfg.paid_until > now()))


def manager_venue_ids(db, account):
    if account.role != 'manager':
        return set()
    rows = db.scalars(select(VenueMembership).where(VenueMembership.account_id == account.id)).all()
    group_links = dict(db.execute(select(GroupVenue.organization_id, GroupVenue.group_id).join(
        GroupMembership, GroupMembership.group_id == GroupVenue.group_id
    ).where(GroupMembership.account_id == account.id)).all())
    ids = {row.organization_id for row in rows if row.active and
           (row.group_id is None or group_links.get(row.organization_id) == row.group_id)}
    if account.organization_id and all(row.organization_id != account.organization_id for row in rows):
        ids.add(account.organization_id)
    return ids


def venue_rows(db, ids):
    return db.execute(select(Organization, VenueSettings).join(
        VenueSettings, Organization.id == VenueSettings.organization_id
    ).where(Organization.id.in_(ids), Organization.name != '__BAROS_PLATFORM__').order_by(Organization.name, Organization.id)).all()


def manager_workspaces(db, account):
    venues = [{'id': org.id, 'name': org.name, 'status': cfg.status, 'available': available(cfg)}
              for org, cfg in venue_rows(db, manager_venue_ids(db, account))]
    groups = db.execute(select(BusinessGroup, GroupMembership.role).join(
        GroupMembership, GroupMembership.group_id == BusinessGroup.id
    ).where(GroupMembership.account_id == account.id).order_by(BusinessGroup.name, BusinessGroup.id)).all()
    return {'venues': venues, 'groups': [{'id': g.id, 'name': g.name, 'role': role} for g, role in groups]}


def group_scope(db, account, gid, allowed=None, lock=False):
    query = select(BusinessGroup).where(BusinessGroup.id == gid)
    group = db.scalar(query.with_for_update() if lock else query)
    membership = db.get(GroupMembership, (gid, account.id)) if group and account.role == 'manager' else None
    role = 'owner' if account.role == 'owner' else membership.role if membership else None
    require(group and role, 'Группа не найдена', 404)
    require(allowed is None or role in allowed or role == 'owner', 'Недостаточно прав в группе', 403)
    return group, role


def group_venue_ids(db, gid):
    return set(db.scalars(select(GroupVenue.organization_id).where(GroupVenue.group_id == gid)))


def team_ready(result):
    courses = result['courses']
    linked = {course['written_assessment_id'] for course in courses}
    required = [course['learning_complete'] for course in courses if course['required']]
    required.extend(test['passed'] for test in result['assessments'] if test['id'] not in linked)
    return bool(required) and all(required)


@router.get('/api/workspaces/overview')
def overview(days: Literal['7', '30', '90', '365'] = '30', position: str = '',
             group_id: int | None = None, a=Depends(actor), db=Depends(get_db)):
    require(a.role in {'manager', 'owner'}, 'Только для управляющего', 403)
    require(not position or position in POSITIONS, 'Неизвестная должность', 422)
    direct = manager_venue_ids(db, a)
    ids = direct
    if group_id is not None:
        _, role = group_scope(db, a, group_id)
        attached = group_venue_ids(db, group_id)
        ids = attached if role in GROUP_EDITOR_ROLES | {'owner'} else direct & attached
    venues = venue_rows(db, ids)
    available_ids = {org.id for org, cfg in venues if available(cfg)}
    staff = db.scalars(select(Account).where(Account.organization_id.in_(available_ids),
                                             Account.role == 'employee', Account.active.is_(True))).all()
    if position:
        staff = [person for person in staff if position in parse(person.positions_json, [])]
    people = {person.id: person for person in staff}
    by_venue = defaultdict(list)
    for person in staff:
        by_venue[person.organization_id].append(person)
    cutoff = now() - timedelta(days=int(days))
    exams = dict(db.execute(select(Account.organization_id, func.count(Exam.id)).join(
        Account, Account.id == Exam.account_id
    ).where(Exam.account_id.in_(people), Exam.finished_at >= cutoff).group_by(Account.organization_id)).all())
    written = dict(db.execute(select(WrittenAttempt.organization_id, func.count(WrittenAttempt.id)).where(
        WrittenAttempt.account_id.in_(people), WrittenAttempt.organization_id.in_(available_ids),
        WrittenAttempt.graded_at >= cutoff
    ).group_by(WrittenAttempt.organization_id)).all())
    waiting = select(WrittenAttempt).where(WrittenAttempt.organization_id.in_(available_ids),
                                          WrittenAttempt.account_id.in_(people), WrittenAttempt.status == 'submitted')
    pending = dict(db.execute(waiting.with_only_columns(
        WrittenAttempt.organization_id, func.count(WrittenAttempt.id)
    ).group_by(WrittenAttempt.organization_id)).all())
    queue = db.execute(waiting.where(WrittenAttempt.organization_id.in_(direct)).join(
        ImportedAssessment, ImportedAssessment.id == WrittenAttempt.assessment_id
    ).with_only_columns(WrittenAttempt.id, WrittenAttempt.organization_id, WrittenAttempt.account_id,
                        WrittenAttempt.submitted_at, ImportedAssessment.title
    ).order_by(WrittenAttempt.submitted_at, WrittenAttempt.id).limit(100)).all()
    items = []
    for org, cfg in venues:
        team = by_venue[org.id]
        # Course banks can be large; keep only one venue's learning data in memory.
        results = list(learner_stats_many(db, team).values())
        last = max((person.last_seen_at for person in team if person.last_seen_at), default=None)
        items.append({
            'id': org.id, 'name': org.name, 'status': cfg.status, 'available': org.id in available_ids,
            'direct': org.id in direct and org.id in available_ids, 'employees': len(team),
            'ready': sum(team_ready(result) for result in results),
            'assigned': sum(result['learning_total'] for result in results),
            'complete': sum(result['learning_completed'] for result in results),
            'overdue': sum(result['overdue'] for result in results), 'pending_review': pending.get(org.id, 0),
            'attempts': exams.get(org.id, 0) + written.get(org.id, 0), 'last_activity': iso(last),
        })
    totals = {key: sum(item[key] for item in items) for key in
              ('employees', 'ready', 'assigned', 'complete', 'overdue', 'pending_review', 'attempts')}
    return {'venues': items, 'totals': totals, 'queue': [
        {'id': row.id, 'venue_id': row.organization_id, 'name': people[row.account_id].name,
         'title': row.title, 'submitted_at': iso(row.submitted_at)} for row in queue
    ]}


class GroupIn(StrictModel):
    name: str = Field(min_length=2, max_length=160)


class ActiveIn(StrictModel):
    active: StrictBool


class GroupPersonIn(StrictModel):
    login: str = Field(min_length=2, max_length=255)
    role: Literal['lead', 'methodist', 'manager', 'remove']


class GrantIn(ActiveIn):
    login: str = Field(min_length=2, max_length=255)
    permissions: dict[str, StrictBool] = Field(default_factory=dict)


def manager_by_login(db, login, gid=None):
    query = select(Account).where(Account.login == login.lower(), Account.role == 'manager')
    if gid is not None:
        query = query.join(GroupMembership, GroupMembership.account_id == Account.id).where(GroupMembership.group_id == gid)
    person = db.scalar(query)
    require(person, 'Управляющий не найден', 404)
    return person


@router.get('/api/owner/groups')
def groups(a=Depends(actor), db=Depends(get_db)):
    owner(a)
    return [{'id': row.id, 'name': row.name} for row in db.scalars(select(BusinessGroup).order_by(BusinessGroup.name))]


@router.post('/api/owner/groups')
def create_group(data: GroupIn, a=Depends(actor), db=Depends(get_db)):
    owner(a)
    row = BusinessGroup(name=data.name)
    db.add(row)
    db.flush()
    log(db, a, None, 'Создана ресторанная группа', group_id=row.id)
    db.commit()
    return {'id': row.id, 'name': row.name}


def lock_venue(db, oid):
    org = db.scalar(select(Organization).where(Organization.id == oid).with_for_update())
    require(org and org.name != '__BAROS_PLATFORM__' and db.get(VenueSettings, oid), 'Заведение не найдено', 404)
    return org


@router.put('/api/owner/groups/{gid}/venues/{oid}')
def attach(gid: int, oid: int, data: ActiveIn, a=Depends(actor), db=Depends(get_db)):
    owner(a)
    group_scope(db, a, gid, lock=True)
    lock_venue(db, oid)
    row = db.get(GroupVenue, oid)
    require(not row or row.group_id == gid, 'Заведение уже входит в другую группу', 409)
    if data.active and row is None:
        db.add(GroupVenue(group_id=gid, organization_id=oid))
    elif not data.active and row is not None:
        db.execute(update(VenueMembership).where(VenueMembership.group_id == gid,
                                                  VenueMembership.organization_id == oid).values(active=False))
        db.delete(row)
    log(db, a, oid, 'Изменён состав ресторанной группы', group_id=gid, active=data.active)
    db.commit()
    return {'ok': True}


@router.put('/api/owner/groups/{gid}/people')
def group_person(gid: int, data: GroupPersonIn, a=Depends(actor), db=Depends(get_db)):
    owner(a)
    group_scope(db, a, gid, lock=True)
    person = manager_by_login(db, data.login)
    row = db.get(GroupMembership, (gid, person.id))
    if data.role == 'remove':
        db.execute(update(VenueMembership).where(VenueMembership.group_id == gid,
                                                  VenueMembership.account_id == person.id).values(active=False))
        if row is not None:
            db.delete(row)
    elif row is not None:
        row.role = data.role
    else:
        db.add(GroupMembership(group_id=gid, account_id=person.id, role=data.role))
    log(db, a, None, 'Изменена роль в ресторанной группе', group_id=gid, account_id=person.id, role=data.role)
    db.commit()
    return {'ok': True}


def set_grant(db, a, oid, data, gid=None):
    require(set(data.permissions) <= set(PERMISSIONS) | {'exports_access'}, 'Неизвестное разрешение', 422)
    lock_venue(db, oid)
    person = manager_by_login(db, data.login, gid)
    row = db.get(VenueMembership, (person.id, oid))
    if gid is not None:
        require(person.id != a.id and person.organization_id != oid and (row is None or row.group_id == gid),
                'Этот доступ меняет администратор платформы', 403)
        require(not set(data.permissions) & SENSITIVE_PERMISSIONS,
                'Дополнительные права выдаёт администратор платформы', 403)
    if row is None:
        row = VenueMembership(account_id=person.id, organization_id=oid)
        db.add(row)
    row.group_id = gid
    row.active = data.active
    row.permissions_json = dump(data.permissions)
    log(db, a, oid, 'Изменён доступ управляющего к заведению',
        account_id=person.id, active=data.active, group_id=gid, permissions=data.permissions)
    db.commit()
    return {'ok': True}


@router.put('/api/owner/venues/{oid}/access')
def owner_grant(oid: int, data: GrantIn, a=Depends(actor), db=Depends(get_db)):
    owner(a)
    return set_grant(db, a, oid, data)


@router.put('/api/workspaces/groups/{gid}/venues/{oid}/access')
def group_grant(gid: int, oid: int, data: GrantIn, a=Depends(actor), db=Depends(get_db)):
    group_scope(db, a, gid, {'lead'}, lock=True)
    require(oid in group_venue_ids(db, gid), 'Точка не найдена в группе', 404)
    return set_grant(db, a, oid, data, gid)


@router.get('/api/workspaces/groups/{gid}')
def group_detail(gid: int, a=Depends(actor), db=Depends(get_db)):
    group, role = group_scope(db, a, gid)
    ids = group_venue_ids(db, gid)
    if role == 'manager':
        ids &= manager_venue_ids(db, a)
    people = []
    if role in {'owner', 'lead'}:
        people = [{'login': person.login, 'name': person.name, 'role': membership.role}
                  for person, membership in db.execute(select(Account, GroupMembership).join(
                      GroupMembership, GroupMembership.account_id == Account.id
                  ).where(GroupMembership.group_id == gid).order_by(Account.name)).all()]
    standards = db.scalars(select(GroupStandard).options(defer(GroupStandard.payload)).where(
        GroupStandard.group_id == gid).order_by(GroupStandard.version.desc(), GroupStandard.title)).all()
    return {'id': gid, 'name': group.name, 'role': role, 'people': people,
            'venues': [{'id': org.id, 'name': org.name, 'writable': writable(cfg)} for org, cfg in venue_rows(db, ids)],
            'standards': [{'id': row.id, 'key': row.key, 'title': row.title, 'version': row.version} for row in standards]}


class StandardIn(StrictModel):
    course: CourseIn
    key: str | None = Field(default=None, min_length=1, max_length=64)
    expected_version: StrictInt = Field(default=0, ge=0)
    source_venue: StrictInt | None = Field(default=None, gt=0)


class DistributionIn(StrictModel):
    venues: list[StrictInt] = Field(min_length=1, max_length=50)
    positions: list[str] | None = Field(default=None, min_length=1, max_length=16)


@router.post('/api/workspaces/groups/{gid}/standards')
def save_standard(gid: int, data: StandardIn, a=Depends(actor), db=Depends(get_db)):
    group_scope(db, a, gid, GROUP_EDITOR_ROLES, lock=True)
    positions(data.course.positions)
    key = data.key or secrets.token_hex(16)
    latest = db.scalar(select(func.max(GroupStandard.version)).where(
        GroupStandard.group_id == gid, GroupStandard.key == key)) or 0
    require(latest == data.expected_version and (not data.key or latest), 'Стандарт изменился. Обновите страницу.', 409)
    serialized = dump(data.course.model_dump(mode='json'))
    require(len(serialized.encode()) <= 2 * 1024 * 1024, 'Курс превышает 2 МБ', 413)
    refs = set(MEDIA.findall(serialized))
    if refs:
        require(data.source_venue in group_venue_ids(db, gid), 'Выберите точку с исходными фото', 422)
        check_venue_permission(db, a, data.source_venue, 'uploads_manage')
        cfg = db.get(VenueSettings, data.source_venue)
        require(cfg and available(cfg), 'Исходная точка недоступна', 403)
        found = set(db.scalars(select(CourseMedia.id).where(CourseMedia.id.in_(refs),
                                                            CourseMedia.organization_id == data.source_venue)))
        require(refs == found, 'Используйте фото выбранной точки', 422)
    row = GroupStandard(group_id=gid, key=key, title=data.course.title, version=latest + 1, payload=serialized)
    db.add(row)
    db.flush()
    log(db, a, None, 'Сохранена версия стандарта группы', group_id=gid, standard_id=row.id, version=row.version)
    db.commit()
    return {'id': row.id, 'key': key, 'version': row.version}


@router.post('/api/workspaces/groups/{gid}/standards/{sid}/distribute')
def distribute(gid: int, sid: int, data: DistributionIn, a=Depends(actor), db=Depends(get_db)):
    group_scope(db, a, gid, GROUP_EDITOR_ROLES, lock=True)
    standard = db.get(GroupStandard, sid)
    require(standard and standard.group_id == gid, 'Стандарт не найден', 404)
    ids = sorted(set(data.venues))
    attached = group_venue_ids(db, gid)
    require(set(ids) <= attached, 'Выберите точки этой группы', 403)
    from .content import save_course
    original = parse(standard.payload)
    if data.positions is not None:
        original['positions'] = positions(data.positions)
    refs = set(MEDIA.findall(standard.payload))
    assets = {item.id: item for item in db.scalars(select(CourseMedia).where(CourseMedia.id.in_(refs)))}
    require(refs == set(assets) and all(item.organization_id in attached for item in assets.values()),
            'Исходные фото больше недоступны в группе', 409)
    result = []
    for oid in ids:
        cfg = db.scalar(select(VenueSettings).where(VenueSettings.organization_id == oid).with_for_update())
        require(cfg and writable(cfg), 'Одна из выбранных точек сейчас недоступна для записи', 409)
        existing = db.get(GroupDistribution, (sid, oid))
        if existing:
            result.append({'venue_id': oid, 'course_id': existing.course_id, 'existing': True})
            continue
        copied = {}
        needed = sum(asset.size for asset in assets.values() if asset.organization_id != oid)
        if needed:
            used = sum(db.scalar(select(func.coalesce(func.sum(model.size), 0)).where(model.organization_id == oid))
                       for model in (CourseMedia, SourceFile))
            require(used + needed <= cfg.storage_limit_mb * 1024 * 1024, 'Недостаточно места для фото в одной из точек', 409)
        for mid, asset in assets.items():
            if asset.organization_id != oid:
                copied[mid] = secrets.token_urlsafe(24)
                db.add(CourseMedia(id=copied[mid], organization_id=oid, creator_id=a.id,
                                   content=asset.content, mime=asset.mime, size=asset.size))
        body = MEDIA.sub(lambda match: '/api/media/' + copied.get(match[1], match[1]), dump(original))
        course = Course(organization_id=oid, title=standard.title, published=False)
        db.add(course)
        db.flush()
        save_course(db, course, CourseIn.model_validate_json(body))
        db.add(GroupDistribution(standard_id=sid, organization_id=oid, course_id=course.id))
        log(db, a, oid, 'Получен черновик стандарта группы', group_id=gid, standard_id=sid, version=standard.version)
        result.append({'venue_id': oid, 'course_id': course.id, 'existing': False})
    db.commit()
    return {'items': result}
