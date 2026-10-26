"""Standard-library upgrades preserve venue edits and immutable learning history."""
import copy
import importlib
import os
import tempfile
import unittest
from unittest.mock import patch
os.environ.setdefault('DATABASE_URL', 'sqlite:///' + tempfile.mktemp(prefix='baros-upgrades-', suffix='.db'))
os.environ['BAROS_WORKER'] = '0'
from fastapi.testclient import TestClient
from sqlalchemy import select, func
from baros.db import Base, engine, SessionLocal
from baros.models import Organization, Course
from baros.security import hash_password
from baros.v2.models import (Account, CourseProgram, CourseRevision, CourseSettings,
    Enrollment, ImportedAssessment, Notice, Setting, VenueSettings)
from baros.v2.domain import dump, parse
from baros.v2 import catalog
from baros.v2.content import save_course
from baros.v2.schemas import CourseIn
app = importlib.import_module('baros.v2.app').app


def release(version=1, practice=False):
    course = CourseIn(title='Общий курс сервиса', description='Проверяемая версия общего курса',
        positions=['waiter'], quiz_size=1,
        lessons=[{'title':'Точный заказ','body':'Сверьте согласованные изменения перед подачей.'}],
        questions=[{'prompt':'Что сверяют перед подачей?', 'choices':['Заказ и изменения','Только цвет','Только время','Только номер'],
            'correct_index':0, 'explanation':'Изменения должны соответствовать согласованному заказу.'}]).model_dump(mode='json')
    if version > 1:
        course['lessons'][0]['body'] = 'Расширенная версия: подтвердите модификатор, адресата и согласованный порядок подачи.'
    item = {'key':'waiter-fixture','role':'waiter','version':version,'outcomes':[], 'sources':[], 'course':course}
    if practice:
        item['practice'] = {'title':'Сохранённая письменная ситуация', 'positions':['waiter'],
            'sections':[{'id':'service','title':'Сервис'}],
            'tasks':[{'id':'delay','section_id':'service','kind':'written','prompt':'Как вы уточните ожидание гостя при задержке?', 'points':3,
                'rubric':[{'id':'facts','label':'Уточнение фактов','points':3,'guidance':'Ответ содержит уточнение статуса и ожидания.'}]}]}
    return {'enabled':True,'fingerprint':str(version)*64,'version':'fixture-'+str(version),
        'roles':['waiter'],'courses':[item]}


class CatalogUpgradeTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine)
        self.client = TestClient(app); self.client.__enter__()
        with SessionLocal() as db:
            org=Organization(name='Upgrade venue'); db.add(org); db.flush(); self.oid=org.id
            db.add(VenueSettings(organization_id=org.id,join_code='UPGRADE1'))
            owner=Account(name='Owner',login='upgrade-owner',role='owner',password_hash=hash_password('upgrade-test-password'))
            worker=Account(name='Worker',login='upgrade-worker',role='employee',organization_id=org.id,
                positions_json=dump(['waiter']),password_hash=hash_password('upgrade-test-password'))
            db.add_all([owner,worker]); db.flush(); self.worker=worker.id; db.commit()
        r=self.client.post('/api/auth/login',json={'login':'upgrade-owner','password':'upgrade-test-password'})
        self.assertEqual(r.status_code,200,r.text)
        self.headers={'x-csrf-token':self.client.get('/api/me').json()['csrf']}

    def tearDown(self):
        self.client.__exit__(None,None,None)

    def install(self, approved, previous=None):
        with SessionLocal() as db:
            result=catalog.install_snapshot(db,self.oid,approved,previous=previous); db.commit()
            c=db.scalar(select(Course).where(Course.organization_id==self.oid))
            self.cid=c.id if c else None
            return result

    def test_untouched_copy_gets_new_revision_and_old_history_is_immutable(self):
        old=release(); self.assertEqual(self.install(old)['added'],1)
        with SessionLocal() as db:
            before=db.scalar(select(CourseRevision)); old_id=before.id; old_payload=before.payload
            old_enrollment=db.scalar(select(Enrollment)); enrollment_id=old_enrollment.id
        r=self.install(release(2),previous=old)
        self.assertEqual((r['added'],r['updated'],r['enrollments']),(0,1,1))
        with SessionLocal() as db:
            self.assertEqual(db.get(CourseRevision,old_id).payload,old_payload)
            self.assertEqual(db.get(Enrollment,enrollment_id).revision_id,old_id)
            self.assertEqual(db.scalar(select(func.count(Course.id))),1)
            self.assertEqual(db.scalar(select(func.count(CourseRevision.id))),2)
            self.assertEqual(db.scalar(select(func.count(Enrollment.id))),2)
            self.assertEqual(db.get(CourseSettings,self.cid).version,2)
            self.assertIn('Расширенная версия',db.get(Course,self.cid).lessons[0].body)
        repeat=self.install(release(2),previous=release(2))
        self.assertEqual((repeat['updated'],repeat['existing'],repeat['enrollments']),(0,1,0))
        with SessionLocal() as db:self.assertEqual(db.scalar(select(func.count(Notice.id))),2)

    def test_legacy_provenance_uses_previously_approved_snapshot(self):
        old=release(); self.install(old)
        with SessionLocal() as db:
            p=db.get(CourseProgram,self.cid); meta=parse(p.payload)
            meta['standard_catalog'].pop('content_fingerprint'); meta['standard_catalog'].pop('version')
            p.payload=dump(meta); db.commit()
        self.assertEqual(self.install(release(2),previous=old)['updated'],1)

    def test_legacy_copy_without_verifiable_previous_snapshot_is_preserved(self):
        self.install(release())
        with SessionLocal() as db:
            p=db.get(CourseProgram,self.cid);meta=parse(p.payload);meta['standard_catalog'].pop('content_fingerprint')
            p.payload=dump(meta);db.commit()
        self.assertEqual(self.install(release(2))['customized'],1)
        with SessionLocal() as db:self.assertEqual(db.get(CourseSettings,self.cid).version,1)

    def test_local_draft_change_is_not_overwritten(self):
        old=release();self.install(old)
        with SessionLocal() as db:
            c=db.get(Course,self.cid);data=CourseIn.model_validate(old['courses'][0]['course'])
            data.title='Локальный заголовок';save_course(db,c,data);db.commit()
        self.assertEqual(self.install(release(2),previous=old)['customized'],1)
        with SessionLocal() as db:
            self.assertEqual(db.get(Course,self.cid).title,'Локальный заголовок')
            self.assertEqual(db.scalar(select(func.count(CourseRevision.id))),1)

    def test_local_published_change_is_not_overwritten_even_if_draft_matches_original(self):
        old=release();self.install(old)
        with SessionLocal() as db:
            rev=db.scalar(select(CourseRevision));data=parse(rev.payload);data['description']='Локально опубликованное уточнение'
            rev.payload=dump(data);db.commit()
        self.assertEqual(self.install(release(2),previous=old)['customized'],1)

    def test_archived_or_unpublished_copy_is_not_reactivated(self):
        old=release();self.install(old)
        with SessionLocal() as db:db.get(CourseSettings,self.cid).archived=True;db.commit()
        self.assertEqual(self.install(release(2),previous=old)['customized'],1)
        with SessionLocal() as db:
            db.get(CourseSettings,self.cid).archived=False;db.get(Course,self.cid).published=False;db.commit()
        self.assertEqual(self.install(release(2),previous=old)['customized'],1)
        with SessionLocal() as db:self.assertFalse(db.get(Course,self.cid).published)

    def test_upgrade_detaches_old_homework_without_deleting_it_or_old_revision_link(self):
        old=release(practice=True);self.install(old)
        with SessionLocal() as db:
            p=db.get(CourseProgram,self.cid);aid=parse(p.payload)['written_assessment_id']
            revision=db.scalar(select(CourseRevision));rid=revision.id
        self.assertEqual(self.install(release(2),previous=old)['updated'],1)
        with SessionLocal() as db:
            self.assertNotIn('written_assessment_id',parse(db.get(CourseProgram,self.cid).payload))
            self.assertIsNotNone(db.get(ImportedAssessment,aid))
            self.assertEqual(parse(db.get(CourseRevision,rid).payload)['program']['written_assessment_id'],aid)
            self.assertEqual(db.scalar(select(func.count(ImportedAssessment.id))),1)

    def test_inactive_venue_gets_content_without_new_assignments(self):
        old=release();self.install(old)
        with SessionLocal() as db:db.get(VenueSettings,self.oid).status='suspended';db.commit()
        r=self.install(release(2),previous=old)
        self.assertEqual((r['updated'],r['enrollments']),(1,0))

    def test_deployment_preview_does_not_change_approved_content_or_future_copies(self):
        old=release();self.install(old)
        with SessionLocal() as db:
            row=db.get(Setting,catalog.STATE_KEY);row.value=dump({**old,'revision':1});db.commit()
        with patch.object(catalog,'candidate',return_value=release(2)):
            view=self.client.get('/api/owner/catalog').json()
            self.assertNotEqual(view['approved_fingerprint'],view['fingerprint'])
            r=self.client.post('/api/venues',json={'name':'Future approved copy'},headers=self.headers)
            self.assertEqual(r.status_code,200,r.text)
        with SessionLocal() as db:
            future=db.scalar(select(Course).where(Course.organization_id==r.json()['id']))
            self.assertEqual(future.lessons[0].body,old['courses'][0]['course']['lessons'][0]['body'])

    def test_global_upgrade_failure_rolls_back_first_venue_and_approval(self):
        old=release();self.install(old)
        with SessionLocal() as db:
            row=db.get(Setting,catalog.STATE_KEY);row.value=dump({**old,'revision':1})
            org=Organization(name='Second upgrade venue');db.add(org);db.flush()
            db.add(VenueSettings(organization_id=org.id,join_code='UPGRADE2'));db.commit()
        original=catalog.install_snapshot; calls=[]
        def fail(db,oid,approved,by=None,previous=None):
            calls.append(oid)
            if len(calls)==2:raise RuntimeError('interruption after first upgrade')
            return original(db,oid,approved,by,previous=previous)
        new=release(2)
        with patch.object(catalog,'candidate',return_value=new),patch.object(catalog,'install_snapshot',side_effect=fail):
            with self.assertRaises(RuntimeError):self.client.post('/api/owner/catalog/activate',json={
                'reviewed':True,'fingerprint':new['fingerprint'],'expected_revision':1},headers=self.headers)
        with SessionLocal() as db:
            self.assertEqual(db.get(CourseSettings,self.cid).version,1)
            self.assertEqual(db.get(Course,self.cid).lessons[0].body,old['courses'][0]['course']['lessons'][0]['body'])
            self.assertEqual(parse(db.get(Setting,catalog.STATE_KEY).value)['fingerprint'],old['fingerprint'])
            self.assertEqual(db.scalar(select(func.count(CourseRevision.id))),1)
