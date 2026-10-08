"""Learning practice from course publications; never creates exam or theory credit."""
import secrets
from datetime import timedelta
from typing import Literal
from fastapi import APIRouter, Depends, Request
from pydantic import Field, field_validator, StrictInt, StrictBool
from sqlalchemy import select, delete
from ..db import get_db
from ..models import Course
from .auth import actor, tenant, manager, rate
from .domain import (require, parse, dump, now, iso, digest, applies, course_settings,
                     revision, payload, accessible_courses, enroll)
from .learning import learning_course
from .models import Account, GameProgress, GameRun, GameTurn, CourseRevision
from .schemas import StrictModel

router = APIRouter(prefix='/api/games')
MODES = {
    'mix': {'title': 'Маршрут темы', 'subtitle': 'Разные задания и постепенный охват всей темы', 'icon': 'route'},
    'pairs': {'title': 'Найди пару', 'subtitle': 'Соединяйте вопросы с точными ответами', 'icon': 'link'},
    'words': {'title': 'Собери ответ', 'subtitle': 'Восстановите состав, формулировку или порядок слов', 'icon': 'blocks'},
    'truth': {'title': 'Верно или нет', 'subtitle': 'Замечайте неточности и объясняйте себе разницу', 'icon': 'shield'},
    'scenario': {'title': 'Рабочая ситуация', 'subtitle': 'Тренируйте решения для работы с гостями', 'icon': 'interview'},
    'recall': {'title': 'Вспомни сам', 'subtitle': 'Ответьте без вариантов, затем проверьте себя', 'icon': 'brain'},
}


class StartIn(StrictModel):
    mode: Literal['mix', 'pairs', 'words', 'truth', 'scenario', 'recall']
    scope: Literal['all', 'review'] = 'all'
    size: int = Field(default=5, ge=1, le=20)


class TurnIn(StrictModel):
    event_id: str = Field(min_length=8, max_length=80, pattern=r'^[a-zA-Z0-9_-]+$')
    question_id: int = Field(ge=0, le=10000)
    value: StrictInt | StrictBool | list[StrictInt] | None = None
    rating: Literal['remembered', 'again'] | None = None
    hinted: bool = False

    @field_validator('value')
    @classmethod
    def bounded_value(cls, value):
        if isinstance(value, list) and (len(value) > 24 or any(type(x) is not int or x < 0 or x > 24 for x in value)):
            raise ValueError('Некорректные части ответа')
        return value


def words(answer):
    return answer.split()


def question_cards(data):
    return [{'id': i, 'prompt': q['prompt'], 'answer': q['choices'][q['correct_index']],
             'choices': q['choices'], 'correct_index': q['correct_index'],
             'type': q.get('type', 'knowledge'), 'explanation': q.get('explanation', '')}
            for i, q in enumerate(data.get('questions', []))]


def eligible(cards, mode):
    if mode == 'words': return [q for q in cards if 2 <= len(words(q['answer'])) <= 24]
    if mode == 'scenario': return [q for q in cards if q['type'] in {'scenario', 'sales'}]
    if mode == 'pairs':
        found, unique = set(), []
        for q in cards:
            key = ' '.join(q['answer'].split()).casefold()
            if key not in found: unique.append(q); found.add(key)
        return unique
    return cards


def mode_cards(cards):
    result = []
    for name, meta in MODES.items():
        count = len(eligible(cards, name)); available = count >= (2 if name == 'pairs' else 1)
        reason = '' if available else ('Нужны хотя бы два разных ответа' if name == 'pairs' else
                 'Добавьте вопросы типа «Ситуация» или «Рекомендация»' if name == 'scenario' else
                 'Нужен хотя бы один ответ из 2–24 слов' if name == 'words' else 'Добавьте вопросы к обучению')
        result.append({'id': name, **meta, 'available': available, 'count': count, 'reason': reason})
    return result


def progress_rows(db, a, rev):
    if not rev or a.role != 'employee': return {}
    return {r.question_index: r for r in db.scalars(select(GameProgress).where(
        GameProgress.account_id == a.id, GameProgress.revision_id == rev.id)).all()}


