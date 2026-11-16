"""Qualification exams from the current published programme of one venue and role."""

from collections import Counter, defaultdict
from datetime import timedelta
import secrets

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select, update
from sqlalchemy.orm import defer

from ..db import get_db
from .auth import actor, manager
from .domain import POSITIONS, course_bundle, digest, dump, iso, now, parse, require
from .learning import learner
from .media import plain_media
from .models import Account, Exam, ImportedAssessment, RoleExam, VenueSettings, WrittenAttempt
from .packages import attempt_data, submit_attempt

router = APIRouter(prefix='/api/role-exams')


def scope(request, db, account):
    return learner(request, db, account) if account.role == 'employee' else manager(request, db, account)


def positions_for(account):
    return parse(account.positions_json, []) if account.role == 'employee' else list(POSITIONS)


def published_tests(db, oid):
    query = select(ImportedAssessment).where(ImportedAssessment.organization_id == oid,
        ImportedAssessment.published.is_(True), ImportedAssessment.archived.is_(False),
        ImportedAssessment.id.not_in(select(RoleExam.assessment_id)))
    return {test.id: parse(test.payload) for test in db.scalars(query)}


def role_courses(rows, position):
    return [(c, rev, data) for c, _, rev, data in rows if 'all' in data['positions'] or position in data['positions']]


def eligible_tests(tests, position):
    return {aid: data for aid, data in tests.items() if 'all' in data['positions'] or position in data['positions']}


def summary(position, courses, tests):
    authored = sum(task['kind'] == 'written' for p in tests.values() for task in p['tasks'])
    closed = sum(len(data['questions']) for _, _, data in courses)
    return {'position': position, 'name': POSITIONS[position],
            'courses': [{'id': c.id, 'title': data['title'], 'questions': len(data['questions'])}
                        for c, _, data in courses],
            'bank_size': closed + authored, 'written_sources': authored,
            'available': bool(courses and (closed or authored))}


def public_attempt(row, own):
    result = attempt_data(row, False)
    if not own:
        return result
    result.pop('account_id', None)
    return result


@router.get('')
def list_exams(request: Request, a=Depends(actor), db=Depends(get_db)):
    oid = scope(request, db, a)
    rows = course_bundle(db, oid)
    tests = published_tests(db, oid)
    allowed = positions_for(a)
    return [summary(p, role_courses(rows, p), eligible_tests(tests, p)) for p in allowed if p in POSITIONS]


@router.get('/{position}')
def exam_detail(position: str, request: Request, a=Depends(actor), db=Depends(get_db)):
    oid = scope(request, db, a)
    require(position in positions_for(a) and position in POSITIONS, 'Экзамен недоступен', 404)
    info = summary(position, role_courses(course_bundle(db, oid), position),
                   eligible_tests(published_tests(db, oid), position))
    defn = db.get(RoleExam, (oid, position))
    employee = a.role == 'employee'
    query = (select(WrittenAttempt, Account.name).join(Account, WrittenAttempt.account_id == Account.id)
             .options(defer(WrittenAttempt.answers)).where(WrittenAttempt.status != 'interrupted'))
    if employee:
        query = query.where(WrittenAttempt.account_id == a.id)
    attempts = db.execute(query.where(WrittenAttempt.assessment_id == defn.assessment_id)
        .order_by(WrittenAttempt.started_at.desc(), WrittenAttempt.id.desc()).limit(100)).all() if defn else []
    items = []
    for row, name in attempts:
        if row.status == 'in_progress' and row.expires_at <= now():
            locked = db.scalar(select(WrittenAttempt).where(WrittenAttempt.id == row.id).with_for_update()
                               .execution_options(populate_existing=True))
            submit_attempt(locked)
            row = locked
        result = public_attempt(row, employee)
        if not employee:
            result['account_name'] = name
        items.append(result)
    db.commit()
    return {**info, 'attempts': items}


def stable_task_id(prefix, key, prompt):
    stem = ' '.join(plain_media(prompt).casefold().split())
    return f'{prefix}{key}-{digest(stem)[:20]}'


