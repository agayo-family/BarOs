"""Regressions for paid-pilot risks: source drift and publishable AI drafts."""
import asyncio
import copy
import importlib
import os
import tempfile
import unittest
from datetime import timedelta
from unittest.mock import patch

os.environ.setdefault('DATABASE_URL', 'sqlite:///' + tempfile.mktemp(prefix='baros-release-', suffix='.db'))
os.environ['BAROS_WORKER'] = '0'
from fastapi.testclient import TestClient
from baros.db import Base, engine, SessionLocal
from baros.models import Organization, Course, Lesson, Question
from baros.security import hash_password
from baros.v2.models import Account, VenueSettings, SourceFile, CourseSettings, CourseRevision, Job, Exam
from baros.v2.domain import dump, parse, now
from baros.v2 import ai

app = importlib.import_module('baros.v2.app').app
FACT = 'Сироп персика добавляют в объёме 20 мл.'
COURSE = {'title': 'Стандарт подачи', 'positions': ['bartender'], 'quiz_size': 1,
          'lessons': [{'title': 'Сироп', 'body': FACT}],
          'questions': [{'prompt': 'Какой объём сиропа персика указан в рецептуре?',
                         'choices': ['20 мл', '10 мл', '30 мл', '40 мл'], 'correct_index': 0,
                         'explanation': FACT, 'type': 'knowledge'}]}


class ReleaseReadinessTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine)
        self.client = TestClient(app)
        self.client.__enter__()
        with SessionLocal() as db:
            org = Organization(name='Изолированный пилот')
            db.add(org); db.flush(); self.oid = org.id
            db.add(VenueSettings(organization_id=org.id, join_code='RELEASETEST'))
            db.add(Account(organization_id=org.id, name='Управляющий', login='release.manager',
                           role='manager', password_hash=hash_password('release-test-password')))
            source = SourceFile(organization_id=org.id, name='Меню.txt', mime='text/plain',
                                size=len(FACT.encode()), content=FACT.encode(), text=FACT,
                                positions_json='["bartender"]', extraction_status='ready')
            db.add(source); db.commit(); self.sid = source.id
        self.assertEqual(self.client.post('/api/auth/login', json={
            'login': 'release.manager', 'password': 'release-test-password'}).status_code, 200)
        self.headers = {'x-csrf-token': self.client.get('/api/me').json()['csrf']}

    def tearDown(self):
        self.client.__exit__(None, None, None)

    def post(self, path, data):
        return self.client.post(path, json=data, headers=self.headers)

    def course(self, publish=True):
        r = self.post('/api/courses', COURSE)
        self.assertEqual(r.status_code, 200, r.text)
        cid = r.json()['id']
        with SessionLocal() as db:
            db.get(CourseSettings, cid).source_ids_json = dump([self.sid]); db.commit()
        if publish:
            self.assertEqual(self.post(f'/api/courses/{cid}/publish', {
                'edit_version': r.json()['edit_version'], 'reviewed': True}).status_code, 200)
        return cid

    def update_source(self, text):
        return self.client.put(f'/api/sources/{self.sid}', json={
            'text': text, 'positions': ['bartender']}, headers=self.headers)

    def test_source_update_flags_course_but_preserves_approved_revision(self):
        cid = self.course()
        with SessionLocal() as db:
            revision = db.query(CourseRevision).filter_by(course_id=cid, version=1).one()
            original = revision.payload
        r = self.update_source(FACT.replace('20', '25'))
        self.assertEqual(r.status_code, 200); self.assertEqual(r.json()['courses_to_review'], 1)
        self.assertTrue(self.client.get('/api/courses').json()[0]['source_review_required'])
        self.assertTrue(self.client.get(f'/api/courses/{cid}').json()['program']['source_review']['required'])
        with SessionLocal() as db:
            self.assertEqual(db.query(CourseRevision).filter_by(course_id=cid, version=1).one().payload, original)
            self.assertEqual(db.get(Course, cid).lessons[0].body, FACT)
        self.assertEqual(self.post(f'/api/courses/{cid}/publish', {'reviewed': False, 'edit_version': 2}).status_code, 400)
        self.assertTrue(self.client.get('/api/courses').json()[0]['source_review_required'])
        self.assertEqual(self.post(f'/api/courses/{cid}/publish', {'reviewed': True, 'edit_version': 2}).status_code, 200)
        self.assertFalse(self.client.get('/api/courses').json()[0]['source_review_required'])
        # A repeated acknowledgement can be unchanged, but it must still commit.
        self.update_source(FACT.replace('20', '30'))
        self.assertTrue(self.post(f'/api/courses/{cid}/publish', {'reviewed': True, 'edit_version': 2}).json()['unchanged'])
        self.assertFalse(self.client.get('/api/courses').json()[0]['source_review_required'])

    def test_identical_source_save_does_not_require_republication(self):
        self.course()
        self.assertEqual(self.update_source(FACT).json()['courses_to_review'], 0)
        self.assertFalse(self.client.get('/api/courses').json()[0]['source_review_required'])

    def test_delete_used_source_is_blocked_then_flags_without_deleting_course(self):
        cid = self.course()
        with SessionLocal() as db:
            db.add(Job(id='source-in-use', organization_id=self.oid, account_id=self.client.get('/api/me').json()['account']['id'],
                       context=FACT, source_ids_json=dump([self.sid]), positions_json='["bartender"]', status='queued')); db.commit()
        self.assertEqual(self.client.delete(f'/api/sources/{self.sid}', headers=self.headers).status_code, 409)
        with SessionLocal() as db:
            db.get(Job, 'source-in-use').status = 'failed'; db.commit()
        r = self.client.delete(f'/api/sources/{self.sid}', headers=self.headers)
        self.assertEqual(r.status_code, 200); self.assertEqual(r.json()['courses_to_review'], 1)
        detail = self.client.get(f'/api/courses/{cid}').json()
        self.assertTrue(detail['published']); self.assertTrue(detail['source_review_required'])
        self.assertEqual(detail['lessons'][0]['body'], FACT)

    def test_invalid_legacy_question_or_lesson_cannot_publish_or_cause_500(self):
        for kind in ['question', 'lesson']:
            with self.subTest(kind=kind):
                cid = self.course(False)
                with SessionLocal() as db:
                    c = db.get(Course, cid)
                    if kind == 'question': c.questions[0].choices_json = dump(['Same'] * 4)
                    else: c.lessons[0].body = ''
                    db.commit()
                result = self.post(f'/api/courses/{cid}/publish', {'reviewed': True, 'edit_version': 2})
                self.assertEqual(result.status_code, 409, result.text)
                with SessionLocal() as db: self.assertFalse(db.get(Course, cid).published)

    def test_ai_target_is_proportional_and_explicit_target_is_validated(self):
        self.assertLess(ai.question_target(FACT), 100)
        self.assertEqual(ai.question_target('x' * 90000), 360)
        with patch.object(ai, 'provider', return_value={'model': 'synthetic-test-only'}):
            result = self.post('/api/jobs', {'source_ids': [self.sid], 'positions': ['bartender'], 'question_target': 10})
        self.assertEqual(result.status_code, 200, result.text); self.assertEqual(result.json()['target'], 10)
        self.assertEqual(self.post('/api/jobs', {'question_target': 401}).status_code, 422)

    def test_short_grounded_ai_result_stops_and_manager_can_publish_reviewed_bank(self):
        aid = self.client.get('/api/me').json()['account']['id']
        with SessionLocal() as db:
            db.add(Job(id='bounded-test', organization_id=self.oid, account_id=aid, context=FACT,
                       positions_json='["bartender"]', target=100, status='running', lease_token='test-lease'))
            db.commit()
        calls = []
        async def answer(prompt, *args):
            calls.append(prompt)
            if len(calls) == 1:
                return {'title': 'Сироп', 'description': '', 'lessons': COURSE['lessons'], 'limitations': []}
            return {'questions': [{**COURSE['questions'][0], 'source_quote': FACT, 'lesson_index': 0}],
                    'limitations': ['В источнике только один независимый проверяемый факт.']}
        with patch.object(ai, 'call_model', new=answer):
            asyncio.run(ai.run_job('bounded-test', 'test-lease'))
        self.assertEqual(len(calls), 2, 'Do not pay for repeated attempts to invent more facts')
        with SessionLocal() as db:
            job = db.get(Job, 'bounded-test'); self.assertEqual(job.status, 'needs_review')
            cid = job.course_id; self.assertEqual(db.get(CourseSettings, cid).quiz_size, 1)
        self.assertEqual(self.post(f'/api/courses/{cid}/publish', {'reviewed': True, 'edit_version': 1}).status_code, 200)

    def test_generation_started_before_source_edit_is_marked_for_review(self):
        from baros.v2.source_review import fingerprint
        aid = self.client.get('/api/me').json()['account']['id']
        with SessionLocal() as db:
            before = fingerprint(db.get(SourceFile, self.sid))
            job = Job(id='source-drift', organization_id=self.oid, account_id=aid, context=FACT,
                      source_ids_json=dump([self.sid]), positions_json='["bartender"]', target=1)
            db.add(job); db.flush()
            db.get(SourceFile, self.sid).text = FACT.replace('20', '25')
            ai.persist_course(db, job, {'title': 'До изменения', 'lessons': COURSE['lessons'],
                                      'questions': [], 'source_fingerprints': {str(self.sid): before}})
            db.commit(); cid = job.course_id
        self.assertTrue(self.client.get(f'/api/courses/{cid}').json()['source_review_required'])

    def test_gaps_use_latest_current_revision_and_do_not_inflate_reattempt_errors(self):
        cid = self.course()
        with SessionLocal() as db:
            rev = db.query(CourseRevision).filter_by(course_id=cid, version=1).one()
            learners=[]
            for i in range(2):
                e=Account(organization_id=self.oid,name='Сотрудник '+str(i),login='gap.worker'+str(i),
                          role='employee',positions_json='["bartender"]',password_hash=hash_password('release-test-password'))
                db.add(e);db.flush();learners.append(e)
            for i,(learner,correct,minutes) in enumerate([(learners[0],False,10),(learners[0],True,1),(learners[1],False,2)]):
                result={'review':[{'prompt':COURSE['questions'][0]['prompt'],'correct':correct,'explanation':FACT}]}
                db.add(Exam(id='gap-'+str(i),account_id=learner.id,revision_id=rev.id,
                            questions_json='[]',answers_json='{}',started_at=now()-timedelta(minutes=minutes+1),
                            expires_at=now()+timedelta(minutes=30),finished_at=now()-timedelta(minutes=minutes),result_json=dump(result)))
            db.commit()
        r=self.client.get('/api/reports/knowledge-gaps')
        self.assertEqual(r.status_code,200);data=r.json();self.assertEqual(data['latest_attempts'],2)
        self.assertEqual(data['affected_employees'],1);self.assertEqual(len(data['gaps']),1)
        gap=data['gaps'][0];self.assertEqual(gap['reviewed'],2);self.assertEqual(gap['mistakes'],1)
        self.assertEqual(gap['employees'][0]['name'],'Сотрудник 1');self.assertEqual(gap['explanation'],FACT)
        self.client.cookies.clear()
        self.client.post('/api/auth/login',json={'login':'gap.worker0','password':'release-test-password'})
        self.assertEqual(self.client.get('/api/reports/knowledge-gaps').status_code,403)

    def test_invalid_setup_payload_is_rejected_before_password_processing(self):
        for changes in [{'password':123456789012345},{'login':'spaces are invalid'},{'name':' '}]:
            data={'token':'test-token','login':'valid.owner','name':'Владелец','password':'release-test-password',**changes}
            self.assertEqual(self.client.post('/api/auth/setup',json=data).status_code,422)
        self.assertEqual(self.client.post('/api/auth/setup',json={
            'token':'неверный ключ','login':'valid.owner','name':'Владелец','password':'release-test-password'}).status_code,403)


if __name__ == '__main__':
    unittest.main()
