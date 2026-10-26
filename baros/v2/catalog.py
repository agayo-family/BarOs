"""Owner-reviewed standard courses. Approval stores an immutable content snapshot.

Deploying a new catalogue never grants approval or changes a venue's courses.
Venue creation and activation share one database lock to avoid missing a venue.
"""
from copy import deepcopy
from datetime import timedelta
from functools import lru_cache
import json
import math
from pathlib import Path

from fastapi import APIRouter, Depends
from sqlalchemy import select, func

from ..db import get_db, engine
from ..models import Organization, Course
from .auth import actor, owner
from .domain import (POSITIONS, applies, digest, dump, iso, log, now, parse,
                     payload, positions, require, settings)
from .models import (Account, CourseProgram, CourseRevision, CourseSettings,
                     Enrollment, ImportedAssessment, Notice, Setting, SourceFile, VenueSettings)
from .packages import AssessmentIn
from .schemas import CatalogActivateIn, CatalogPauseIn, CourseIn

router = APIRouter()
STATE_KEY = 'standard_catalog'
DATA_FILE = Path(__file__).with_name('standard_courses.json')


@lru_cache(maxsize=1)
def candidate():
    data = json.loads(DATA_FILE.read_text(encoding='utf-8'))
    keys = set()
    for item in data['courses']:
        require(item['key'] not in keys, 'В библиотеке повторяется идентификатор курса', 500)
        keys.add(item['key'])
        course = CourseIn.model_validate(item['course'])
        positions(course.positions, False)
        require(course.positions == [item['role']], 'Должность курса не совпадает с разделом', 500)
        require(len(course.lessons) >= 3 and len(course.questions) >= course.quiz_size,
                'Неполный курс в библиотеке', 500)
        require(len({' '.join(q.prompt.casefold().split()) for q in course.questions}) == len(course.questions),
                'В библиотеке повторяются вопросы', 500)
        require(all(s['url'].startswith('https://') for s in item.get('sources', [])),
                'Некорректная ссылка в библиотеке', 500)
        item['course'] = course.model_dump(mode='json')
    data['fingerprint'] = digest(json.dumps(data, ensure_ascii=False, sort_keys=True))
    return data


def state(db):
    row = db.get(Setting, STATE_KEY)
    return parse(row.value) if row else {}


def lock_state(db):
    row = db.scalar(select(Setting).where(Setting.key == STATE_KEY).with_for_update())
    require(row is not None, 'Библиотека ещё не инициализирована. Повторите после запуска сервиса.', 503)
    return row


def course_fingerprint(data):
    content = {k: v for k, v in data.items() if k in CourseIn.model_fields}
    normalized = CourseIn.model_validate(content).model_dump(mode='json')
    normalized.pop('edit_version', None)
    return digest(json.dumps(normalized, ensure_ascii=False, sort_keys=True))


