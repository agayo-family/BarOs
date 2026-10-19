import copy,hashlib,importlib,os,tempfile,unittest
from datetime import timedelta
from unittest.mock import patch
os.environ.setdefault('DATABASE_URL','sqlite:///'+tempfile.mktemp(prefix='baros-packages-',suffix='.db'))
os.environ['BAROS_WORKER']='0'
from fastapi.testclient import TestClient
from sqlalchemy import select,func
from baros.db import Base,engine,SessionLocal
from baros.models import Organization,Course
from baros.security import hash_password
from baros.v2.models import Account,VenueSettings,ImportedAssessment,WrittenAttempt,Notice,CourseSettings,LearningProfile
from baros.v2.domain import now,parse,dump
app=importlib.import_module('baros.v2.app').app

PACKAGE={'format':'baros-package','version':1,'kind':'assessment','assessment':{'title':'Письменная диагностика','positions':['bartender'],'time_limit_minutes':60,'sections':[{'id':'theory','title':'Теория'},{'id':'rnd','title':'Письменный R&D','instructions':'Только план на бумаге, без приготовления.'}], 'tasks':[{'id':'q1','section_id':'theory','kind':'single_choice','prompt':'Какую температуру указывает тестовая карта?','points':20,'choices':['90 °C','80 °C','70 °C','60 °C'],'correct_index':0,'explanation':'SECRET_CORRECT_EXPLANATION'}, {'id':'q2','section_id':'rnd','kind':'written','prompt':'Опишите план приготовления и себестоимость.','points':80,'rubric':[{'id':'plan','label':'План','points':50,'guidance':'SECRET_RUBRIC_ANCHOR'},{'id':'cost','label':'Расчёт','points':30,'guidance':'Проверить арифметику'}]}]}}
COURSE={'format':'baros-package','version':1,'kind':'course','course':{'title':'Импорт курса','positions':['bartender'],'quiz_size':1,'lessons':[{'title':'Стандарт','body':'Чай заваривают при температуре 90 °C.'}],'questions':[{'prompt':'Какую температуру используют для чая?','choices':['90 °C','80 °C','70 °C','60 °C'],'correct_index':0,'explanation':'В стандарте указаны 90 °C.','type':'knowledge'}]}}