def progress_summary(rows, total):
    seen = sum(r.practiced > 0 for r in rows.values())
    return {'total': total, 'practiced': seen, 'coverage_percent': round(seen*100/total) if total else 0,
            'confident': sum(r.streak >= 2 for r in rows.values()),
            'review': sum(r.due_at <= now() for r in rows.values()),
            'items': [{'id': r.question_index, 'practiced': r.practiced, 'mistakes': r.mistakes,
                       'streak': r.streak, 'due_at': iso(r.due_at)} for r in rows.values()]}


def material(request, db, a, cid):
    if a.role == 'employee':
        c, s, rev, data, _ = learning_course(request, db, a, cid)
    else:
        oid = manager(request, db, a)
        c = db.get(Course, cid); require(c and c.organization_id == oid, 'Обучение не найдено', 404)
        s = course_settings(db, c); require(not s.archived, 'Курс архивирован', 404)
        rev = revision(db, c) if c.published else None
        # Manager preview explicitly uses the published version where one exists.
        data = parse(rev.payload) if rev else payload(db, c)
    return c, s, rev, data


def active_run(db, a, cid, rev):
    q = select(GameRun).where(GameRun.account_id == a.id, GameRun.course_id == cid,
                             GameRun.expires_at > now(), GameRun.preview == False)
    if rev: q = q.where(GameRun.revision_id == rev.id)
    for run in db.scalars(q.order_by(GameRun.created_at.desc()).limit(20)).all():
        if not run_card(run)['finished']: return run.id
    return None


@router.get('')
def catalog(request: Request, a=Depends(actor), db=Depends(get_db)):
    result = []
    if a.role == 'employee':
        tenant(request, db, a, learning=True)
        courses = [(c, s, rev, data) for c, s, rev, data in accessible_courses(db, a)]
    else:
        oid = manager(request, db, a)
        courses = []
        for c in db.scalars(select(Course).where(Course.organization_id == oid)).all():
            s = course_settings(db, c)
            if s.archived: continue
            rev = revision(db, c) if c.published else None
            courses.append((c, s, rev, parse(rev.payload) if rev else payload(db, c)))
    for c, s, rev, data in courses:
        if a.role == 'employee': enroll(db, a, rev)
        cards = question_cards(data)
        result.append({'id': c.id, 'title': data['title'], 'description': data.get('description', ''),
                       'version': rev.version if rev else None, 'published': bool(rev),
                       'question_count': len(cards), 'mode_count': sum(m['available'] for m in mode_cards(cards)),
                       'progress': progress_summary(progress_rows(db, a, rev), len(cards)),
                       'active_run': active_run(db, a, c.id, rev) if a.role == 'employee' else None})
    db.commit(); return {'preview': a.role != 'employee', 'courses': result}


@router.get('/{cid:int}')
def board(cid: int, request: Request, a=Depends(actor), db=Depends(get_db)):
    c, s, rev, data = material(request, db, a, cid); cards = question_cards(data)
    result = {'id': cid, 'title': data['title'], 'description': data.get('description', ''),
              'version': rev.version if rev else None, 'revision_id': rev.id if rev else None,
              'preview': a.role != 'employee', 'published': bool(rev), 'modes': mode_cards(cards),
              'lessons': data.get('lessons', []), 'progress': progress_summary(progress_rows(db, a, rev), len(cards)),
              'active_run': active_run(db, a, cid, rev) if a.role == 'employee' else None}
    db.commit(); return result


def variant(q, mode, index, rng):
    if mode == 'mix':
        candidates = ['recall', 'truth']
        if 2 <= len(words(q['answer'])) <= 24: candidates.append('words')
        if q['type'] in {'scenario', 'sales'}: candidates.append('scenario')
        # Spread formats across the route, preserving the question's meaning.
        mode = candidates[index % len(candidates)]
    result = {**q, 'variant': mode}
    if mode == 'truth':
        idx = q['correct_index'] if rng.random() < .5 else rng.choice([i for i in range(len(q['choices'])) if i != q['correct_index']])
        result['claim'] = q['choices'][idx]; result['claim_true'] = idx == q['correct_index']
    if mode == 'scenario':
        order = list(range(len(q['choices']))); rng.shuffle(order)
        result['choices'] = [q['choices'][i] for i in order]; result['correct_index'] = order.index(q['correct_index'])
    if mode == 'words':
        tokens = list(enumerate(words(q['answer']))); rng.shuffle(tokens)
        if [i for i, _ in tokens] == list(range(len(tokens))): tokens = tokens[1:]+tokens[:1]
        result['tokens'] = [{'id': i, 'text': word} for i, word in tokens]
    return result


