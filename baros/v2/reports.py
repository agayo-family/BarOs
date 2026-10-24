"""Actionable gaps from each learner's latest attempt of the current version."""
from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from ..db import get_db
from .auth import actor, manager
from .models import Account, Exam
from .domain import applies, course_bundle, parse

router = APIRouter()


@router.get('/api/reports/knowledge-gaps')
def knowledge_gaps(request: Request, a=Depends(actor), db=Depends(get_db)):
    oid = manager(request, db, a)
    employees = {e.id: e for e in db.scalars(select(Account).where(
        Account.organization_id == oid, Account.role == 'employee', Account.active == True)).all()}
    publications = {rev.id: (course, rev, data) for course, _, rev, data in course_bundle(db, oid)}
    if not employees or not publications:
        return {'latest_attempts': 0, 'gaps': [], 'affected_employees': 0}
    attempts = db.scalars(select(Exam).where(Exam.account_id.in_(employees),
        Exam.revision_id.in_(publications), Exam.finished_at.is_not(None))
        .order_by(Exam.finished_at.desc(), Exam.id.desc())).all()
    seen, rows, affected = set(), {}, set()
    for attempt in attempts:
        key = (attempt.account_id, attempt.revision_id)
        if key in seen:
            continue
        course, revision, data = publications[attempt.revision_id]
        employee = employees[attempt.account_id]
        if not applies(employee, data):
            continue
        seen.add(key)
        for question in parse(attempt.result_json).get('review', []):
            prompt = question.get('prompt', '')
            if not prompt:
                continue
            item = rows.setdefault((revision.id, prompt), {
                'course_id': course.id, 'course_title': data['title'], 'version': revision.version,
                'prompt': prompt, 'reviewed': 0, 'employees': [],
                'explanation': question.get('explanation', '')})
            item['reviewed'] += 1
            if not question.get('correct'):
                item['employees'].append({'id': employee.id, 'name': employee.name})
                affected.add(employee.id)
    gaps = [{**r, 'mistakes': len(r['employees']),
             'mistake_percent': round(100 * len(r['employees']) / r['reviewed'])}
            for r in rows.values() if r['employees']]
    gaps.sort(key=lambda r: (-r['mistakes'], -r['mistake_percent'], r['course_title'], r['prompt']))
    return {'latest_attempts': len(seen), 'gaps': gaps[:30], 'affected_employees': len(affected)}
