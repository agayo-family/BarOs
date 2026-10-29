"""Known-number analytics fixtures, tenant scope, revisions and Moscow boundaries."""
import copy,importlib,os,tempfile,unittest
from datetime import datetime,timedelta
from unittest.mock import patch
os.environ.setdefault('DATABASE_URL','sqlite:///'+tempfile.mktemp(prefix='analytics-',suffix='.db'))
os.environ['BAROS_WORKER']='0'
from fastapi.testclient import TestClient
from sqlalchemy import event,select
from baros.db import Base,engine,SessionLocal
from baros.models import Organization,Course
from baros.security import hash_password
from baros.v2.models import Account,VenueSettings,CourseRevision,CourseSettings,Exam,ImportedAssessment,WrittenAttempt,LessonRead,Enrollment
from baros.v2.domain import dump,parse
from baros.v2.packages import AssessmentIn
from baros.v2.readiness import content_key
app=importlib.import_module('baros.v2.app').app
STAMP=datetime(2026,10,29,12)
COURSE={'title':'Точная подача','positions':['bartender'],'quiz_size':1,'lessons':[{'title':'Доза','body':'В рецептуре указаны 20 мл сиропа.'}],'questions':[{'prompt':'Сколько сиропа нужно по рецептуре?','choices':['20 мл','25 мл','30 мл','35 мл'],'correct_index':0,'explanation':'В рецептуре 20 мл.','type':'knowledge'}]}