def install_snapshot(db, organization_id, approved, by=None, previous=None):
    """Publish missing courses or untouched older standard copies; retain local work."""
    result = {'added': 0, 'updated': 0, 'customized': 0, 'existing': 0, 'enrollments': 0}
    if not approved.get('enabled'):
        return result
    rows = db.execute(select(Course, CourseProgram).join(CourseProgram,
        Course.id == CourseProgram.course_id).where(Course.organization_id == organization_id)).all()
    existing = {}
    for course, program in rows:
        key = parse(program.payload).get('standard_catalog', {}).get('key')
        if key: existing.setdefault(key, []).append((course, program))
    # Same order as other course mutations; the catalog lock is acquired first.
    ids = sorted(course.id for pairs in existing.values() for course, _ in pairs)
    configs = {c.course_id: c for c in db.scalars(select(CourseSettings)
        .where(CourseSettings.course_id.in_(ids)).order_by(CourseSettings.course_id)
        .with_for_update().execution_options(populate_existing=True)).all()} if ids else {}
    previous_courses = {x['key']: x for x in (previous or {}).get('courses', [])}
    venue = settings(db, organization_id)
    active = venue.status == 'active' and venue.subscription_status in {'active', 'trial'} and (
        not venue.paid_until or venue.paid_until > now())
    employees = db.scalars(select(Account).where(Account.organization_id == organization_id,
        Account.role == 'employee', Account.active == True)).all() if active else []
    from .content import save_course
    for item in approved['courses']:
        old = existing.get(item['key'], [])
        if len(old) > 1:
            result['customized'] += 1
            continue
        if old:
            c, program = old[0]
            meta = parse(program.payload)
            provenance = meta.get('standard_catalog', {})
            if provenance.get('version', 1) >= item.get('version', 1):
                result['existing'] += 1
                continue
            config = configs.get(c.id)
            db.refresh(c)
            db.expire(c, ['lessons', 'questions'])
            before = previous_courses.get(item['key'])
            expected = provenance.get('content_fingerprint') or (course_fingerprint(before['course']) if before else None)
            published = db.scalar(select(CourseRevision).where(CourseRevision.course_id == c.id,
                CourseRevision.version == config.version)) if config else None
            if (not config or config.archived or not c.published or not expected or not published
                or course_fingerprint(payload(db, c)) != expected
                or course_fingerprint(parse(published.payload)) != expected):
                result['customized'] += 1
                continue
            kind = 'updated'
        else:
            c = Course(organization_id=organization_id, title=item['course']['title'], published=False)
            db.add(c); db.flush()
            program = CourseProgram(course_id=c.id, payload='{}')
            db.add(program); db.flush()
            meta = {}; kind = 'added'
        data = CourseIn.model_validate(item['course'])
        save_course(db, c, data)
        meta['standard_catalog'] = {'key': item['key'], 'release': approved['fingerprint'],
            'sources': item.get('sources', []), 'version': item.get('version', 1),
            'content_fingerprint': course_fingerprint(item['course'])}
        # Expanded catalog courses have theory and a question bank, without homework.
        # Old written work stays in its own assessment/history; no rows are deleted.
        meta.pop('written_assessment_id', None)
        assessment = None
        if item.get('practice'):
            # Compatibility for the owner's previously approved v1 snapshot.
            practice = AssessmentIn.model_validate(item['practice'])
            assessment = ImportedAssessment(organization_id=organization_id, title=practice.title,
                payload=dump(practice.model_dump(mode='json')), published=True)
            db.add(assessment); db.flush(); meta['written_assessment_id'] = assessment.id
        program.payload = dump(meta)
        config = db.get(CourseSettings, c.id)
        config.version += 1
        c.published = True
        db.flush()
        content = payload(db, c)
        rev = CourseRevision(course_id=c.id, version=config.version, payload=dump(content))
        db.add(rev); db.flush()
        due = now() + timedelta(days=data.deadline_days)
        for employee in employees:
            if applies(employee, content):
                db.add(Enrollment(account_id=employee.id, revision_id=rev.id, due_at=due))
                db.add(Notice(account_id=employee.id, event_key=f'published:{rev.id}',
                    title='Новое обучение' if kind == 'added' else 'Обновлено обучение',
                    body=f'{c.title}. Пройти до {due:%d.%m.%Y}.', url=f'/app/learn/{c.id}'))
                if assessment:
                    db.add(Notice(account_id=employee.id, event_key=f'assessment:{assessment.id}',
                        title='Письменные ситуации', body=assessment.title,
                        url=f'/app/assessments/{assessment.id}'))
                result['enrollments'] += 1
        result[kind] += 1
    if result['added'] or result['updated']:
        log(db, by, organization_id, 'Обновлена общая библиотека курсов', **result)
    return result


def state_summary(db, approved):
    return {'enabled': bool(approved.get('enabled')), 'revision': approved.get('revision', 0),
            'approved_at': approved.get('approved_at'), 'approved_by': approved.get('approved_by'),
            'approved_fingerprint': approved.get('fingerprint'),
            'venue_count': db.scalar(select(func.count(Organization.id)).where(
                Organization.name != '__BAROS_PLATFORM__')) or 0}


@router.get('/api/owner/catalog')
def catalogue(a=Depends(actor), db=Depends(get_db)):
    owner(a)
    data = candidate()
    return {**state_summary(db, state(db)), 'fingerprint': data['fingerprint'],
            'version': data['version'], 'roles': {k: POSITIONS[k] for k in data['roles']},
            'courses': [{'key': x['key'], 'role': x['role'], 'title': x['course']['title'],
                         'description': x['course']['description'], 'outcomes': x['outcomes'],
                         'lessons': len(x['course']['lessons']), 'questions': len(x['course']['questions']),
                         'written': len(x.get('practice', {}).get('tasks', [])),
                         'word_count': sum(len(l['body'].split()) for l in x['course']['lessons']),
                         'minutes': max(1, math.ceil(sum(len(l['body'].split()) for l in x['course']['lessons']) / 150))}
                        for x in data['courses']]}


