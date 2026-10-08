"""Shared rules. All tenant and assessment decisions live on the server."""
import hashlib
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from sqlalchemy import select, func
from fastapi import HTTPException
from ..models import Organization, User, Employee, Course, Lesson, Question, Upload, Attempt, VenueControl, ManagerControl
from ..security import hash_password
from .models import Account, VenueSettings, CourseSettings, CourseRevision, Enrollment, LessonRead, Exam, Notice, SourceFile, Event, Setting

POSITIONS = {'bartender': 'Бармен', 'waiter': 'Официант', 'manager': 'Менеджер зала', 'host': 'Хостес', 'cook': 'Повар', 'barista': 'Бариста', 'administrator': 'Администратор', 'sommelier': 'Сомелье'}
PERMISSIONS = {'employees_manage': 'Сотрудники', 'courses_manage': 'Уроки и тесты', 'uploads_manage': 'Материалы', 'ai_use': 'AI-методист', 'onboarding_edit': 'Интервью'}
QTYPES = {'knowledge': 'Знание', 'understanding': 'Понимание', 'sales': 'Рекомендация', 'scenario': 'Ситуация'}


def now(): return datetime.utcnow()
def dump(x): return json.dumps(x, ensure_ascii=False)
def parse(s, default=None):
    try: return json.loads(s)
    except (TypeError, ValueError): return default if default is not None else {}
def iso(d): return d.isoformat() + 'Z' if d else None
def naive_utc(d): return d.astimezone(timezone.utc).replace(tzinfo=None) if d and d.tzinfo else d
def digest(x): return hashlib.sha256(x.encode()).hexdigest()
def code(): return ''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(10))
def require(value, message, status=400):
    if not value: raise HTTPException(status, message)


def positions(values, all_allowed=True):
    result = list(dict.fromkeys(values))
    allowed = set(POSITIONS) | ({'all'} if all_allowed else set())
    require(result and set(result) <= allowed, 'Выберите корректные должности')
    return ['all'] if 'all' in result else result


def log(db, actor, org_id, action, **details):
    db.add(Event(organization_id=org_id, actor_id=actor.id if actor else None,
                 actor_name=actor.name if actor else 'Система', action=action, details=dump(details)))


def settings(db, org_id):
    s = db.get(VenueSettings, org_id)
    if not s:
        s = VenueSettings(organization_id=org_id, join_code=code(), paid_until=now()+timedelta(days=30),
                          storage_limit_mb=max(15, int(os.getenv('DEFAULT_STORAGE_LIMIT_MB', '200'))),
                          ai_daily_limit=max(0, int(os.getenv('AI_DAILY_LIMIT', '5'))))
        db.add(s); db.flush()
    return s


def course_settings(db, c):
    s = db.get(CourseSettings, c.id)
    if not s:
        s = CourseSettings(course_id=c.id, positions_json=dump([c.target_role]),
                           quiz_size=min(30, max(1, len(c.questions))), is_intro=c.title == 'О заведении')
        db.add(s); db.flush()
    return s


def payload(db, c):
    s = course_settings(db, c)
    return {'title': c.title, 'description': c.description, 'positions': parse(s.positions_json, ['all']),
            'passing_score': c.passing_score, 'required': c.required, 'quiz_size': s.quiz_size,
            'time_limit_minutes': s.time_limit_minutes, 'max_attempts': s.max_attempts,
            'deadline_days': s.deadline_days, 'due_at': iso(s.due_at), 'is_intro': s.is_intro,
            'lessons': [{'title': l.title, 'body': l.body} for l in c.lessons],
            'questions': [{'prompt': q.prompt, 'choices': parse(q.choices_json, []), 'correct_index': q.correct_index,
                           'explanation': q.explanation, 'type': q.question_type} for q in c.questions]}


def revision(db, c):
    s = course_settings(db, c)
    return db.scalar(select(CourseRevision).where(CourseRevision.course_id == c.id, CourseRevision.version == s.version)) if s.version else None