def pools(courses, tests):
    closed = {}
    written = defaultdict(list)
    by_test = {((data.get('program') or {}).get('written_assessment_id')): c.id
               for c, _, data in courses if (data.get('program') or {}).get('written_assessment_id')}
    for c, _, data in courses:
        values = []
        for question in data['questions']:
            prompt = question['prompt']
            task = {'id': stable_task_id('q', c.id, prompt), 'section_id': 'knowledge',
                    'kind': 'single_choice', 'prompt': prompt, 'points': 1,
                    'choices': question['choices'], 'correct_index': question['correct_index'],
                    'explanation': question['explanation'], 'source_course_id': c.id}
            values.append(task)
            if question['type'] in {'scenario', 'sales'} and standalone_prompt(prompt):
                expected = question['choices'][question['correct_index']]
                written[c.id].append({
                    'id': stable_task_id('w', c.id, prompt), 'section_id': 'practice',
                    'kind': 'written', 'prompt': f'{prompt}\n\nОпишите решение своими словами и объясните почему.',
                    'points': 3, 'max_length': 6000, 'source_course_id': c.id,
                    'rubric': [{'id': 'decision', 'label': 'Решение по материалу курса', 'points': 2,
                                'guidance': plain_media(expected)},
                               {'id': 'reason', 'label': 'Обоснование решения', 'points': 1,
                                'guidance': plain_media(question['explanation'])}],
                })
        closed[c.id] = values
    for aid, data in tests.items():
        for task in data['tasks']:
            if task['kind'] == 'written':
                prompt = task['prompt']
                instructions = '\n\n'.join(filter(None, [data['instructions'], next(
                    (s['instructions'] for s in data['sections'] if s['id'] == task['section_id']), '')]))
                prepared = {**task, 'id': f'a{aid}-{digest(task["id"])[:20]}', 'section_id': 'practice',
                            'prompt': f'{instructions}\n\n{prompt}' if instructions else prompt,
                            'source_course_id': by_test.get(aid), 'authored': True}
                written[by_test.get(aid)].append(prepared)
    for c, _, data in courses:
        if written[c.id]:
            continue
        for question in data['questions']:
            if not standalone_prompt(question['prompt']):
                continue
            written[c.id].append({
                'id': stable_task_id('w', c.id, question['prompt']), 'section_id': 'practice',
                'kind': 'written', 'prompt': question['prompt'] +
                    '\n\nСформулируйте ответ своими словами и приведите пример его применения на смене.',
                'points': 3, 'max_length': 6000, 'source_course_id': c.id,
                'rubric': [{'id': 'fact', 'label': 'Точный ответ по курсу', 'points': 2,
                            'guidance': plain_media(question['choices'][question['correct_index']])},
                           {'id': 'application', 'label': 'Уместный пример применения', 'points': 1,
                            'guidance': plain_media(question['explanation'])}],
            })
    return closed, written


def standalone_prompt(prompt):
    return not any(phrase in prompt.casefold() for phrase in
                   ('из перечисленных', 'из вариантов', 'какой вариант', 'сочетание верно'))


def lesson_case(course, title, lesson):
    return {
        'id':stable_task_id('l',course.id,lesson['title']), 'section_id':'practice','kind':'written',
        'prompt': f"Курс «{title}», раздел «{lesson['title']}». Опишите рабочий случай из этого раздела и разберите порядок действий.",
        'points':3,'max_length':6000,'source_course_id':course.id,
        'rubric': [{'id':'case','label':'Конкретный рабочий случай по теме','points':1,'guidance':''},
                   {'id':'action','label':'Обоснованный порядок действий по материалу урока',
                    'points':2,'guidance':plain_media(lesson['body'])[:4000]}],
    }