@router.get('/api/owner/catalog/courses/{key}')
def catalogue_course(key: str, a=Depends(actor)):
    owner(a)
    data = candidate()
    item = next((c for c in data['courses'] if c['key'] == key), None)
    require(item, 'Курс библиотеки не найден', 404)
    return {**deepcopy(item), 'fingerprint': data['fingerprint']}


@router.post('/api/owner/catalog/activate')
def activate(data: CatalogActivateIn, a=Depends(actor), db=Depends(get_db)):
    owner(a)
    require(data.reviewed, 'Подтвердите, что проверили содержание всех курсов')
    current = candidate()
    require(data.fingerprint == current['fingerprint'], 'Содержание библиотеки изменилось. Прочитайте актуальную редакцию.', 409)
    row = lock_state(db)
    previous = parse(row.value)
    require(data.expected_revision == previous.get('revision', 0),
            'Настройки библиотеки изменены в другом окне. Обновите страницу.', 409)
    approved = {'enabled': True, 'revision': previous.get('revision', 0) + 1,
                'fingerprint': current['fingerprint'], 'approved_at': iso(now()),
                'approved_by': a.name, 'courses': deepcopy(current['courses'])}
    totals = {'venues': 0, 'added': 0, 'updated': 0, 'customized': 0, 'existing': 0, 'enrollments': 0}
    for oid in db.scalars(select(Organization.id).where(Organization.name != '__BAROS_PLATFORM__').order_by(Organization.id)).all():
        installed = install_snapshot(db, oid, approved, a, previous=previous)
        totals['venues'] += 1
        for key in installed: totals[key] += installed[key]
    row.value = dump(approved)
    log(db, a, None, 'Включена общая библиотека курсов', fingerprint=current['fingerprint'], **totals)
    db.commit()
    return {**state_summary(db, approved), **totals}


@router.post('/api/owner/catalog/pause')
def pause(data: CatalogPauseIn, a=Depends(actor), db=Depends(get_db)):
    owner(a)
    row = lock_state(db); approved = parse(row.value)
    require(data.expected_revision == approved.get('revision', 0), 'Настройки изменены в другом окне', 409)
    approved.update(enabled=False, revision=approved.get('revision', 0) + 1)
    row.value = dump(approved)
    log(db, a, None, 'Остановлено автоматическое добавление общей библиотеки')
    db.commit()
    return state_summary(db, approved)


@router.get('/api/owner/onboarding')
def onboarding(a=Depends(actor), db=Depends(get_db)):
    owner(a)
    # Batch counts for every venue, including venues that have no courses or manager yet.
    orgs = db.scalars(select(Organization).where(Organization.name != '__BAROS_PLATFORM__').order_by(Organization.id.desc())).all()
    ids = [o.id for o in orgs]
    counts = {}
    for field, model, conditions in [
        ('managers', Account, [Account.role == 'manager', Account.active == True]),
        ('employees', Account, [Account.role == 'employee', Account.active == True]),
        ('sources', SourceFile, []), ('courses', Course, [Course.published == True])]:
        counts[field] = dict(db.execute(select(model.organization_id, func.count(model.id))
            .where(model.organization_id.in_(ids), *conditions).group_by(model.organization_id)).all()) if ids else {}
    configs = {s.organization_id: s for s in db.scalars(select(VenueSettings).where(VenueSettings.organization_id.in_(ids))).all()} if ids else {}
    approved = state(db)
    return {'catalog': state_summary(db, approved), 'database': engine.dialect.name,
            'venues': [{'id': o.id, 'name': o.name, **{k: v.get(o.id, 0) for k, v in counts.items()},
                        'status': configs[o.id].status if o.id in configs else 'active',
                        'access_ready': o.id in configs and configs[o.id].status == 'active'
                            and configs[o.id].subscription_status in {'trial', 'active'}
                            and (not configs[o.id].paid_until or configs[o.id].paid_until > now())}
                       for o in orgs]}