def applies(account, data):
    return 'all' in data['positions'] or bool(set(data['positions']) & set(parse(account.positions_json, [])))


def add_notice(db, account_id, key, title, body, url='/app'):
    if not db.scalar(select(Notice.id).where(Notice.account_id == account_id, Notice.event_key == key)):
        db.add(Notice(account_id=account_id, event_key=key, title=title[:200], body=body, url=url))
        db.flush()


def enroll(db, account, rev):
    found = db.scalar(select(Enrollment).where(Enrollment.account_id == account.id, Enrollment.revision_id == rev.id))
    if found: return found
    data = parse(rev.payload)
    due = datetime.fromisoformat(data['due_at'].replace('Z', '+00:00')).replace(tzinfo=None) if data.get('due_at') else now()+timedelta(days=data.get('deadline_days', 7))
    row = Enrollment(account_id=account.id, revision_id=rev.id, due_at=due)
    db.add(row); db.flush()
    add_notice(db, account.id, f'published:{rev.id}', 'Новое обучение',
               f'{data["title"]}. Пройти до {due.strftime("%d.%m.%Y")}.', f'/app/learn/{rev.course_id}')
    return row


def accessible_courses(db, account):
    result = []
    courses = db.scalars(select(Course).where(Course.organization_id == account.organization_id, Course.published == True)).all()
    for c in courses:
        s = course_settings(db, c)
        rev = revision(db, c)
        if s.archived or not rev: continue
        data = parse(rev.payload)
        if applies(account, data):
            result.append((c, s, rev, data))
    return sorted(result, key=lambda r: (not r[3].get('is_intro'), -r[0].id))


def ensure_enrollments(db, account):
    if account.role == 'employee' and account.active:
        for _, _, rev, _ in accessible_courses(db, account): enroll(db, account, rev)


def exams_for(db, account, rev_id=None):
    q = select(Exam).where(Exam.account_id == account.id)
    if rev_id: q = q.where(Exam.revision_id == rev_id)
    return db.scalars(q.order_by(Exam.started_at.desc())).all()


def learner_stats(db, account):
    cards = []
    for c, s, rev, data in accessible_courses(db, account):
        e = db.scalar(select(Enrollment).where(Enrollment.account_id == account.id, Enrollment.revision_id == rev.id))
        exams = exams_for(db, account, rev.id)
        done = [x for x in exams if x.finished_at]
        results = [parse(x.result_json) for x in done]
        read_count = db.scalar(select(func.count(LessonRead.id)).where(LessonRead.account_id == account.id, LessonRead.revision_id == rev.id, LessonRead.completed_at.is_not(None))) or 0
        passed = any(x.get('passed') for x in results)
        cards.append({'id': c.id, 'title': data['title'], 'description': data['description'], 'positions': data['positions'],
                      'required': data['required'], 'is_intro': data.get('is_intro', False), 'version': rev.version,
                      'lesson_count': len(data['lessons']), 'read_count': read_count, 'question_count': data['quiz_size'], 'card_count': len(data['questions']),
                      'bank_size': len(data['questions']), 'passing_score': data['passing_score'],
                      'due_at': iso(e.due_at) if e else None, 'passed': passed, 'attempts': len(exams),
                      'overdue': bool(e and e.due_at and e.due_at < now() and not passed),
                      'best_score': max([r.get('score', 0) for r in results], default=None),
                      'latest_score': results[0].get('score') if results else None,
                      'progress': round(100*(read_count + int(passed))/(len(data['lessons'])+1))})
    all_exams = exams_for(db, account)
    done = [parse(x.result_json) for x in all_exams if x.finished_at]
    durations = [r['duration_seconds'] for r in done if r.get('duration_seconds') is not None]
    weak = {}
    for r in done:
        for q in r.get('review', []):
            if not q.get('correct'): weak[q.get('type', 'knowledge')] = weak.get(q.get('type', 'knowledge'), 0)+1
    passed = sum(c['passed'] for c in cards)
    completed = sum(c['attempts'] > 0 and c['latest_score'] is not None for c in cards)
    return {'assigned': len(cards), 'passed': passed, 'completed': completed,
            'completion_percent': round(completed/len(cards)*100) if cards else 0,
            'success_percent': round(passed/len(cards)*100) if cards else 0,
            'attempt_pass_percent': round(sum(bool(r.get('passed')) for r in done)/len(done)*100) if done else None,
            'average_score': round(sum(r.get('score', 0) for r in done)/len(done), 1) if done else None,
            'average_seconds': round(sum(durations)/len(durations)) if durations else None,
            'total_seconds': sum(durations), 'attempts': len(all_exams), 'overdue': sum(c['overdue'] for c in cards),
            'weak_topics': weak, 'courses': cards}