def build_attempt(position, courses, tests, previous):
    closed, written = pools(courses, tests)
    rng = secrets.SystemRandom()
    def key(task):
        value=task['id']
        return value[1:] if value[0] in {'q','w'} else value
    prior = [[key(task) for task in parse(row.snapshot)['tasks']] for row in previous[:12]]
    latest = set(prior[0]) if prior else set()
    counts = Counter(key for batch in prior for key in batch)
    used = set()
    selected = []

    def select_tasks(groups, target, unique_sources=False, prefer_authored=False):
        candidates = {course: list(items) for course, items in groups.items() if items}
        for items in candidates.values():
            rng.shuffle(items)
            items.sort(key=lambda task: (key(task) in latest, counts[key(task)],
                                         prefer_authored and not task.get('authored')))
        taken = Counter()
        out = []
        while candidates and len(out) < target:
            source=min(candidates,key=lambda course:(taken[course],key(candidates[course][0]) in latest,
                                                     counts[key(candidates[course][0])]))
            task=candidates[source].pop(0)
            normalized=' '.join(task['prompt'].split('\n\n',1)[0].casefold().split())
            if normalized not in used:
                out.append(task)
                taken[source] += 1
                used.add(normalized)
            if not candidates[source] or (unique_sources and taken[source]):
                del candidates[source]
        return out

    # Reserve a place for each course with a bank, and each written-only course.
    first = select_tasks(closed, len(closed), unique_sources=True)
    covered = {task['source_course_id'] for task in first}
    required_written = {c.id: [*written.get(c.id,[]),*[lesson_case(c,data['title'],lesson) for lesson in data['lessons']]]
                        for c,_,data in courses if c.id not in covered}
    practice = select_tasks(required_written, len(required_written), unique_sources=True, prefer_authored=True)
    more_practice = select_tasks(written, max(0, 4 - len(practice)), prefer_authored=True)
    if not practice and not more_practice:
        theory_cases={c.id:[lesson_case(c,data['title'],lesson) for lesson in data['lessons']] for c,_,data in courses}
        more_practice=select_tasks(theory_cases,4)
    selected.extend(first)
    selected.extend(select_tasks(closed, max(0, 30 - len(first) - len(practice) - len(more_practice))))
    rng.shuffle(selected)
    for task in selected:
        order = list(range(len(task['choices'])))
        rng.shuffle(order)
        task['choices'] = [task['choices'][i] for i in order]
        task['correct_index'] = order.index(task['correct_index'])
    sections = []
    if selected:
        sections.append({'id': 'knowledge', 'title': 'Рабочие знания и решения', 'instructions': ''})
    if practice or more_practice:
        sections.append({'id': 'practice', 'title': 'Письменные ситуации',
                         'instructions': 'Ответы проверит управляющий по критериям из ваших материалов.'})
    tasks = selected + practice + more_practice
    require(tasks, 'В опубликованных курсах пока нет банка экзамена', 409)
    return {'title': f'Экзамен · {POSITIONS[position]}', 'description': '', 'positions': [position],
            'instructions': '', 'role_exam_position': position, 'passing_score': 85,
            'sections': sections, 'tasks': tasks, 'time_limit_minutes': max(45, len(tasks) * 2),
            'sequential_sections': len(sections) > 1}


@router.post('/{position}/start')
def start_exam(position: str, request: Request, a=Depends(actor), db=Depends(get_db)):
    oid = learner(request, db, a)
    require(position in positions_for(a) and position in POSITIONS, 'Экзамен недоступен', 404)
    defn = db.get(RoleExam, (oid, position))
    if not defn:
        db.execute(update(VenueSettings).where(VenueSettings.organization_id == oid).values(
            organization_id=VenueSettings.organization_id))
        defn = db.get(RoleExam, (oid, position))
    courses = role_courses(course_bundle(db, oid), position)
    tests = eligible_tests(published_tests(db, oid), position)
    require(courses, 'У этой должности пока нет опубликованных курсов', 409)
    if not defn:
        title = f'Экзамен · {POSITIONS[position]}'
        test = ImportedAssessment(organization_id=oid, title=title, published=True,
            payload=dump({'title': title, 'description': '', 'positions': [position], 'tasks': [],
                          'role_exam_position': position, 'time_limit_minutes': 45}))
        db.add(test)
        db.flush()
        defn = RoleExam(organization_id=oid, position=position, assessment_id=test.id)
        db.add(defn)
        db.flush()
    db.scalar(select(Account.id).where(Account.id == a.id).with_for_update())
    previous = db.scalars(select(WrittenAttempt).where(WrittenAttempt.assessment_id == defn.assessment_id,
        WrittenAttempt.account_id == a.id).order_by(WrittenAttempt.started_at.desc(), WrittenAttempt.id.desc())
        .limit(12).with_for_update()).all()
    for row in previous:
        if row.status != 'in_progress':
            continue
        if row.expires_at > now():
            db.commit()
            return attempt_data(row)
        submit_attempt(row)
    db.flush()
    active_written = db.scalar(select(WrittenAttempt.id).where(WrittenAttempt.account_id == a.id,
        WrittenAttempt.status == 'in_progress', WrittenAttempt.expires_at > now()).limit(1))
    active_quiz = db.scalar(select(Exam.id).where(Exam.account_id == a.id,
        Exam.finished_at.is_(None), Exam.expires_at > now()).limit(1))
    require(not (active_written or active_quiz), 'Сначала завершите текущий тест', 409)
    snapshot = build_attempt(position, courses, tests, previous)
    row = WrittenAttempt(id=secrets.token_urlsafe(28), organization_id=oid, assessment_id=defn.assessment_id,
        account_id=a.id, snapshot=dump(snapshot), expires_at=now() + timedelta(minutes=snapshot['time_limit_minutes']))
    db.add(row)
    db.commit()
    return attempt_data(row)
