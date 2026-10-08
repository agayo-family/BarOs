import asyncio
import importlib
import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch
from datetime import timedelta
import httpx
from PIL import Image
from fastapi.testclient import TestClient
from sqlalchemy import select,func
os.environ.setdefault('DATABASE_URL','sqlite:///'+tempfile.mktemp(prefix='baros-growth-',suffix='.db'))
os.environ['BAROS_WORKER']='0'
from baros.db import Base,engine,SessionLocal
from baros.models import Organization,Course
from baros.security import hash_password
from baros.v2.models import Account,VenueSettings,CourseSettings,CourseRevision,LearningProfile,RewardEvent,Job,AIUsage,Exam
from baros.v2.domain import dump,now
from baros.v2.growth import reward
from baros.v2 import ai,ai_budget
from test_games import questions,token_solution
app=importlib.import_module('baros.v2.app').app

class GrowthTests(unittest.TestCase):
 def setUp(self):
  Base.metadata.drop_all(engine);self.client=TestClient(app);self.client.__enter__()
  with SessionLocal() as db:
   org=Organization(name='Rewards');foreign=Organization(name='Other');db.add_all([org,foreign]);db.flush();self.oid=org.id
   db.add_all([VenueSettings(organization_id=org.id,join_code='GROWTH1'),VenueSettings(organization_id=foreign.id,join_code='GROWTH2')])
   self.ids={}
   for name,role,oid in [('worker','employee',org.id),('peer','employee',org.id),('manager','manager',org.id),('foreign','manager',foreign.id),('owner','owner',None)]:
    a=Account(name=name,login=name,role=role,organization_id=oid,password_hash=hash_password('growth-password'),positions_json='["bartender"]');db.add(a);db.flush();self.ids[name]=a.id
   c=Course(organization_id=org.id,title='Topic',published=True);db.add(c);db.flush();self.cid=c.id
   data={'title':'Topic','description':'Source training','required':True,'positions':['bartender'],'lessons':[{'title':'Rules','body':'Material'}],'questions':questions(),'passing_score':80,'quiz_size':3,'time_limit_minutes':10,'max_attempts':0,'deadline_days':7,'due_at':None,'is_intro':False}
   rev=CourseRevision(course_id=c.id,version=1,payload=dump(data));db.add(rev);db.add(CourseSettings(course_id=c.id,version=1,positions_json='["bartender"]'));db.flush();self.rev=rev.id
   db.add(Job(id='ai-budget-test',organization_id=org.id,account_id=self.ids['manager'],context='Source',positions_json='["bartender"]',lease_token='lease',lease_until=now()+timedelta(minutes=5)))
   db.commit()
  self.login('worker')
 def tearDown(self):self.client.__exit__(None,None,None)
 def login(self,name):
  self.client.cookies.clear();r=self.client.post('/api/auth/login',json={'login':name,'password':'growth-password'});self.assertEqual(r.status_code,200)
  self.headers={'x-csrf-token':self.client.get('/api/me').json()['csrf']}
 def post(self,path,data):return self.client.post(path,json=data,headers=self.headers)
 def test_catalog_pet_swap_and_preview_rewards(self):
  data=self.client.get('/api/growth/catalog').json();self.assertEqual(len(data['pets']),15);self.assertEqual(len({p['id'] for p in data['pets']}),15)
  self.assertTrue(all(len(p['phrases'])>=30 for p in data['pets']))
  p=self.post('/api/growth/pet',{'pet_id':'ember'}).json();self.assertEqual(p['pet_swaps_left'],1)
  with SessionLocal() as db:
   a=db.get(Account,self.ids['worker']);reward(db,a,'one','theory',40,20,theory=1);db.commit()
  self.assertEqual(self.post('/api/growth/pet',{'pet_id':'moon'}).status_code,409)
  p=self.post('/api/growth/pet',{'pet_id':'moon','confirm_swap':True}).json();self.assertEqual(p['pet_xp'],0);self.assertEqual(p['xp'],40)
  self.assertEqual(self.post('/api/growth/pet',{'pet_id':'star','confirm_swap':True}).status_code,409)
  self.assertEqual(self.post('/api/growth/pet',{'pet_id':'moon'}).status_code,200)
  self.login('manager')
  with SessionLocal() as db:self.assertEqual(reward(db,db.get(Account,self.ids['manager']),'preview','games',100,100)['reason'],'preview')
 def test_daily_limits_idempotence_and_achievements(self):
  with SessionLocal() as db:
   a=db.get(Account,self.ids['worker']);r=reward(db,a,'first','theory',20,10,theory=1);self.assertIn('Первый шаг',r['achievements'])
   self.assertEqual(reward(db,a,'first','theory',20,10,theory=1)['xp'],0)
   for i in range(80):reward(db,a,'bulk:'+str(i),'games',9,4,game_correct=1)
   db.commit();p=db.get(LearningProfile,a.id);self.assertEqual(p.xp,400);self.assertEqual(p.gold,200);self.assertEqual(db.scalar(select(func.count(RewardEvent.id))),81)
 def test_shop_insufficient_money_tampered_price_replay_and_equipment(self):
  self.post('/api/growth/pet',{'pet_id':'prism'})
  self.assertEqual(self.post('/api/growth/buy',{'item_id':'artifact-lantern'}).status_code,409)
  self.assertEqual(self.post('/api/growth/buy',{'item_id':'artifact-lantern','price':0}).status_code,422)
  with SessionLocal() as db:reward(db,db.get(Account,self.ids['worker']),'seed','games',100,100);db.commit()
  first=self.post('/api/growth/buy',{'item_id':'artifact-lantern'}).json();self.assertEqual(first['gold'],40)
  self.assertEqual(self.post('/api/growth/buy',{'item_id':'artifact-lantern'}).json()['gold'],40)
  self.assertEqual(self.client.put('/api/growth/equip',json={'slot':'wings','item_id':'artifact-lantern'},headers=self.headers).status_code,409)
  r=self.client.put('/api/growth/equip',json={'slot':'artifact','item_id':'artifact-lantern'},headers=self.headers);self.assertEqual(r.json()['equipped']['artifact'],'artifact-lantern')
  r=self.client.put('/api/growth/equip',json={'slot':'artifact','item_id':None},headers=self.headers);self.assertEqual(r.json()['equipped'],{})
 def test_avatar_sanitization_tenant_access_delete_and_csrf(self):
  image=Image.new('RGB',(600,400),'red');buf=io.BytesIO();image.save(buf,'PNG')
  r=self.client.post('/api/growth/avatar',files={'file':('avatar.png',buf.getvalue(),'image/png')},headers=self.headers);self.assertEqual(r.status_code,200,r.text)
  url=r.json()['avatar_url'];res=self.client.get(url);self.assertEqual(res.status_code,200)
  self.assertEqual(Image.open(io.BytesIO(res.content)).size,(256,256))
  self.assertEqual(self.client.post('/api/growth/avatar',files={'file':('x.svg',b'<svg><script/></svg>','image/svg+xml')},headers=self.headers).status_code,400)
  self.assertEqual(self.client.post('/api/growth/avatar',files={'file':('x.png',buf.getvalue(),'image/png')}).status_code,403)
  self.login('peer');self.assertEqual(self.client.get(url).status_code,403)
  self.login('manager');self.assertEqual(self.client.get(url).status_code,200)
  self.assertEqual(self.client.get('/api/growth/employees/'+str(self.ids['worker'])).status_code,200)
  self.login('foreign');self.assertEqual(self.client.get(url).status_code,404)
  self.assertEqual(self.client.get('/api/growth/employees/'+str(self.ids['worker'])).status_code,404)
  self.login('worker');self.client.delete('/api/growth/avatar',headers=self.headers);self.assertEqual(self.client.get(url).status_code,404)
 def test_card_rewards_do_not_mark_exam_or_theory(self):
  path=f'/api/learning/{self.cid}/cards/0/practice'
  self.assertEqual(self.post(path,{}).json()['reward']['xp'],2);self.assertEqual(self.post(path,{}).json()['reward']['xp'],0)
  self.assertEqual(self.post(f'/api/learning/{self.cid}/cards/999/practice',{}).status_code,404)
  self.assertEqual(self.client.get('/api/learning/'+str(self.cid)).json()['lessons'][0]['completed'],False)
  self.assertEqual(self.client.get('/api/learning/history').json(),[])
 def test_words_subset_decoys_strict_ids_and_difficulty(self):
  def start(d):return self.post(f'/api/games/{self.cid}/start',{'mode':'words','size':6,'difficulty':d}).json()
  normal=start('normal');q=next(q for q in normal['questions'] if q['answer']=='90 °C');self.assertGreater(len(q['tokens']),2)
  solution=token_solution(q);rid=normal['id'];path='/api/games/runs/'+rid+'/answer'
  r=self.post(path,{'event_id':'subset-valid','question_id':q['id'],'value':solution});self.assertTrue(r.json()['correct']);self.assertEqual(r.json()['reward']['xp'],6)
  self.assertEqual(self.post(path,{'event_id':'subset-valid','question_id':q['id'],'value':solution}).json()['reward']['xp'],6)
  self.assertEqual(self.post(path,{'event_id':'duplicates','question_id':q['id'],'value':[solution[0],solution[0]]}).status_code,400)
  harder=start('hard');q2=next(x for x in harder['questions'] if x['id']==q['id']);self.assertGreaterEqual(len(q2['tokens']),len(q['tokens']))
  r=self.post('/api/games/runs/'+harder['id']+'/answer',{'event_id':'cross-run','question_id':q2['id'],'value':token_solution(q2)});self.assertTrue(r.json()['correct']);self.assertEqual(r.json()['reward']['xp'],0)
  self.assertEqual(self.post(f'/api/games/{self.cid}/start',{'mode':'words','difficulty':'impossible'}).status_code,422)
 def test_hard_truth_two_decisions_and_scenario_choice_count(self):
  run=self.post(f'/api/games/{self.cid}/start',{'mode':'truth','size':1,'difficulty':'hard'}).json();q=run['questions'][0];path='/api/games/runs/'+run['id']+'/answer'
  self.assertEqual(self.post(path,{'event_id':'hard-bool','question_id':q['id'],'value':q['claim_true']}).status_code,400)
  self.assertFalse(self.post(path,{'event_id':'hard-wrong','question_id':q['id'],'value':[int(q['claim_true']),(q['correct_index']+1)%4]}).json()['correct'])
  self.assertTrue(self.post(path,{'event_id':'hard-correct','question_id':q['id'],'value':[int(q['claim_true']),q['correct_index']]}).json()['correct'])
  for d,n in [('easy',2),('normal',3),('hard',4)]:
   run=self.post(f'/api/games/{self.cid}/start',{'mode':'scenario','size':1,'difficulty':d}).json();self.assertEqual(len(run['questions'][0]['choices']),n)
 def test_openai_opt_in_budget_before_http_and_usage_on_invalid_json(self):
  sent=[];client_class=httpx.AsyncClient
  def response(request):
   sent.append(json.loads(request.content));return httpx.Response(200,json={'model':'gpt-6-luna','usage':{'prompt_tokens':1000,'completion_tokens':200,'prompt_tokens_details':{'cached_tokens':100}},'choices':[{'message':{'content':'invalid JSON'}}]})
  patches=[patch.object(ai,'AI_PROVIDER','openai'),patch.object(ai,'OPENAI_API_KEY','unit-key'),patch.object(ai,'OPENAI_ENABLED',True),patch.object(ai,'OPENAI_MODEL','gpt-6-luna'),patch.object(ai.httpx,'AsyncClient',side_effect=lambda **kw:client_class(transport=httpx.MockTransport(response),**kw))]
  for p in patches:p.start();self.addCleanup(p.stop)
  with patch.dict(os.environ,{'OPENAI_DAILY_BUDGET_USD':'0'}):
   with self.assertRaisesRegex(ValueError,'лимит OpenAI'):asyncio.run(ai.call_model('Theory JSON','ai-budget-test','lease'))
  self.assertEqual(sent,[])
  with self.assertRaisesRegex(ValueError,'некорректный JSON'):asyncio.run(ai.call_model('Theory JSON','ai-budget-test','lease'))
  self.assertEqual(sent[0]['response_format']['type'],'json_schema');self.assertFalse(sent[0]['store']);self.assertNotIn('max_tokens',sent[0]);self.assertNotIn('models',sent[0]);self.assertNotIn('provider',sent[0])
  with SessionLocal() as db:
   usage=db.scalar(select(AIUsage));self.assertEqual(usage.input_tokens,1000);self.assertEqual(usage.output_tokens,200);self.assertEqual(usage.cost_micro_usd,191);self.assertEqual(usage.status,'recorded')
  with patch.object(ai,'OPENAI_ENABLED',False):self.assertIsNone(ai.provider())
 def test_budget_unknown_model_missing_usage_and_nonfinite_config(self):
  with SessionLocal() as db:
   job=db.get(Job,'ai-budget-test')
   with self.assertRaisesRegex(ValueError,'проверенного тарифа'):ai_budget.reserve(db,job,'unknown','p','s',10)
   uid=ai_budget.reserve(db,job,'gpt-6-luna','p','s',10);ai_budget.settle(db,uid,None);db.commit()
   item=db.get(AIUsage,uid);self.assertIsNone(item.cost_micro_usd);self.assertEqual(item.status,'unconfirmed');self.assertGreater(ai_budget.overview(db)['daily_usd'],0)
  with patch.dict(os.environ,{'OPENAI_DAILY_BUDGET_USD':'NaN'}):
   with self.assertRaises(ValueError):ai_budget.limits()
 def test_exam_rewards_three_daily_attempts_and_later_perfect(self):
  from baros.v2.learning import finish
  from baros.v2.domain import parse
  with SessionLocal() as db:
   pool=[{**questions()[i%6],'prompt':'Exam '+str(i)} for i in range(10)]
   for number in range(4):
    answers={str(i):0 if number or i<8 else 1 for i in range(10)}
    exam=Exam(id='reward-exam-'+str(number),account_id=self.ids['worker'],revision_id=self.rev,
     questions_json=dump(pool),answers_json=dump(answers),started_at=now()-timedelta(seconds=40),expires_at=now()+timedelta(minutes=5))
    db.add(exam);db.flush();result=finish(db,exam,{'passing_score':80});db.commit()
    self.assertEqual(result.get('reward',{}).get('xp',0),30 if number<3 else 0)
    self.assertEqual(result['pass_reward']['xp'],50 if number==0 else 0)
    if number==0:first=result;first_exam=exam.id
   p=db.get(LearningProfile,self.ids['worker']);self.assertEqual(p.xp,140)
   self.assertEqual(parse(p.stats)['exam_passed'],1);self.assertEqual(parse(p.stats)['perfect'],1);self.assertEqual(parse(p.stats)['swift'],1)
   self.assertEqual(finish(db,db.get(Exam,first_exam),{'passing_score':80}),first)
   self.assertEqual(db.get(LearningProfile,self.ids['worker']).xp,140)
 def test_recent_provider_call_limit_includes_retry_of_old_job(self):
  with SessionLocal() as db:
   job=db.get(Job,'ai-budget-test');job.created_at=now()-timedelta(days=3)
   db.add(AIUsage(id='recent-on-old-job',job_id=job.id,organization_id=self.oid,provider='openai',model='gpt-6-luna',reserved_micro_usd=0,cost_micro_usd=0,status='recorded',created_at=now()));db.commit()
  with patch.object(ai,'AI_PROVIDER','openai'),patch.object(ai,'OPENAI_API_KEY','unit-key'),patch.object(ai,'OPENAI_ENABLED',True),patch.dict(os.environ,{'AI_PROVIDER_DAILY_CALL_LIMIT':'1'}),patch.object(ai.httpx,'AsyncClient') as client:
   with self.assertRaisesRegex(ValueError,'Дневной лимит'):asyncio.run(ai.call_model('Theory JSON','ai-budget-test','lease'))
   client.assert_not_called()
 def test_ai_usage_excludes_free_calls_and_respects_venue_scope(self):
  with SessionLocal() as db:
   other=db.get(Account,self.ids['foreign']);db.add(Job(id='foreign-ai',organization_id=other.organization_id,account_id=other.id,context='Other',positions_json='[]'));db.flush()
   for uid,jid,oid,provider,cost in [('free','ai-budget-test',self.oid,'openrouter',0),('ours','ai-budget-test',self.oid,'openai',100000),('other','foreign-ai',other.organization_id,'openai',200000)]:
    db.add(AIUsage(id=uid,job_id=jid,organization_id=oid,provider=provider,model='gpt-6-luna' if provider=='openai' else 'free',reserved_micro_usd=cost,cost_micro_usd=cost,status='recorded'))
   db.commit()
  self.assertEqual(self.client.get('/api/ai/usage').status_code,403)
  self.login('manager');u=self.client.get('/api/ai/usage').json();self.assertEqual(u['daily_usd'],.1);self.assertEqual(len(u['requests']),1);self.assertIsNone(u['limits_usd'])
  self.login('owner');u=self.client.get('/api/ai/usage').json();self.assertEqual(u['daily_usd'],.3);self.assertEqual(len(u['requests']),2);self.assertIsNotNone(u['limits_usd'])

if __name__=='__main__':unittest.main()