def migrate(db):
    """Additive migration; old tables and historical records remain untouched."""
    if db.get(Setting, 'migration_v2'): return
    for org in db.scalars(select(Organization)).all():
        s = settings(db, org.id)
        old = db.scalar(select(VenueControl).where(VenueControl.organization_id == org.id))
        if old:
            s.status = old.status
            s.permissions_json = old.permissions_json
            s.note = old.note
    for user in db.scalars(select(User)).all():
        if user.role in {'platform_shadow', 'manager_pending'}: continue
        owner = user.role in {'platform_owner', 'owner'}
        mc = db.scalar(select(ManagerControl).where(ManagerControl.user_id == user.id))
        db.add(Account(legacy_user_id=user.id, organization_id=None if owner else user.organization_id,
                       name=user.name, login=user.email.lower(), role='owner' if owner else 'manager',
                       password_hash=user.password_hash, active=not (mc and mc.blocked), permissions_json=mc.permissions_json if mc else '{}'))
    for emp in db.scalars(select(Employee)).all():
        # Legacy personal links can be redeemed once to create a secure session.
        db.add(Account(employee_id=emp.id, organization_id=emp.organization_id, name=emp.name,
                       login=f'employee-{emp.id}', role='employee', password_hash=hash_password(secrets.token_urlsafe(32)),
                       positions_json=dump([emp.position]), active=emp.active, created_at=emp.created_at))
    db.flush()
    for c in db.scalars(select(Course)).all():
        s = course_settings(db, c)
        if c.published and c.lessons and c.questions:
            s.version = 1
            db.add(CourseRevision(course_id=c.id, version=1, payload=dump(payload(db, c))))
        elif c.published:
            # Empty legacy courses cannot become runnable exams.
            c.published = False
    for u in db.scalars(select(Upload)).all():
        raw = None
        try:
            path = Path(u.stored_path)
            if path.is_file() and path.stat().st_size <= 15*1024*1024: raw = path.read_bytes()
        except OSError: pass
        db.add(SourceFile(organization_id=u.organization_id, legacy_upload_id=u.id, name=u.filename,
                          mime=u.mime_type, size=len(raw) if raw else 0, content=raw, text=u.extracted_text,
                          positions_json=dump([u.target_role]), warning='' if raw else 'Сохранён текст. Оригинал старой версии отсутствует — загрузите файл заново.'))
    db.flush()
    for a in db.scalars(select(Attempt)).all():
        account = db.scalar(select(Account).where(Account.employee_id == a.employee_id))
        c = db.get(Course, a.course_id)
        rev = revision(db, c) if c else None
        if account and rev:
            db.add(Exam(id=f'legacy-{a.id}', account_id=account.id, revision_id=rev.id, questions_json='[]',
                        answers_json='{}', started_at=a.created_at, expires_at=a.created_at, finished_at=a.created_at,
                        result_json=dump({'score': a.score, 'passed': a.passed, 'duration_seconds': None, 'review': [], 'legacy': True})))
    db.add(Setting(key='migration_v2', value=iso(now())))
    db.commit()