def run_card(run):
    d = parse(run.payload); answers = parse(run.answers)
    items = list(answers.values())
    return {'id': run.id, 'course_id': run.course_id, 'title': d['title'], 'mode': run.mode,
            'revision_id': run.revision_id, 'preview': run.preview, 'expires_at': iso(run.expires_at),
            'questions': d['questions'], 'answers': answers,
            'finished': len(answers) == len(d['questions']) and (run.mode != 'pairs' or all(r['correct'] for r in items)),
            'summary': {'answered': len(items), 'total': len(d['questions']),
                        'first_correct': sum(r['first_correct'] for r in items if not r['self_assessed']),
                        'objective': sum(not r['self_assessed'] for r in items),
                        'self_assessed': sum(r['self_assessed'] for r in items),
                        'review_ids': [int(k) for k, r in answers.items() if not r['first_correct'] or r['hinted']]}}


@router.post('/{cid:int}/start')
def start(cid: int, data: StartIn, request: Request, a=Depends(actor), db=Depends(get_db)):
    c, s, rev, p = material(request, db, a, cid)
    rate(db, 'game-start:'+str(a.id), 120, 3600)
    cards = eligible(question_cards(p), data.mode); rows = progress_rows(db, a, rev)
    if data.scope == 'review': cards = [q for q in cards if q['id'] in rows and rows[q['id']].due_at <= now()]
    require(len(cards) >= (2 if data.mode == 'pairs' else 1), 'Для этого режима пока недостаточно заданий. Выберите другой режим или весь материал.', 409)
    rng = secrets.SystemRandom(); rng.shuffle(cards)
    def priority(q):
        r = rows.get(q['id'])
        return (0 if r and r.due_at <= now() else 1 if not r else 2, r.practiced if r else 0)
    cards.sort(key=priority)
    n = min(len(cards), min(data.size, 6) if data.mode == 'pairs' else data.size)
    if data.mode == 'pairs': n = max(2, n)
    questions = [variant(q, data.mode, i, rng) for i, q in enumerate(cards[:n])]
    run = GameRun(id=secrets.token_urlsafe(24), organization_id=c.organization_id, account_id=a.id,
                  course_id=cid, revision_id=rev.id if rev else None, preview=a.role != 'employee', mode=data.mode,
                  payload=dump({'title': p['title'], 'positions': p['positions'], 'questions': questions, 'edit_version': s.edit_version}),
                  expires_at=now()+timedelta(days=7), answers='{}')
    db.add(run); db.commit(); return run_card(run)


def access_run(rid, request, db, a):
    oid = tenant(request, db, a, learning=a.role == 'employee')
    run = db.scalar(select(GameRun).where(GameRun.id == rid).with_for_update())
    require(run and run.account_id == a.id and run.organization_id == oid, 'Игра не найдена', 404)
    require(run.expires_at > now(), 'Срок сохранённой игры истёк. Начните новый раунд.', 410)
    require(run.preview == (a.role != 'employee'), 'Режим аккаунта изменился. Начните новый раунд.', 403)
    c = db.get(Course, run.course_id); require(c and not course_settings(db, c).archived, 'Обучение архивировано', 403)
    if not run.preview:
        published = revision(db, c) if c.published else None
        require(published and applies(a, parse(published.payload)) and applies(a, parse(run.payload)),
                'Обучение больше не назначено вашим должностям', 403)
    elif not run.revision_id:
        require(course_settings(db, c).edit_version == parse(run.payload)['edit_version'], 'Черновик изменён. Начните новый предпросмотр.', 409)
    return run


