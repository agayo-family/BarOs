"""Bounded, local query/response benchmark. Never opens the deployed database."""
import importlib
import json
import os
from pathlib import Path
import statistics
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tempfile
import time

workspace = tempfile.TemporaryDirectory(prefix='baros-performance-')
os.environ.update(DATABASE_URL='sqlite:///'+str(Path(workspace.name)/'audit.db'), BAROS_WORKER='0',
                  COOKIE_SECURE='0', SESSION_SECRET='performance-test-only', FIRST_RUN_TOKEN='performance-test-only')

from fastapi.testclient import TestClient
from sqlalchemy import event
from baros.db import SessionLocal, engine
from baros.models import Organization, Course, Lesson, Question
from baros.security import hash_password
from baros.v2.domain import dump
from baros.v2.models import Account, CourseSettings, CourseRevision, SourceFile, VenueSettings, Exam
from baros.v2.domain import now
from datetime import timedelta

app = importlib.import_module('baros.v2.app').app
queries = []
def count_sql(connection, cursor, statement, parameters, context, many):
    queries.append(statement)
event.listen(engine, 'before_cursor_execute', count_sql)

with TestClient(app) as client:
    with SessionLocal() as db:
        orgs=[Organization(name='Тестовое заведение '+str(i)) for i in range(5)]
        db.add_all(orgs); db.flush(); oid=orgs[0].id
        db.add_all([VenueSettings(organization_id=o.id,join_code='TESTCODE'+str(i)) for i,o in enumerate(orgs)])
        password=hash_password('local-audit-password')
        db.add(Account(name='Тестовый владелец',login='perf.owner',role='owner',password_hash=password))
        db.add_all([Account(name='Тестовый сотрудник '+str(i),login='perf.staff.'+str(i),role='employee',
                            organization_id=oid,password_hash=password,positions_json='["bartender"]') for i in range(100)])
        for i in range(20):
            c=Course(organization_id=oid,title='Тестовый курс '+str(i),published=True)
            db.add(c); db.flush(); db.add(CourseSettings(course_id=c.id,version=1,quiz_size=10))
            lessons=[{'title':'Раздел '+str(n),'body':'Чай подают в чашке. Вода — 90 °C. '*100} for n in range(3)]
            questions=[{'prompt':'Тестовый вопрос '+str(n),'choices':['Чашка','Стакан','Бокал','Кружка'],
                        'correct_index':0,'explanation':'Чай подают в чашке.','type':'knowledge'} for n in range(30)]
            data={'title':c.title,'description':'Тест производительности','positions':['bartender'], 'lessons':lessons,
                  'questions':questions,'passing_score':80,'required':True,'quiz_size':10,'time_limit_minutes':15,
                  'max_attempts':0,'deadline_days':7,'due_at':None,'is_intro':False}
            db.add(CourseRevision(course_id=c.id,version=1,payload=dump(data)))
            db.add_all([Lesson(course_id=c.id,title=l['title'],body=l['body'],sort_order=n) for n,l in enumerate(lessons)])
            db.add_all([Question(course_id=c.id,prompt=q['prompt'],choices_json=dump(q['choices']),correct_index=0,
                                explanation=q['explanation'],question_type=q['type']) for q in questions])
        db.add_all([SourceFile(organization_id=oid,name='Тестовый файл '+str(i)+'.txt',mime='text/plain',size=1024*1024,
                              content=b'x'*(1024*1024),text='Подтверждённый текст. '*1000) for i in range(5)])
        db.commit()
    # Two completed attempts per employee/course: a populated history, not an empty dashboard.
    with SessionLocal() as db:
        from sqlalchemy import select
        people=db.scalars(select(Account).where(Account.organization_id==oid,Account.role=='employee')).all()
        versions=db.scalars(select(CourseRevision)).all();stamp=now()
        for person in people:
            for version in versions:
                from baros.v2.domain import parse
                payload=parse(version.payload)
                review=[dict(q,selected=1,correct=False) for q in payload['questions'][:10]]
                for attempt in range(2):
                    at=stamp-timedelta(hours=2-attempt)
                    db.add(Exam(id=f'perf-{person.id}-{version.id}-{attempt}',account_id=person.id,revision_id=version.id,questions_json=dump(payload['questions'][:10]),answers_json='{}',started_at=at-timedelta(seconds=120),expires_at=at+timedelta(minutes=5),finished_at=at,result_json=dump({'score':70+20*attempt,'passed':bool(attempt),'duration_seconds':120,'review':review})))
        db.commit()
    assert client.post('/api/auth/login' ,json={'login':'perf.owner','password':'local-audit-password'}).status_code==200
    headers={'x-organization-id':str(oid)}
    results={}
    for path in ['/api/reports/analytics','/api/reports/analytics/export?section=questions','/api/drafts','/api/staff','/api/courses','/api/venues','/api/sources','/api/export','/api/owner/catalog','/api/owner/catalog/courses/bar-02-classics','/api/owner/onboarding']:
        assert client.get(path,headers=headers).status_code==200
        samples=[]; counts=[]; transferred=0
        for _ in range(3):
            queries.clear(); start=time.perf_counter(); response=client.get(path,headers=headers)
            assert response.status_code==200, response.text[:100]
            samples.append((time.perf_counter()-start)*1000); counts.append(len(queries)); transferred=len(response.content)
        results[path]={'median_ms':round(statistics.median(samples),2),'sql_queries':max(counts),'response_bytes':transferred}
    catalog=client.get('/api/owner/catalog').json();csrf=client.get('/api/me').json()['csrf'];start=time.perf_counter()
    installed=client.post('/api/owner/catalog/activate',json={'reviewed':True,'fingerprint':catalog['fingerprint'],'expected_revision':0},headers={'x-csrf-token':csrf})
    assert installed.status_code==200, installed.text
    results['catalog_activation']={'elapsed_ms':round((time.perf_counter()-start)*1000,2),'courses_added':installed.json()['added'],'enrollments':installed.json()['enrollments']}
    assert client.post('/api/auth/login',json={'login':'perf.staff.0','password':'local-audit-password'}).status_code==200
    client.get('/api/me'); queries.clear(); start=time.perf_counter(); response=client.get('/api/learning')
    assert response.status_code==200
    results['/api/learning']={'elapsed_ms':round((time.perf_counter()-start)*1000,2),'sql_queries':len(queries),'assigned':response.json()['assigned']}
    print(json.dumps({'fixture':{'venues':5,'staff':100,'courses':20,'questions_per_course':30,'source_mb':5,'completed_attempts':4000},'results':results},ensure_ascii=False,indent=2))

event.remove(engine, 'before_cursor_execute', count_sql)
engine.dispose(); workspace.cleanup()
