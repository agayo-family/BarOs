"""Owner approval, tenant copies and human-reviewed written practice."""
from datetime import timedelta
import copy
import importlib
import os
import re
import tempfile
import unittest
from unittest.mock import patch
os.environ.setdefault('DATABASE_URL','sqlite:///'+tempfile.mktemp(prefix='baros-catalog-',suffix='.db'))
os.environ['BAROS_WORKER']='0'
from fastapi.testclient import TestClient
from sqlalchemy import select, func
from baros.db import Base, engine, SessionLocal
from baros.models import Organization, Course
from baros.security import hash_password
from baros.v2.models import Account, CourseProgram, CourseRevision, ImportedAssessment, Notice, Setting, VenueSettings, WrittenAttempt
from baros.v2.domain import dump, parse, now
from baros.v2.packages import AssessmentIn
from baros.v2 import catalog
app=importlib.import_module('baros.v2.app').app

class CatalogTests(unittest.TestCase):
 def setUp(self):
  Base.metadata.drop_all(engine);self.client=TestClient(app);self.client.__enter__()
  password=hash_password('catalog-test-password')
  with SessionLocal() as db:
   org=Organization(name='На, стой-ка');other=Organization(name='Other venue');db.add_all([org,other]);db.flush();self.oid=org.id;self.other=other.id
   for o in [org,other]:db.add(VenueSettings(organization_id=o.id,join_code='CATALOG'+str(o.id)))
   for login,role,oid,positions in [('owner','owner',None,[]),('manager','manager',org.id,[]),('worker','employee',org.id,['waiter']),('hookah','employee',org.id,['hookah_master']),('cleaner','employee',org.id,['cleaner']),('foreign','manager',other.id,[])]:
    db.add(Account(name=login,login=login,role=role,organization_id=oid,positions_json=dump(positions),password_hash=password))
   db.add(Course(organization_id=org.id,title='Существующий персональный курс',published=False));db.commit()
  self.login('owner')
  self.catalog_count=len(catalog.candidate()['courses'])
  self.role_counts={role:sum(c['role']==role for c in catalog.candidate()['courses']) for role in catalog.candidate()['roles']}
 def tearDown(self):self.client.__exit__(None,None,None)
 def login(self,name):
  self.client.cookies.clear();r=self.client.post('/api/auth/login',json={'login':name,'password':'catalog-test-password'});self.assertEqual(r.status_code,200,r.text)
  self.headers={'x-csrf-token':self.client.get('/api/me').json()['csrf']}
 def post(self,path,data):return self.client.post(path,json=data,headers=self.headers)
 def activate(self):
  c=self.client.get('/api/owner/catalog').json();r=self.post('/api/owner/catalog/activate',{'reviewed':True,'fingerprint':c['fingerprint'],'expected_revision':c['revision']});self.assertEqual(r.status_code,200,r.text);return r.json()
 def seed_written(self):
  data=AssessmentIn.model_validate({'title':'Отдельный письменный тест','positions':['waiter'],
   'sections':[{'id':'service','title':'Сервис'}], 'tasks':[
    {'id':key,'section_id':'service','kind':'written','prompt':prompt,'points':3,
     'rubric':[{'id':'facts','label':'Факты и следующий шаг','points':3,'guidance':'Проверены обстоятельства и предложено выполнимое действие.'}]}
    for key,prompt in [('case1','Как согласовать решение при задержке блюда?'),('case2','Как уточнить состав до подтверждения заказа?')]]})
  with SessionLocal() as db:
   a=ImportedAssessment(organization_id=self.oid,title=data.title,payload=dump(data.model_dump(mode='json')),published=True)
   db.add(a);db.flush();aid=a.id;db.commit();return aid
 def test_complete_original_content_and_readonly_preview(self):
  c=self.client.get('/api/owner/catalog').json();self.assertFalse(c['enabled']);self.assertEqual(len(c['courses']),self.catalog_count);self.assertEqual(set(c['roles']),{'bartender','waiter','administrator','hookah_master','cook','cleaner'})
  for role in c['roles']:self.assertGreaterEqual(sum(x['role']==role for x in c['courses']),3)
  prompts=set()
  for item in c['courses']:
   full=self.client.get('/api/owner/catalog/courses/'+item['key']).json()
   self.assertNotIn('practice',full)
   if full['version']>=2:
    self.assertGreaterEqual(len(full['course']['lessons']),8);self.assertEqual(len(full['course']['questions']),40)
    self.assertGreaterEqual(sum(len(l['body'].split()) for l in full['course']['lessons']),1800)
    self.assertEqual(full['course']['quiz_size'],30)
   for l in full['course']['lessons']:
    self.assertGreater(len(l['body'].split()),40)
    self.assertIsNone(re.search(r'(?mi)^##\s*(?:Задание|Практика|Практическая проверка|Домашнее)\b',l['body']))
   for q in full['course']['questions']:
    self.assertEqual(len(set(q['choices'])),4);self.assertTrue(0<=q['correct_index']<4);self.assertNotIn(q['prompt'],prompts);prompts.add(q['prompt'])
  with SessionLocal() as db:self.assertEqual(db.scalar(select(func.count(Course.id))),1);self.assertEqual(db.scalar(select(func.count(ImportedAssessment.id))),0)
 def test_review_revision_fingerprint_csrf_and_owner_guards(self):
  c=self.client.get('/api/owner/catalog').json();data={'reviewed':False,'fingerprint':c['fingerprint'],'expected_revision':0}
  self.assertEqual(self.post('/api/owner/catalog/activate',data).status_code,400)
  data.update(reviewed=True,fingerprint='0'*64);self.assertEqual(self.post('/api/owner/catalog/activate',data).status_code,409)
  data.update(fingerprint=c['fingerprint'],expected_revision=1);self.assertEqual(self.post('/api/owner/catalog/activate',data).status_code,409)
  data['expected_revision']=0;self.assertEqual(self.client.post('/api/owner/catalog/activate',json=data).status_code,403)
  for name in ['manager','worker']:
   self.login(name);self.assertEqual(self.client.get('/api/owner/catalog').status_code,403);self.assertEqual(self.post('/api/owner/catalog/activate',data).status_code,403)
 def test_atomic_install_no_ai_idempotent_and_independent_copies(self):
  with patch('baros.v2.ai.call_model') as ai:
   r=self.activate();self.assertEqual(r['added'],2*self.catalog_count);self.assertEqual(r['enrollments'],sum(self.role_counts[r] for r in ['waiter','hookah_master','cleaner']));ai.assert_not_called()
  with SessionLocal() as db:
   copies=db.scalars(select(Course).where(Course.title==catalog.candidate()['courses'][0]['course']['title'])).all();self.assertEqual(len(copies),2)
   copies[0].lessons[0].body='Локальная правка';cid=copies[0].id;unchanged=copies[1].lessons[0].body
   before=db.scalar(select(func.count(Notice.id)));db.commit()
  r=self.activate();self.assertEqual(r['added'],0);self.assertEqual(r['existing'],2*self.catalog_count)
  with SessionLocal() as db:
   self.assertEqual(db.get(Course,cid).lessons[0].body,'Локальная правка');self.assertEqual(db.get(Course,copies[1].id).lessons[0].body,unchanged)
   self.assertEqual(db.scalar(select(func.count(Notice.id))),before);self.assertEqual(db.scalar(select(func.count(ImportedAssessment.id))),0)
   self.assertEqual(db.scalar(select(func.count(CourseRevision.id))),2*self.catalog_count)
   self.assertEqual(db.scalar(select(func.count(Course.id)).where(Course.title=='Существующий персональный курс')),1)
 def test_new_venue_uses_approved_snapshot_and_pause_keeps_history(self):
  self.activate();changed=copy.deepcopy(catalog.candidate());changed['courses'][0]['course']['title']='Неутверждённая редакция'
  with patch.object(catalog,'candidate',return_value=changed):
   v=self.post('/api/venues',{'name':'Future venue'}).json()
  with SessionLocal() as db:
   titles=db.scalars(select(Course.title).where(Course.organization_id==v['id'])).all();self.assertEqual(len(titles),self.catalog_count);self.assertNotIn('Неутверждённая редакция',titles)
  self.assertEqual(self.post('/api/owner/catalog/pause',{'expected_revision':1}).status_code,200)
  new=self.post('/api/venues',{'name':'Paused future venue'}).json()
  with SessionLocal() as db:
   self.assertEqual(db.scalar(select(func.count(Course.id)).where(Course.organization_id==new['id'])),0)
   self.assertEqual(db.scalar(select(func.count(CourseRevision.id))),3*self.catalog_count)
 def test_failure_rolls_back_all_venues_and_approval(self):
  original=catalog.install_snapshot;calls=[]
  def fail(db,oid,approved,by,previous=None):
   calls.append(oid)
   if len(calls)==2:raise RuntimeError('simulated interruption')
   return original(db,oid,approved,by,previous=previous)
  with patch.object(catalog,'install_snapshot',side_effect=fail):
   with self.assertRaises(RuntimeError):self.activate()
  with SessionLocal() as db:
   self.assertFalse(parse(db.get(Setting,catalog.STATE_KEY).value).get('enabled'));self.assertEqual(db.scalar(select(func.count(Course.id))),1);self.assertEqual(db.scalar(select(func.count(ImportedAssessment.id))),0)
 def test_role_assignment_written_answers_manual_review_and_tenant_isolation(self):
  self.activate();aid=self.seed_written();self.login('worker');learning=self.client.get('/api/learning').json()['courses'];self.assertEqual(len(learning),self.role_counts['waiter'])
  cid=learning[0]['id'];course=self.client.get(f'/api/learning/{cid}').json();self.assertNotIn('written_assessment_id',course['program'])
  r=self.post(f'/api/assessments/{aid}/start',{});self.assertEqual(r.status_code,200,r.text);attempt=r.json();self.assertEqual(len(attempt['tasks']),2)
  self.assertNotIn('rubric',dump(attempt));self.assertNotIn('correct_index',dump(attempt));self.assertTrue(all(t['choices']==[] for t in attempt['tasks']))
  answers={t['id']:'Уточню ожидание и проверю доступные решения. Согласую с гостем следующий шаг и вернусь в обещанное время.' for t in attempt['tasks']}
  r=self.client.put('/api/assessment-attempts/'+attempt['id'],json={'version':attempt['version'],'answers':answers},headers=self.headers);self.assertEqual(r.status_code,200,r.text)
  attempt=self.post('/api/assessment-attempts/'+attempt['id']+'/submit',{'version':r.json()['version']}).json();self.assertEqual(attempt['status'],'submitted');self.assertIsNone(attempt['result'])
  rid=attempt['id'];self.assertEqual(next(x for x in self.client.get('/api/assessments').json() if x['id']==aid)['latest_attempt']['status'],'submitted');self.login('foreign');self.assertEqual(self.client.get('/api/assessment-attempts/'+rid).status_code,404)
  self.login('manager');self.assertEqual(next(x for x in self.client.get('/api/assessments').json() if x['id']==aid)['awaiting_review'],1);a=self.client.get('/api/assessment-attempts/'+rid).json();grades={t['id']:{x['id']:x['points'] for x in t['rubric']} for t in a['tasks']}
  r=self.post('/api/assessment-attempts/'+rid+'/review',{'version':a['version'],'grades':grades,'feedback':{t['id']:'Обоснованный вариант решения принят.' for t in a['tasks']}});self.assertEqual(r.status_code,200,r.text);self.assertEqual(r.json()['result']['percent'],100)
  self.login('worker');a=self.client.get('/api/assessment-attempts/'+rid).json();self.assertEqual(a['status'],'graded');self.assertEqual(a['answers'],answers);self.assertNotIn('rubric',dump(a));self.assertEqual(a['result']['percent'],100)
  for name in ['hookah','cleaner']:
   self.login(name);self.assertEqual(len(self.client.get('/api/learning').json()['courses']),self.role_counts['hookah_master' if name=='hookah' else 'cleaner']);self.assertEqual(len(self.client.get('/api/assessments').json()),0)
 def test_onboarding_tracks_actual_counts_and_excludes_platform(self):
  r=self.client.get('/api/owner/onboarding');self.assertEqual(r.status_code,200);data=r.json();self.assertEqual(len(data['venues']),2)
  v=next(x for x in data['venues'] if x['id']==self.oid);self.assertEqual(v['managers'],1);self.assertEqual(v['employees'],3);self.assertEqual(v['courses'],0);self.assertTrue(v['access_ready'])

 def test_expired_written_work_is_visible_in_review_queue(self):
  self.activate();aid=self.seed_written();self.login('worker');work=self.post(f'/api/assessments/{aid}/start',{}).json()
  with SessionLocal() as db:db.get(WrittenAttempt,work['id']).expires_at=now()-timedelta(seconds=1);db.commit()
  self.assertEqual(next(x for x in self.client.get('/api/assessments').json() if x['id']==aid)['latest_attempt']['status'],'submitted')
  self.login('manager');self.assertEqual(next(x for x in self.client.get('/api/assessments').json() if x['id']==aid)['awaiting_review'],1)
  self.assertEqual(self.client.get('/api/assessment-attempts/'+work['id']).json()['status'],'submitted')