@router.get('/runs/{rid}')
def resume(rid: str, request: Request, a=Depends(actor), db=Depends(get_db)):
    run = access_run(rid, request, db, a)
    rev = db.get(CourseRevision, run.revision_id) if run.revision_id else None
    data = parse(rev.payload) if rev else payload(db, db.get(Course, run.course_id))
    return {**run_card(run), 'lessons': data.get('lessons', [])}


def grade(q, data, questions):
    mode = q['variant']; self_assessed = mode == 'recall'
    if self_assessed:
        require(data.rating is not None and data.value is None, 'Оцените, удалось ли вспомнить ответ')
        return data.rating == 'remembered', True
    require(data.rating is None, 'Самооценка доступна только в режиме «Вспомни сам»')
    if mode == 'truth':
        require(type(data.value) is bool, 'Выберите «Верно» или «Неверно»')
        return data.value == q['claim_true'], False
    if mode == 'words':
        require(isinstance(data.value, list) and sorted(data.value) == list(range(len(q['tokens']))), 'Используйте каждую часть ответа ровно один раз')
        parts = words(q['answer'])
        return [parts[i] for i in data.value] == parts, False
    require(type(data.value) is int, 'Выберите один ответ')
    if mode == 'pairs':
        require(data.value in {x['id'] for x in questions}, 'Ответ не найден')
        return data.value == q['id'], False
    require(0 <= data.value < len(q['choices']), 'Ответ не найден')
    return data.value == q['correct_index'], False


@router.post('/runs/{rid}/answer')
def answer(rid: str, data: TurnIn, request: Request, a=Depends(actor), db=Depends(get_db)):
    # Account lock prevents progress lost updates when two tabs answer concurrently.
    db.scalar(select(Account).where(Account.id == a.id).with_for_update())
    run = access_run(rid, request, db, a)
    request_hash = digest(dump(data.model_dump()))
    duplicate = db.scalar(select(GameTurn).where(GameTurn.run_id == rid, GameTurn.event_id == data.event_id))
    if duplicate:
        require(duplicate.request_hash == request_hash, 'Этот запрос уже использован для другого ответа', 409)
        return {**parse(duplicate.result), 'run': run_card(run)}
    p = parse(run.payload); questions = p['questions']
    q = next((x for x in questions if x['id'] == data.question_id), None)
    require(q, 'Задание не относится к этому раунду', 404)
    correct, self_assessed = grade(q, data, questions)
    answers = parse(run.answers); key = str(q['id']); first = key not in answers
    old = answers.get(key, {})
    current = {'correct': correct, 'first_correct': old.get('first_correct', correct and not data.hinted),
               'self_assessed': self_assessed, 'hinted': old.get('hinted', False) or data.hinted,
               'attempts': old.get('attempts', 0)+1}
    answers[key] = current; run.answers = dump(answers)
    if first and not run.preview:
        row = db.scalar(select(GameProgress).where(GameProgress.account_id == a.id,
             GameProgress.revision_id == run.revision_id, GameProgress.question_index == q['id']))
        if not row:
            row = GameProgress(account_id=a.id, revision_id=run.revision_id, question_index=q['id'],
                               practiced=0, correct=0, mistakes=0, streak=0); db.add(row)
        row.practiced += 1; row.last_at = now()
        if correct and not self_assessed and not data.hinted:
            row.correct += 1; row.streak += 1
            row.due_at = now()+timedelta(days=[1, 3, 7, 14][min(row.streak-1, 3)])
        else:
            row.streak = 0
            if not correct: row.mistakes += 1
            row.due_at = now() if not correct or data.hinted else now()+timedelta(days=1)
    result = {'question_id': q['id'], 'correct': correct, 'self_assessed': self_assessed, 'first': first,
              'answer': q['answer'], 'explanation': q['explanation']}
    db.add(GameTurn(run_id=rid, event_id=data.event_id, request_hash=request_hash, result=dump(result)))
    db.commit(); return {**result, 'run': run_card(run)}


def cleanup_games(db):
    expired = db.scalars(select(GameRun.id).where(GameRun.expires_at <= now()).limit(100)).all()
    if expired:
        db.execute(delete(GameTurn).where(GameTurn.run_id.in_(expired)))
        db.execute(delete(GameRun).where(GameRun.id.in_(expired)))