class PackageTests(unittest.TestCase):
 def setUp(self):
  Base.metadata.drop_all(engine);self.client=TestClient(app);self.client.__enter__()
  with SessionLocal() as db:
   org=Organization(name='Test venue');other=Organization(name='Other');db.add_all([org,other]);db.flush();self.oid=org.id
   db.add_all([VenueSettings(organization_id=o.id,join_code='CODEIMPORT'+str(o.id)) for o in [org,other]])
   self.ids={}
   for name,role,oid,positions in [('manager','manager',org.id,[]),('worker','employee',org.id,['bartender']),('peer','employee',org.id,['bartender']),('waiter','employee',org.id,['waiter']),('foreign','manager',other.id,[])]:
    a=Account(name=name,login=name,role=role,organization_id=oid,positions_json=dump(positions),password_hash=hash_password('test-import-password'));db.add(a);db.flush();self.ids[name]=a.id
   db.commit()
  self.login('manager')
 def tearDown(self):self.client.__exit__(None,None,None)
 def login(self,name):
  self.client.cookies.clear();self.assertEqual(self.client.post('/api/auth/login',json={'login':name,'password':'test-import-password'}).status_code,200);self.headers={'x-csrf-token':self.client.get('/api/me').json()['csrf']}
 def post(self,path,data):return self.client.post(path,json=data,headers=self.headers)
 def edit(self,aid,revision,assessment,reviewed=False):
  return self.client.put(f'/api/assessments/{aid}',json={'revision':revision,'assessment':assessment,'reviewed':reviewed},headers=self.headers)
 def import_(self,p=PACKAGE):
  r=self.post('/api/packages/import',{'package':p});self.assertEqual(r.status_code,200,r.text);return r.json()['id']
 def publish(self):
  aid=self.import_();r=self.post(f'/api/assessments/{aid}/publish',{'reviewed':True});self.assertEqual(r.status_code,200,r.text);return aid
 def start(self):
  aid=self.publish();self.login('worker');r=self.post(f'/api/assessments/{aid}/start',{});self.assertEqual(r.status_code,200,r.text);return aid,r.json()
 def test_preview_duplicate_import_and_course_activities(self):
  with patch('baros.v2.ai.call_model') as ai:
   r=self.post('/api/packages/preview',{'package':COURSE});self.assertEqual(r.status_code,200);self.assertEqual(r.json()['lessons'],1)
   cid=self.import_(COURSE);again=self.post('/api/packages/import',{'package':COURSE}).json();self.assertTrue(again['duplicate']);self.assertEqual(again['id'],cid);ai.assert_not_called()
  with SessionLocal() as db:self.assertEqual(db.scalar(select(func.count(Course.id))),1);self.assertFalse(db.get(Course,cid).published)
  version=self.client.get('/api/courses/'+str(cid)).json()['edit_version'];self.assertEqual(self.post(f'/api/courses/{cid}/publish',{'edit_version':version,'reviewed':True}).status_code,200)
  self.login('worker');self.assertEqual(self.client.get(f'/api/learning/{cid}/cards').json()['cards'][0]['answer'],'90 °C');self.assertEqual(self.client.get('/api/games').status_code,200)
 def test_import_guards_schema_scope_and_subscription(self):
  aid=self.import_();self.login('worker');self.assertEqual(self.post('/api/packages/import',{'package':PACKAGE}).status_code,403)
  self.assertEqual(self.client.get(f'/api/assessments/{aid}').status_code,403)
  self.login('foreign');self.assertEqual(self.client.get(f'/api/assessments/{aid}').status_code,404)
  self.login('manager');invalid={**PACKAGE,'version':99};self.assertEqual(self.post('/api/packages/import',{'package':invalid}).status_code,422)
  self.assertEqual(self.client.post('/api/packages/import',json={'package':PACKAGE}).status_code,403)
  with SessionLocal() as db:db.get(VenueSettings,self.oid).status='read_only';db.commit()
  self.assertEqual(self.post('/api/packages/import',{'package':COURSE}).status_code,403)
 def test_no_answer_keys_or_future_sections_leak_to_participant(self):
  aid,data=self.start();text=dump(data);self.assertNotIn('correct_index',text);self.assertNotIn('SECRET',text);self.assertNotIn('Письменный R&D',text);self.assertEqual(len(data['tasks']),1)
  self.assertEqual(self.post(f'/api/assessments/{aid}/start',{}).json()['id'],data['id'])
  self.assertNotIn('SECRET',self.client.get(f'/api/assessments/{aid}').text)
  self.login('peer');self.assertEqual(self.client.get('/api/assessment-attempts/'+data['id']).status_code,404)
  self.login('waiter');self.assertEqual(self.client.get('/api/assessments').json(),[])
 def test_full_written_flow_grading_and_optimistic_lock(self):
  aid,data=self.start();rid=data['id']
  with SessionLocal() as db:correct=parse(db.get(WrittenAttempt,rid).snapshot)['tasks'][0]['correct_index']
  r=self.client.put('/api/assessment-attempts/'+rid,json={'version':data['version'],'answers':{'q1':correct}},headers=self.headers);self.assertEqual(r.status_code,200,r.text);data=r.json()
  self.assertEqual(self.client.put('/api/assessment-attempts/'+rid,json={'version':1,'answers':{'q1':0}},headers=self.headers).status_code,409)
  self.assertEqual(self.post('/api/assessment-attempts/'+rid+'/submit',{'version':data['version']}).status_code,409)
  data=self.post('/api/assessment-attempts/'+rid+'/advance',{'version':data['version']}).json();self.assertEqual(len(data['tasks']),2)
  self.assertEqual(self.client.put('/api/assessment-attempts/'+rid,json={'version':data['version'],'answers':{'q1':0}},headers=self.headers).status_code,409)
  data=self.client.put('/api/assessment-attempts/'+rid,json={'version':data['version'],'answers':{'q2':'Сначала расчёт, затем план; без выдуманного фактического результата.'}},headers=self.headers).json()
  data=self.post('/api/assessment-attempts/'+rid+'/submit',{'version':data['version']}).json();self.assertEqual(data['status'],'submitted');self.assertIsNone(data['result'])
  self.assertEqual(self.client.put('/api/assessment-attempts/'+rid,json={'version':data['version'],'answers':{'q2':'изменить'}},headers=self.headers).status_code,409)
  self.assertEqual(self.post('/api/assessment-attempts/'+rid+'/review',{'version':data['version'],'grades':{'q2':{'plan':50,'cost':30}}}).status_code,403)
  self.login('manager');self.assertIn('SECRET_RUBRIC_ANCHOR',self.client.get('/api/assessment-attempts/'+rid).text)
  invalid=self.post('/api/assessment-attempts/'+rid+'/review',{'version':data['version'],'grades':{'q2':{'plan':51,'cost':30}}});self.assertEqual(invalid.status_code,400)
  result=self.post('/api/assessment-attempts/'+rid+'/review',{'version':data['version'],'grades':{'q2':{'plan':40,'cost':25}},'feedback':{'q2':'Проверьте потери'}});self.assertEqual(result.status_code,200,result.text);self.assertEqual(result.json()['result']['points'],85)
  self.login('worker');self.assertEqual(self.client.get('/api/assessment-attempts/'+rid).json()['result']['points'],85)
  self.assertEqual(self.client.get('/api/learning').json()['attempts'],0)
 def test_timeout_submits_without_forged_completion_or_reward(self):
  aid,data=self.start()
  with SessionLocal() as db:db.get(WrittenAttempt,data['id']).expires_at=now()-timedelta(seconds=1);db.commit()
  r=self.client.get('/api/assessment-attempts/'+data['id']);self.assertEqual(r.status_code,200);self.assertEqual(r.json()['status'],'submitted')
  self.assertEqual(self.client.get('/api/learning').json()['assigned'],0)
 def test_invalid_rubric_unknown_fields_and_answer_type(self):
  import copy
  invalid=copy.deepcopy(PACKAGE);invalid['assessment']['tasks'][1]['rubric'][0]['points']=-1
  self.assertEqual(self.post('/api/packages/import',{'package':invalid}).status_code,422)
  invalid=copy.deepcopy(PACKAGE);invalid['assessment']['unexpected']='code'
  self.assertEqual(self.post('/api/packages/import',{'package':invalid}).status_code,422)
  aid,data=self.start()
  self.assertEqual(self.client.put('/api/assessment-attempts/'+data['id'],json={'version':data['version'],'answers':{'q1':True}},headers=self.headers).status_code,422)
 def test_choice_only_auto_grade_and_archive(self):
  import copy
  p=copy.deepcopy(PACKAGE);p['assessment']['sections']=p['assessment']['sections'][:1];p['assessment']['tasks']=p['assessment']['tasks'][:1];p['assessment']['passing_score']=80
  aid=self.import_(p);self.post(f'/api/assessments/{aid}/publish',{'reviewed':True});self.login('worker');data=self.post(f'/api/assessments/{aid}/start',{}).json()
  with SessionLocal() as db:index=parse(db.get(WrittenAttempt,data['id']).snapshot)['tasks'][0]['correct_index']
  data=self.client.put('/api/assessment-attempts/'+data['id'],json={'version':data['version'],'answers':{'q1':index}},headers=self.headers).json()
  result=self.post('/api/assessment-attempts/'+data['id']+'/submit',{'version':data['version']});self.assertEqual(result.json()['status'],'graded');self.assertTrue(result.json()['result']['passed'])
  self.login('manager');self.post(f'/api/assessments/{aid}/archive',{});self.login('worker');self.assertEqual(self.client.get(f'/api/assessments/{aid}').status_code,403)
 def test_weighted_rubrics_normalise_raw_points(self):
  import copy
  p=copy.deepcopy(PACKAGE);p['assessment']['sections']=p['assessment']['sections'][1:];p['assessment']['tasks']=p['assessment']['tasks'][1:];p['assessment']['tasks'][0]['points']=0.75
  aid=self.import_(p);self.post(f'/api/assessments/{aid}/publish',{'reviewed':True});self.login('worker');data=self.post(f'/api/assessments/{aid}/start',{}).json();rid=data['id'];data=self.post('/api/assessment-attempts/'+rid+'/submit',{'version':data['version']}).json();self.login('manager')
  result=self.post('/api/assessment-attempts/'+rid+'/review',{'version':data['version'],'grades':{'q2':{'plan':50,'cost':30}}});self.assertEqual(result.status_code,200,result.text);self.assertEqual(result.json()['result']['points'],0.75)
 def test_notice_idempotence_and_mentor_block(self):
  aid,data=self.start();self.assertEqual(self.client.get('/api/mentor').status_code,409)
  self.login('manager');self.post(f'/api/assessments/{aid}/publish',{'reviewed':True})
  with SessionLocal() as db:self.assertEqual(db.scalar(select(func.count(Notice.id)).where(Notice.account_id==self.ids['worker'])),1)
 def test_normal_and_written_exams_block_each_other(self):
  cid=self.import_(COURSE);version=self.client.get('/api/courses/'+str(cid)).json()['edit_version'];self.post(f'/api/courses/{cid}/publish',{'edit_version':version,'reviewed':True});aid=self.publish();self.login('worker')
  with patch('baros.v2.learning.MIN_READ_SECONDS',0):self.assertEqual(self.post(f'/api/learning/{cid}/lessons/0',{'complete':True}).status_code,200)
  exam=self.post(f'/api/learning/{cid}/exam',{});self.assertEqual(exam.status_code,200,exam.text)
  self.assertEqual(self.post(f'/api/assessments/{aid}/start',{}).status_code,409)
  from baros.v2.models import Exam
  with SessionLocal() as db:db.get(Exam,exam.json()['id']).expires_at=now()-timedelta(seconds=1);db.commit()
  written=self.post(f'/api/assessments/{aid}/start',{});self.assertEqual(written.status_code,200,written.text)
  self.assertEqual(self.post(f'/api/learning/{cid}/exam',{}).status_code,409)
 def test_review_of_expired_attempt_keeps_expiry_and_version_consistent(self):
  aid,data=self.start();rid=data['id']
  with SessionLocal() as db:db.get(WrittenAttempt,rid).expires_at=now()-timedelta(seconds=1);db.commit()
  self.login('manager');review={'version':data['version'],'grades':{'q2':{'plan':50,'cost':30}}}
  self.assertEqual(self.post('/api/assessment-attempts/'+rid+'/review',review).status_code,409)
  fresh=self.client.get('/api/assessment-attempts/'+rid).json();self.assertEqual(fresh['status'],'submitted');self.assertEqual(fresh['version'],data['version']+1)
  review['version']=fresh['version'];result=self.post('/api/assessment-attempts/'+rid+'/review',review);self.assertEqual(result.status_code,200,result.text);self.assertEqual(result.json()['status'],'graded')
 def test_explicit_cap_preserves_raw_grades_and_requires_reason(self):
  import copy
  p=copy.deepcopy(PACKAGE);p['assessment']['sections']=p['assessment']['sections'][1:];p['assessment']['tasks']=p['assessment']['tasks'][1:]
  task=p['assessment']['tasks'][0];task['points']=15;task['score_cap']={'points':12,'guidance':'Отметьте грубое нарушение brief и укажите причину.'}
  aid=self.import_(p);self.post(f'/api/assessments/{aid}/publish',{'reviewed':True});self.login('worker');data=self.post(f'/api/assessments/{aid}/start',{}).json();rid=data['id'];self.assertNotIn('score_cap',data['tasks'][0]);data=self.post('/api/assessment-attempts/'+rid+'/submit',{'version':data['version']}).json();self.login('manager')
  review={'version':data['version'],'grades':{'q2':{'plan':50,'cost':30}},'applied_caps':{'q2':True}}
  self.assertEqual(self.post('/api/assessment-attempts/'+rid+'/review',review).status_code,400)
  invalid={**review,'applied_caps':{'unknown':True}};self.assertEqual(self.post('/api/assessment-attempts/'+rid+'/review',invalid).status_code,400)
  review['feedback']={'q2':'Gin 30 мл вместо требуемых 40 мл.'};result=self.post('/api/assessment-attempts/'+rid+'/review',review);self.assertEqual(result.status_code,200,result.text);self.assertEqual(result.json()['result']['points'],12);self.assertTrue(result.json()['result']['review'][0]['cap_applied']);self.assertEqual(result.json()['grades']['q2']['scores'],{'plan':50,'cost':30})
  self.login('worker');result=self.client.get('/api/assessment-attempts/'+rid).json();self.assertEqual(result['result']['points'],12);self.assertIn('30 мл',result['result']['review'][0]['feedback'])

 def test_edit_draft_replaces_content_and_removes_sections_and_tasks(self):
  aid=self.import_();original=self.client.get(f'/api/assessments/{aid}').json()
  with SessionLocal() as db:
   payload=db.get(ImportedAssessment,aid).payload
   self.assertEqual(original['revision'],hashlib.sha256(payload.encode('utf-8')).hexdigest())
  changed=copy.deepcopy(original['package']);changed.update(title='Новая диагностика',description='Обновлённое описание',instructions='Новая инструкция',positions=['waiter'],time_limit_minutes=45,max_attempts=3,passing_score=70,sequential_sections=False)
  changed['sections']=changed['sections'][1:];changed['sections'][0]['title']='Изменённый раздел'
  changed['tasks']=changed['tasks'][1:];task=changed['tasks'][0];task.update(prompt='Новая письменная формулировка',points=10,max_length=300,score_cap={'points':8,'guidance':'Предел при грубом нарушении задания'})
  task['rubric']=[{'id':'new','label':'Новый критерий','points':5,'guidance':'Проверить новый критерий'}]
  response=self.edit(aid,original['revision'],changed);self.assertEqual(response.status_code,200,response.text)
  current=self.client.get(f'/api/assessments/{aid}').json()
  self.assertEqual(current['title'],'Новая диагностика');self.assertEqual(current['package'],changed);self.assertEqual(current['tasks'],1)
  self.assertFalse(current['published']);self.assertFalse(current['archived']);self.assertNotEqual(current['revision'],original['revision']);self.assertEqual(response.json()['revision'],current['revision'])
  stale=self.edit(aid,original['revision'],original['package']);self.assertEqual(stale.status_code,409,stale.text)
  self.assertEqual(self.client.get(f'/api/assessments/{aid}').json()['package'],changed)

 def test_edit_validation_is_atomic_and_enforces_total_size(self):
  aid=self.import_();original=self.client.get(f'/api/assessments/{aid}').json();base=original['package']
  invalid=[]
  item=copy.deepcopy(base);item['tasks'][0]['correct_index']=99;invalid.append(item)
  item=copy.deepcopy(base);item['tasks'][1]['rubric']=[];invalid.append(item)
  item=copy.deepcopy(base);item['sections']=item['sections'][:1];invalid.append(item)
  item=copy.deepcopy(base);item['tasks'][1]['id']=item['tasks'][0]['id'];invalid.append(item)
  item=copy.deepcopy(base);item['unexpected']='ignored?';invalid.append(item)
  for item in invalid:
   with self.subTest(payload=item):self.assertEqual(self.edit(aid,original['revision'],item).status_code,422)
  large=copy.deepcopy(base);large['sections']=large['sections'][1:]
  large['tasks']=[{**copy.deepcopy(base['tasks'][1]),'id':'large_'+str(i),'prompt':'Я'*10000} for i in range(110)]
  response=self.edit(aid,original['revision'],large);self.assertEqual(response.status_code,413,response.text)
  current=self.client.get(f'/api/assessments/{aid}').json();self.assertEqual(current['package'],base);self.assertEqual(current['revision'],original['revision'])

 def test_edit_permissions_isolation_csrf_and_subscription(self):
  aid=self.publish();original=self.client.get(f'/api/assessments/{aid}').json();data=original['package'];revision=original['revision']
  self.login('worker');self.assertEqual(self.edit(aid,revision,data,True).status_code,403)
  self.assertEqual(self.post(f'/api/assessments/{aid}/publish',{'reviewed':True}).status_code,403);self.assertEqual(self.post(f'/api/assessments/{aid}/archive',{}).status_code,403)
  self.login('foreign');self.assertEqual(self.edit(aid,revision,data,True).status_code,404)
  self.login('manager');self.assertEqual(self.client.put(f'/api/assessments/{aid}',json={'revision':revision,'assessment':data}).status_code,403)
  with SessionLocal() as db:db.get(Account,self.ids['manager']).permissions_json=dump({'courses_manage':False});db.commit()
  self.assertEqual(self.edit(aid,revision,data).status_code,403)
  with SessionLocal() as db:db.get(Account,self.ids['manager']).permissions_json='{}';db.get(VenueSettings,self.oid).status='read_only';db.commit()
  self.assertEqual(self.edit(aid,revision,data).status_code,403)
  with SessionLocal() as db:db.get(VenueSettings,self.oid).status='active';db.get(VenueSettings,self.oid).subscription_status='past_due';db.commit()
  self.assertEqual(self.edit(aid,revision,data).status_code,402)
  with SessionLocal() as db:self.assertEqual(hashlib.sha256(db.get(ImportedAssessment,aid).payload.encode('utf-8')).hexdigest(),revision)

 def test_published_edit_requires_confirmation_and_preserves_archive(self):
  aid=self.publish();self.post(f'/api/assessments/{aid}/archive',{});original=self.client.get(f'/api/assessments/{aid}').json();changed=copy.deepcopy(original['package']);changed['title']='Изменённый архивный тест'
  response=self.edit(aid,original['revision'],changed);self.assertEqual(response.status_code,400,response.text)
  self.assertEqual(self.client.get(f'/api/assessments/{aid}').json()['revision'],original['revision'])
  response=self.edit(aid,original['revision'],changed,True);self.assertEqual(response.status_code,200,response.text)
  current=self.client.get(f'/api/assessments/{aid}').json();self.assertTrue(current['published']);self.assertTrue(current['archived']);self.assertEqual(current['title'],changed['title'])
  self.post(f'/api/assessments/{aid}/publish',{'reviewed':True});current=self.client.get(f'/api/assessments/{aid}').json();self.assertFalse(current['archived']);self.assertEqual(current['revision'],response.json()['revision'])

 def test_edit_preserves_running_and_submitted_snapshots_and_old_rubric(self):
  aid,attempt=self.start();rid=attempt['id']
  with SessionLocal() as db:old_snapshot=db.get(WrittenAttempt,rid).snapshot;correct=parse(old_snapshot)['tasks'][0]['correct_index']
  self.login('manager');original=self.client.get(f'/api/assessments/{aid}').json()
  changed=copy.deepcopy(original['package']);changed.update(title='Тест после редактирования',max_attempts=2,time_limit_minutes=7,passing_score=80)
  changed['sections']=[{'id':'fresh','title':'Новый раздел','instructions':'Новые условия'}]
  changed['tasks']=[{'id':'fresh_task','section_id':'fresh','kind':'written','prompt':'Совершенно новое письменное задание','points':10,'rubric':[{'id':'fresh_criterion','label':'Новый критерий','points':5,'guidance':'Новая рубрика'}]}]
  response=self.edit(aid,original['revision'],changed,True);self.assertEqual(response.status_code,200,response.text)
  self.login('worker');running=self.client.get('/api/assessment-attempts/'+rid).json();self.assertEqual(running['title'],original['title']);self.assertEqual(running['tasks'][0]['id'],'q1')
  running=self.client.put('/api/assessment-attempts/'+rid,json={'version':running['version'],'answers':{'q1':correct}},headers=self.headers).json()
  running=self.post('/api/assessment-attempts/'+rid+'/advance',{'version':running['version']}).json()
  running=self.client.put('/api/assessment-attempts/'+rid,json={'version':running['version'],'answers':{'q2':'Ответ на прежнее задание'}},headers=self.headers).json()
  submitted=self.post('/api/assessment-attempts/'+rid+'/submit',{'version':running['version']}).json();self.assertEqual(submitted['status'],'submitted')
  self.login('manager');latest=self.client.get(f'/api/assessments/{aid}').json();changed['title']='Ещё одна редакция после сдачи'
  response=self.edit(aid,latest['revision'],changed,True);self.assertEqual(response.status_code,200,response.text)
  reviewed=self.post('/api/assessment-attempts/'+rid+'/review',{'version':submitted['version'],'grades':{'q2':{'plan':50,'cost':30}}})
  self.assertEqual(reviewed.status_code,200,reviewed.text);self.assertEqual(reviewed.json()['result']['points'],100);self.assertIsNone(reviewed.json()['result']['passed'])
  with SessionLocal() as db:self.assertEqual(db.get(WrittenAttempt,rid).snapshot,old_snapshot)
  self.login('worker');new=self.post(f'/api/assessments/{aid}/start',{});self.assertEqual(new.status_code,200,new.text);self.assertNotEqual(new.json()['id'],rid);self.assertEqual(new.json()['title'],changed['title']);self.assertEqual(new.json()['tasks'][0]['id'],'fresh_task')
  with SessionLocal() as db:
   row=db.get(WrittenAttempt,new.json()['id']);self.assertEqual(parse(row.snapshot)['tasks'][0]['rubric'][0]['id'],'fresh_criterion');self.assertAlmostEqual((row.expires_at-row.started_at).total_seconds(),420,delta=2)

 def test_edit_positions_keeps_existing_attempt_assignment_snapshot(self):
  aid,attempt=self.start();rid=attempt['id'];self.login('manager');original=self.client.get(f'/api/assessments/{aid}').json();changed=copy.deepcopy(original['package']);changed.update(positions=['waiter'],title='CURRENT_WAITER_TITLE',description='CURRENT_WAITER_DESCRIPTION',instructions='CURRENT_WAITER_INSTRUCTIONS')
  self.assertEqual(self.edit(aid,original['revision'],changed,True).status_code,200)
  self.login('worker');detail=self.client.get(f'/api/assessments/{aid}');self.assertEqual(detail.status_code,200,detail.text);self.assertFalse(detail.json()['can_start']);self.assertEqual(detail.json()['title'],original['title']);self.assertEqual(detail.json()['instructions'],original['package']['instructions']);self.assertNotIn('CURRENT_WAITER',detail.text);self.assertNotIn('SECRET',detail.text);self.assertEqual(detail.json()['attempts'][0]['id'],rid)
  listed=self.client.get('/api/assessments');self.assertEqual(len(listed.json()),1);self.assertFalse(listed.json()[0]['can_start']);self.assertEqual(listed.json()[0]['title'],original['title']);self.assertNotIn('CURRENT_WAITER',listed.text)
  resumed=self.post(f'/api/assessments/{aid}/start',{});self.assertEqual(resumed.status_code,200,resumed.text);self.assertEqual(resumed.json()['id'],rid);self.assertEqual(resumed.json()['title'],original['title'])
  response=self.client.put('/api/assessment-attempts/'+rid,json={'version':attempt['version'],'answers':{'q1':0}},headers=self.headers);self.assertEqual(response.status_code,200,response.text)
  advanced=self.post('/api/assessment-attempts/'+rid+'/advance',{'version':response.json()['version']});self.assertEqual(advanced.status_code,200,advanced.text)
  submitted=self.post('/api/assessment-attempts/'+rid+'/submit',{'version':advanced.json()['version']});self.assertEqual(submitted.status_code,200,submitted.text)
  self.assertEqual(self.post(f'/api/assessments/{aid}/start',{}).status_code,403);self.assertEqual(self.client.get(f'/api/assessments/{aid}').json()['attempts'][0]['status'],'submitted');self.assertEqual(self.client.get('/api/assessment-attempts/'+rid).status_code,200)
  self.login('peer');self.assertEqual(self.post(f'/api/assessments/{aid}/start',{}).status_code,403);self.assertEqual(self.client.get(f'/api/assessments/{aid}').status_code,403);self.assertEqual(self.client.get('/api/assessments').json(),[])
  self.login('waiter');self.assertTrue(self.client.get(f'/api/assessments/{aid}').json()['can_start']);response=self.post(f'/api/assessments/{aid}/start',{});self.assertEqual(response.status_code,200,response.text);self.assertEqual(response.json()['title'],changed['title'])
  self.login('manager');self.assertEqual(self.post(f'/api/assessments/{aid}/archive',{}).status_code,200)
  self.login('worker');self.assertEqual(self.client.get('/api/assessments').json(),[]);self.assertEqual(self.client.get(f'/api/assessments/{aid}').status_code,403);self.assertEqual(self.client.get('/api/assessment-attempts/'+rid).status_code,403)

 def test_return_section_preserves_work_and_reopens_submitted_attempt(self):
  aid,data=self.start();rid=data['id']
  data=self.post('/api/assessment-attempts/'+rid+'/advance',{'version':data['version']}).json()
  data=self.client.put('/api/assessment-attempts/'+rid,json={'version':data['version'],'answers':{'q2':'Уже сохранённый письменный ответ'}},headers=self.headers).json()
  with SessionLocal() as db:
   row=db.get(WrittenAttempt,rid);snapshot=row.snapshot;answers=row.answers;grades=row.grades;expiry=row.expires_at
  self.login('manager');returned=self.post('/api/assessment-attempts/'+rid+'/return-section',{'version':data['version'],'section_index':0,'extra_minutes':0})
  self.assertEqual(returned.status_code,200,returned.text);returned=returned.json();self.assertEqual(returned['status'],'in_progress');self.assertEqual(returned['section_index'],0);self.assertEqual(returned['version'],data['version']+1)
  with SessionLocal() as db:
   row=db.get(WrittenAttempt,rid);self.assertEqual((row.snapshot,row.answers,row.grades,row.expires_at),(snapshot,answers,grades,expiry));self.assertIsNone(row.submitted_at)
  self.login('worker');fresh=self.client.get('/api/assessment-attempts/'+rid).json();self.assertEqual([task['id'] for task in fresh['tasks']],['q1']);self.assertEqual(fresh['answers']['q2'],'Уже сохранённый письменный ответ');self.assertNotIn('SECRET',dump(fresh))
  stale=self.client.put('/api/assessment-attempts/'+rid,json={'version':data['version'],'answers':{'q1':0}},headers=self.headers);self.assertEqual(stale.status_code,409,stale.text)
  saved=self.client.put('/api/assessment-attempts/'+rid,json={'version':fresh['version'],'answers':{'q1':0}},headers=self.headers);self.assertEqual(saved.status_code,200,saved.text)
  advanced=self.post('/api/assessment-attempts/'+rid+'/advance',{'version':saved.json()['version']});self.assertEqual(advanced.status_code,200,advanced.text);self.assertEqual(advanced.json()['answers']['q2'],'Уже сохранённый письменный ответ')
  submitted=self.post('/api/assessment-attempts/'+rid+'/submit',{'version':advanced.json()['version']});self.assertEqual(submitted.status_code,200,submitted.text);submitted=submitted.json();self.assertEqual(submitted['status'],'submitted')
  self.login('manager');reopened=self.post('/api/assessment-attempts/'+rid+'/return-section',{'version':submitted['version'],'section_index':0,'extra_minutes':12})
  self.assertEqual(reopened.status_code,200,reopened.text);self.assertEqual(reopened.json()['version'],submitted['version']+1);self.assertEqual(reopened.json()['status'],'in_progress');self.assertEqual(reopened.json()['section_index'],0)
  with SessionLocal() as db:
   row=db.get(WrittenAttempt,rid);self.assertIsNone(row.submitted_at);self.assertEqual(row.snapshot,snapshot);self.assertEqual(row.grades,grades);self.assertEqual(parse(row.answers),{'q1':0,'q2':'Уже сохранённый письменный ответ'});self.assertEqual(row.expires_at,expiry+timedelta(minutes=12))

 def test_return_section_guards_scope_conflicts_and_expired_time(self):
  from baros.v2.models import CourseRevision,Exam
  aid,data=self.start();rid=data['id'];data=self.post('/api/assessment-attempts/'+rid+'/advance',{'version':data['version']}).json();data=self.post('/api/assessment-attempts/'+rid+'/submit',{'version':data['version']}).json();version=data['version']
  path='/api/assessment-attempts/'+rid+'/return-section';body={'version':version,'section_index':0,'extra_minutes':0}
  self.assertEqual(self.post(path,body).status_code,403);self.login('foreign');self.assertEqual(self.post(path,body).status_code,404);self.login('manager');self.assertEqual(self.client.post(path,json=body).status_code,403)
  self.assertEqual(self.post(path,{**body,'version':version+1}).status_code,409)
  for field,value in [('extra_minutes',-1),('extra_minutes',721),('section_index',-1)]:
   with self.subTest(field=field,value=value):self.assertEqual(self.post(path,{**body,field:value}).status_code,422)
  self.assertEqual(self.post(path,{**body,'section_index':2}).status_code,400)
  self.assertEqual(self.post(f'/api/assessments/{aid}/archive',{}).status_code,200);self.assertEqual(self.post(path,body).status_code,409);self.assertEqual(self.post(f'/api/assessments/{aid}/archive',{}).status_code,200)
  with SessionLocal() as db:db.get(ImportedAssessment,aid).published=False;db.commit()
  self.assertEqual(self.post(path,body).status_code,409)
  with SessionLocal() as db:db.get(ImportedAssessment,aid).published=True;db.get(Account,self.ids['manager']).permissions_json=dump({'courses_manage':False});db.commit()
  self.assertEqual(self.post(path,body).status_code,403)
  with SessionLocal() as db:db.get(Account,self.ids['manager']).permissions_json='{}';db.commit()
  with SessionLocal() as db:
   row=db.get(WrittenAttempt,rid);snapshot=row.snapshot;answers=row.answers;expiry=row.expires_at;nonsequential=parse(snapshot);nonsequential['sequential_sections']=False;row.snapshot=dump(nonsequential);db.commit()
  self.assertEqual(self.post(path,body).status_code,400)
  with SessionLocal() as db:
   row=db.get(WrittenAttempt,rid);row.snapshot=snapshot;row.status='graded';row.graded_at=now();db.commit()
  self.assertEqual(self.post(path,body).status_code,409)
  with SessionLocal() as db:
   row=db.get(WrittenAttempt,rid);row.status='submitted';row.graded_at=None
   db.add(WrittenAttempt(id='other-live-written',organization_id=self.oid,assessment_id=aid,account_id=self.ids['worker'],snapshot=snapshot,expires_at=now()+timedelta(minutes=10)));db.commit()
  self.assertEqual(self.post(path,body).status_code,409)
  with SessionLocal() as db:
   db.get(WrittenAttempt,'other-live-written').expires_at=now()-timedelta(seconds=1)
   course=Course(organization_id=self.oid,title='Конфликтующий обычный экзамен',published=True);db.add(course);db.flush();revision=CourseRevision(course_id=course.id,version=1,payload='{}');db.add(revision);db.flush()
   db.add(Exam(id='other-live-exam',account_id=self.ids['worker'],revision_id=revision.id,questions_json='[]',expires_at=now()+timedelta(minutes=10)));db.commit()
  self.assertEqual(self.post(path,body).status_code,409)
  with SessionLocal() as db:
   row=db.get(WrittenAttempt,rid);self.assertEqual((row.version,row.status,row.section_index,row.snapshot,row.answers,row.expires_at),(version,'submitted',1,snapshot,answers,expiry));db.get(Exam,'other-live-exam').expires_at=now()-timedelta(seconds=1);row.expires_at=now()-timedelta(minutes=2);db.commit()
  self.assertEqual(self.post(path,body).status_code,400)
  reopened=self.post(path,{**body,'extra_minutes':15});self.assertEqual(reopened.status_code,200,reopened.text);self.assertEqual(reopened.json()['version'],version+1)
  with SessionLocal() as db:
   row=db.get(WrittenAttempt,rid);self.assertEqual((row.status,row.section_index,row.snapshot,row.answers),('in_progress',0,snapshot,answers));self.assertIsNone(row.submitted_at);self.assertGreater(row.expires_at,now()+timedelta(minutes=14));self.assertLess(row.expires_at,now()+timedelta(minutes=16))

if __name__=='__main__':unittest.main()
