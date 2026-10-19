import importlib,os,tempfile,unittest
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

if __name__=='__main__':unittest.main()
