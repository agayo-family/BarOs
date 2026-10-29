"""Manual draft safety, written completion and per-device delivery regressions."""
import copy,os,unittest
from datetime import timedelta
from unittest.mock import patch
import test_packages as fixtures
from sqlalchemy import select
from baros.db import SessionLocal
from baros.models import Course
from baros.v2.models import SourceFile,ImportedAssessment,WrittenAttempt,CourseSettings,CourseProgram,LessonRead,CourseRevision,Notice,PushSubscription,PushDelivery
from baros.v2.domain import dump,parse,now
from baros.v2.push_delivery import deliver
from baros.v2.readiness import content_key

class ReviewWorkspaceTests(unittest.TestCase):
 setUp=fixtures.PackageTests.setUp
 tearDown=fixtures.PackageTests.tearDown
 login=fixtures.PackageTests.login
 post=fixtures.PackageTests.post
 import_=fixtures.PackageTests.import_
 def source(self):
  with SessionLocal() as db:
   s=SourceFile(organization_id=self.oid,name='Меню.txt',mime='text/plain',size=50,text='По карте добавляют 20 мл сиропа.',content=b'menu',positions_json='["bartender"]');db.add(s);db.flush();sid=s.id;db.commit();return sid
 def test_manual_workspace_import_is_unpublished_source_linked_and_offline(self):
  sid=self.source()
  with patch.dict(os.environ,{'BAROS_AI_ENABLED':'0'}),patch('baros.v2.ai.call_model') as model:
   export=self.post('/api/drafts/materials',{'source_ids':[sid]});self.assertEqual(export.status_code,200);self.assertIn('20 мл',export.json()['text'])
   r=self.post('/api/packages/import',{'package':fixtures.COURSE,'source_ids':[sid]});self.assertEqual(r.status_code,200,r.text);cid=r.json()['id'];items=self.client.get('/api/drafts').json()['items'];self.assertEqual(items[0]['sources'][0]['id'],sid)
   self.assertFalse(self.client.get(f'/api/courses/{cid}').json()['published']);self.assertEqual(self.post('/api/jobs',{'source_ids':[sid]}).status_code,409);model.assert_not_called()
  self.login('worker');self.assertEqual(self.client.get('/api/learning').json()['assigned'],0);self.assertEqual(self.client.get('/api/drafts').status_code,403)
 def test_blank_test_cannot_publish_and_foreign_source_is_denied(self):
  r=self.post('/api/assessments',{'title':'Новый тест','positions':['bartender']});self.assertEqual(r.status_code,200);aid=r.json()['id'];self.assertEqual(self.post(f'/api/assessments/{aid}/publish',{'reviewed':True}).status_code,409)
  sid=self.source();self.login('foreign');self.assertEqual(self.post('/api/drafts/materials',{'source_ids':[sid]}).status_code,404)
 def test_written_course_link_completion_archive_guard_and_current_content(self):
  aid=self.import_();self.assertEqual(self.post(f'/api/assessments/{aid}/publish',{'reviewed':True}).status_code,200)
  course=copy.deepcopy(fixtures.COURSE);course['course'].update(quiz_size=0,questions=[]);cid=self.import_(course);c=self.client.get(f'/api/courses/{cid}').json()
  self.assertEqual(self.post(f'/api/courses/{cid}/publish',{'reviewed':True,'edit_version':c['edit_version']}).status_code,409)
  r=self.client.put(f'/api/drafts/courses/{cid}/assessment',json={'assessment_id':aid,'edit_version':c['edit_version']},headers=self.headers);self.assertEqual(r.status_code,200,r.text)
  self.assertEqual(self.post(f'/api/courses/{cid}/publish',{'reviewed':True,'edit_version':r.json()['edit_version']}).status_code,200)
  self.assertEqual(self.post(f'/api/assessments/{aid}/archive',{}).status_code,409)
  self.login('worker')
  with patch('baros.v2.learning.MIN_READ_SECONDS',0):self.assertEqual(self.post(f'/api/learning/{cid}/lessons/0',{'complete':True}).status_code,200)
  self.assertEqual(self.post(f'/api/learning/{cid}/exam',{}).status_code,409)
  s=self.client.get('/api/learning').json();self.assertEqual(s['learning_total'],1);self.assertEqual(s['learning_completed'],0)
  with SessionLocal() as db:
   t=db.get(ImportedAssessment,aid);p=parse(t.payload)
   db.add(WrittenAttempt(id='graded-course',organization_id=self.oid,assessment_id=aid,account_id=self.ids['worker'],snapshot=t.payload,answers=dump({'q1':p['tasks'][0]['correct_index']}),grades=dump({'q2':{'scores':{'plan':50,'cost':30}}}),status='graded',expires_at=now(),submitted_at=now(),graded_at=now()));db.commit()
  s=self.client.get('/api/learning').json();self.assertEqual(s['learning_completed'],1);self.assertTrue(s['courses'][0]['learning_complete'])
  # A genuinely new test revision cannot inherit the old successful result.
  with SessionLocal() as db:
   t=db.get(ImportedAssessment,aid);p=parse(t.payload);p['tasks'][1]['prompt']='Опишите обновлённый план.';t.payload=dump(p);db.commit()
  self.assertEqual(self.client.get('/api/learning').json()['learning_completed'],0)
 def test_material_rebinding_keeps_review_flag_after_removing_all_sources(self):
  sid=self.source();r=self.post('/api/packages/import',{'package':fixtures.PACKAGE,'source_ids':[sid]});aid=r.json()['id'];self.post(f'/api/assessments/{aid}/publish',{'reviewed':True})
  with SessionLocal() as db:db.get(SourceFile,sid).text='По новой карте 25 мл.';db.commit()
  item=self.client.get('/api/drafts').json()['items'][0];self.assertTrue(item['source_review_required'])
  body={'kind':'assessment','resource_id':aid,'source_ids':[],'origin_version':item['origin_version']}
  r=self.client.put('/api/drafts/sources',json=body,headers=self.headers);self.assertEqual(r.status_code,200,r.text)
  self.assertEqual(self.client.put('/api/drafts/sources',json=body,headers=self.headers).status_code,409)
  self.assertTrue(self.client.get('/api/drafts').json()['items'][0]['source_review_required']);self.post(f'/api/assessments/{aid}/publish',{'reviewed':True});self.assertEqual(self.client.get('/api/drafts').json()['items'],[])
 def test_choice_shuffle_does_not_change_assessment_content_identity(self):
  p=copy.deepcopy(fixtures.PACKAGE['assessment']);q=copy.deepcopy(p);q['tasks'][0]['choices'].reverse();q['tasks'][0]['correct_index']=3;self.assertEqual(content_key(p),content_key(q))
  q['tasks'][0]['prompt']='Другая температура?';self.assertNotEqual(content_key(p),content_key(q))
 def test_push_retries_only_failed_device_and_permanent_expiry_removes_it(self):
  with SessionLocal() as db:
   n=Notice(account_id=self.ids['worker'],event_key='retry-test',title='Проверка',body='Новый курс');db.add(n);db.flush();nid=n.id
   for endpoint in ['ok','retry','gone']:db.add(PushSubscription(account_id=self.ids['worker'],endpoint_hash=endpoint,payload=dump({'endpoint':endpoint})))
   db.commit()
  calls=[]
  class Failure(Exception):pass
  def send(**kwargs):
   endpoint=kwargs['subscription_info']['endpoint'];calls.append(endpoint)
   if endpoint=='gone':
    exc=Failure();exc.response=type('Response',(),{'status_code':410})();raise exc
   if endpoint=='retry' and calls.count('retry')==1:raise Failure()
  with SessionLocal() as db:deliver(db,send,'test-vapid','test-subject')
  self.assertCountEqual(calls,['ok','retry','gone'])
  with SessionLocal() as db:
   rows=db.scalars(select(PushDelivery).where(PushDelivery.notice_id==nid)).all();self.assertCountEqual([r.status for r in rows],['delivered','pending','failed']);self.assertFalse(db.get(Notice,nid).push_sent)
   for r in rows:
    if r.status=='pending':r.next_attempt_at=now()-timedelta(seconds=1)
   db.commit();deliver(db,send,'test-vapid','test-subject');self.assertTrue(db.get(Notice,nid).push_sent);self.assertIsNone(db.scalar(select(PushSubscription).where(PushSubscription.endpoint_hash=='gone')))
  self.assertEqual(calls.count('ok'),1);self.assertEqual(calls.count('retry'),2)