class AnalyticsTests(unittest.TestCase):
 def setUp(self):
  Base.metadata.drop_all(engine);self.client=TestClient(app);self.client.__enter__()
  with SessionLocal() as db:
   a=Organization(name='Наше заведение');b=Organization(name='Чужое');db.add_all([a,b]);db.flush();self.oid=a.id;self.foreign=b.id
   for o in [a,b]:db.add(VenueSettings(organization_id=o.id,join_code='ANALYTICS'+str(o.id)))
   pw=hash_password('analytics-password');self.ids={}
   for login,role,oid,pos,active in [('boss','manager',a.id,[],True),('one','employee',a.id,['bartender'],True),('two','employee',a.id,['bartender'],True),('waiter','employee',a.id,['waiter'],True),('old','employee',a.id,['bartender'],False),('stranger','manager',b.id,[],True)]:
    x=Account(name=login,login=login,password_hash=pw,role=role,organization_id=oid,positions_json=dump(pos),active=active);db.add(x);db.flush();self.ids[login]=x.id
   db.commit()
  self.login('boss');r=self.post('/courses',COURSE);self.cid=r.json()['id'];self.assertEqual(self.post(f'/courses/{self.cid}/publish',{'reviewed':True,'edit_version':r.json()['edit_version']}).status_code,200)
  with SessionLocal() as db:
   self.rid=db.scalar(select(CourseRevision.id).where(CourseRevision.course_id==self.cid))
   p=AssessmentIn.model_validate({'title':'Ответ гостю','positions':['bartender'],'passing_score':80,'sections':[{'id':'s','title':'Ситуация'}],'tasks':[{'id':'t','section_id':'s','kind':'written','prompt':'Опишите действия при задержке блюда.','points':10,'rubric':[{'id':'facts','label':'Проверены факты','points':4},{'id':'solution','label':'Решение','points':6}]}]}).model_dump(mode='json')
   t=ImportedAssessment(organization_id=self.oid,title=p['title'],payload=dump(p),published=True);db.add(t);db.flush();self.aid=t.id;self.payload=p;db.commit()
 def tearDown(self):self.client.__exit__(None,None,None)
 def login(self,name):
  self.client.cookies.clear();self.assertEqual(self.client.post('/api/auth/login',json={'login':name,'password':'analytics-password'}).status_code,200);self.headers={'x-csrf-token':self.client.get('/api/me').json()['csrf']}
 def post(self,path,data):return self.client.post('/api'+path,json=data,headers=self.headers)
 def analytics(self,query=''):
  with patch('baros.v2.analytics.now',return_value=STAMP):r=self.client.get('/api/reports/analytics'+query)
  self.assertEqual(r.status_code,200,r.text);return r.json()
 def exam(self,key,name='one',score=50,at=None,rid=None,correct=False):
  at=at or STAMP-timedelta(hours=1)
  with SessionLocal() as db:
   db.add(Exam(id=key,account_id=self.ids[name],revision_id=rid or self.rid,started_at=at-timedelta(seconds=120),expires_at=at+timedelta(minutes=5),finished_at=at,questions_json='[]',result_json=dump({'score':score,'passed':score>=80,'duration_seconds':120,'review':[{'prompt':COURSE['questions'][0]['prompt'],'choices':['20 мл','25 мл','30 мл','35 мл'],'selected':0 if correct else 1,'correct':correct,'explanation':'В рецептуре 20 мл.'}]})));db.commit()
 def written(self,key,status='graded',payload=None,at=None):
  at=at or STAMP-timedelta(hours=2)
  with SessionLocal() as db:
   db.add(WrittenAttempt(id=key,organization_id=self.oid,assessment_id=self.aid,account_id=self.ids['one'],snapshot=dump(payload or self.payload),answers=dump({'t':'Уточню время и предложу решение.'}),grades=dump({'t':{'scores':{'facts':2,'solution':6},'feedback':'Уточните факты'}}),status=status,started_at=at-timedelta(minutes=5),expires_at=at+timedelta(hours=1),submitted_at=at,graded_at=at if status=='graded' else None));db.commit()
 def test_known_numbers_latest_questions_first_latest_best_and_median(self):
  self.exam('a',score=40,at=STAMP-timedelta(days=2));self.exam('b',score=100,at=STAMP-timedelta(days=1),correct=True);self.exam('c',score=60,at=STAMP-timedelta(hours=1));self.exam('d',name='two',score=80,correct=True)
  r=self.analytics();self.assertEqual(r['summary']['auto_attempts'],4);self.assertEqual(r['summary']['average_score'],70);self.assertEqual(r['summary']['median_seconds'],120);self.assertEqual(r['summary']['first_attempt_pass_percent'],50)
  one=next(x for x in r['team'] if x['name']=='one');self.assertEqual((one['first_score'],one['latest_score'],one['best_score'],one['improvement_pp']),(40,60,100,20));q=r['questions'][0];self.assertEqual((q['checked'],q['mistakes'],q['mistake_percent']),(2,1,50));self.assertEqual(q['distractors'],[{'answer':'25 мл','count':1}])
 def test_no_observations_are_null_not_zero_and_role_inactive_filters(self):
  r=self.analytics();self.assertIsNone(r['summary']['average_score']);self.assertIsNone(r['summary']['first_attempt_pass_percent']);self.assertEqual(r['summary']['employees'],3)
  r=self.analytics('?position=bartender');self.assertEqual(r['summary']['employees'],2)
  r=self.analytics('?position=bartender&include_inactive=true');self.assertEqual(r['summary']['employees'],3)
 def test_moscow_inclusive_day_and_date_validation(self):
  self.exam('before',at=datetime(2026,10,28,20,59,59));self.exam('first',at=datetime(2026,10,28,21));self.exam('last',at=datetime(2026,10,29,20,59,59));self.exam('after',at=datetime(2026,10,29,21))
  r=self.analytics('?start=2026-10-29&end=2026-10-29');self.assertEqual({x['id'] for x in r['attempts']},{'first','last'});self.assertEqual(r['timeline'][0]['date'],'2026-10-29')
  for query in ['?days=15','?start=2026-10-30&end=2026-10-29','?position=unknown']:
   self.assertEqual(self.client.get('/api/reports/analytics'+query).status_code,422)
 def test_pending_is_all_time_not_failed_and_criterion_scores_are_real(self):
  self.written('graded');self.written('pending','submitted',at=STAMP-timedelta(days=60))
  r=self.analytics();self.assertEqual((r['summary']['pending_review'],r['summary']['written_graded']),(1,1));self.assertGreater(r['review_queue'][0]['waiting_hours'],1400);self.assertEqual(r['assessments'][0]['average_score'],80)
  self.assertEqual({x['criterion']:x['average_percent'] for x in r['rubrics']},{'Проверены факты':50,'Решение':100})
 def test_written_revisions_are_separate_and_diagnostics_have_no_failure(self):
  self.written('old');self.written('pending-old','submitted');p=copy.deepcopy(self.payload);p['passing_score']=None;p['tasks'][0]['prompt']='Как действовать при задержке заказа?'
  with SessionLocal() as db:db.get(ImportedAssessment,self.aid).payload=dump(p);db.commit()
  self.written('new',payload=p);r=self.analytics();self.assertEqual(r['summary']['written_graded'],1);self.assertEqual(r['summary']['pending_review'],1);self.assertFalse(r['review_queue'][0]['current']);self.assertIsNone(r['attempts'][0]['passed'])
  r=self.analytics('?history=true');self.assertEqual(r['summary']['written_graded'],2);self.assertEqual(len(r['assessments']),2);self.assertEqual(len({x['revision'] for x in r['rubrics']}),2)
 def test_archived_course_versions_do_not_merge(self):
  self.exam('old',score=10)
  course=copy.deepcopy(COURSE);course['title']='Новая подача';course['questions'][0]['explanation']='По новой карте — те же 20 мл.'
  detail=self.client.get(f'/api/courses/{self.cid}').json();course['edit_version']=detail['edit_version'];r=self.client.put(f'/api/courses/{self.cid}',json=course,headers=self.headers);self.assertEqual(r.status_code,200,r.text);self.assertEqual(self.post(f'/courses/{self.cid}/publish',{'reviewed':True,'edit_version':r.json()['edit_version']}).status_code,200)
  with SessionLocal() as db:new=db.scalar(select(CourseRevision.id).where(CourseRevision.course_id==self.cid,CourseRevision.version==2))
  self.exam('new',rid=new,score=90,correct=True);r=self.analytics();self.assertEqual(r['summary']['auto_attempts'],1)
  r=self.analytics('?history=true');self.assertEqual(r['summary']['auto_attempts'],2);self.assertEqual({x['version']:x['average_score'] for x in r['courses']},{1:10,2:90});self.assertIsNone(next(x for x in r['courses'] if x['version']==1)['assigned'])
 def test_current_readiness_does_not_follow_period_and_csv_is_safe(self):
  self.exam('passed',score=100,correct=True,at=STAMP-timedelta(days=60))
  with SessionLocal() as db:
   db.add(LessonRead(account_id=self.ids['one'],revision_id=self.rid,lesson_index=0,completed_at=STAMP));db.get(Account,self.ids['one']).name='=HYPERLINK(1)';db.commit()
  r=self.analytics('?account_id='+str(self.ids['one']));self.assertEqual(r['team'][0]['complete'],1);self.assertEqual(r['team'][0]['assigned'],2);self.assertEqual(r['summary']['auto_attempts'],0)
  csv=self.client.get('/api/reports/analytics/export?section=team').content.decode('utf-8-sig');self.assertIn("'=HYPERLINK(1)",csv)
  for section in ['courses','questions','attempts','review_queue','rubrics','timeline']:self.assertEqual(self.client.get('/api/reports/analytics/export?section='+section).status_code,200)
 def test_tenant_role_and_foreign_identifiers(self):
  self.assertEqual(self.client.get('/api/reports/analytics?account_id='+str(self.ids['stranger'])).status_code,404)
  self.login('one');self.assertEqual(self.client.get('/api/reports/analytics').status_code,403);self.assertEqual(self.client.get('/api/reports/analytics/export').status_code,403)
  self.login('stranger');self.assertEqual(self.client.get('/api/reports/analytics?course_id='+str(self.cid)).status_code,404);self.assertEqual(self.analytics()['summary']['employees'],0)
 def test_expired_choice_only_test_never_enters_manual_review_queue(self):
  p=copy.deepcopy(self.payload);p['tasks']=[{'id':'t','section_id':'s','kind':'single_choice','prompt':'Сколько сиропа по карте?','choices':['20 мл','25 мл','30 мл','35 мл'],'correct_index':0,'points':10,'rubric':[],'explanation':'По карте 20 мл.','score_cap':None}]
  with SessionLocal() as db:
   db.get(ImportedAssessment,self.aid).payload=dump(p)
   db.add(WrittenAttempt(id='expired-auto',organization_id=self.oid,assessment_id=self.aid,account_id=self.ids['one'],snapshot=dump(p),answers=dump({'t':0}),status='in_progress',started_at=STAMP-timedelta(hours=2),expires_at=STAMP-timedelta(hours=1)));db.commit()
  r=self.analytics();self.assertEqual(r['summary']['pending_review'],0);self.assertEqual(r['summary']['written_graded'],1);self.assertTrue(r['attempts'][0]['passed'])
  row=next(x for x in r['team'] if x['id']==self.ids['one']);self.assertEqual(row['assessments'][0]['status'],'graded');self.assertTrue(row['assessments'][0]['passed'])
 def test_query_count_does_not_grow_per_employee(self):
  counts=[]
  def counter(*args):counts.append(1)
  event.listen(engine,'before_cursor_execute',counter)
  try:
   self.analytics('?account_id='+str(self.ids['one']));small=len(counts);counts.clear();self.analytics();large=len(counts)
  finally:event.remove(engine,'before_cursor_execute',counter)
  self.assertLessEqual(large,small+2)
