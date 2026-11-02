"""Private support, neutral copy and safe failure messages for pilot users."""
import unittest,os
from pathlib import Path
from sqlalchemy import select
import test_packages as fixtures
from baros.db import SessionLocal
from baros.v2.models import Account,SupportTicket,Notice,VenueSettings
from baros.security import hash_password

class SupportTests(unittest.TestCase):
 setUp=fixtures.PackageTests.setUp
 tearDown=fixtures.PackageTests.tearDown
 login=fixtures.PackageTests.login
 post=fixtures.PackageTests.post
 def create(self):
  r=self.post('/api/support',{'category':'learning','message':'Не открывается назначенный курс. Как продолжить обучение?'});self.assertEqual(r.status_code,200,r.text);return r.json()
 def owner(self):
  with SessionLocal() as db:
   db.add(Account(role='owner',login='support.owner',name='Администратор',password_hash=hash_password('test-import-password')));db.commit()
  self.login('support.owner')
 def test_private_ticket_and_role_isolation(self):
  t=self.create();self.assertEqual(len(self.client.get('/api/support').json()['items']),1)
  for who in ['worker','peer','foreign']:
   self.login(who);self.assertEqual(self.client.get('/api/support/'+str(t['id'])).status_code,404);self.assertEqual(self.client.get('/api/support').json()['items'],[])
  self.login('manager');self.assertEqual(self.client.get('/api/support/'+str(t['id'])).status_code,200)
 def test_owner_reply_notice_and_conflict(self):
  self.owner();self.login('manager');t=self.create();self.owner_login()
  body={'version':t['version'],'response':'Откройте курс через раздел обучения и повторите попытку.','status':'closed'}
  r=self.client.put('/api/support/'+str(t['id']),json=body,headers=self.headers);self.assertEqual(r.status_code,200,r.text)
  self.assertEqual(self.client.put('/api/support/'+str(t['id']),json=body,headers=self.headers).status_code,409)
  self.login('manager');self.assertEqual(self.client.get('/api/support/'+str(t['id'])).json()['status'],'closed')
  with SessionLocal() as db:
   note=db.scalar(select(Notice).where(Notice.account_id==self.ids['manager'],Notice.event_key.like('support-answer:%')));self.assertIsNotNone(note);self.assertNotIn(body['response'],note.body)
 def owner_login(self):self.login('support.owner')
 def test_no_employee_can_reply_or_change_another_ticket(self):
  t=self.create();self.assertEqual(self.client.put('/api/support/'+str(t['id']),json={'version':1,'response':'Ответ','status':'closed'},headers=self.headers).status_code,403)
  self.login('worker');self.assertEqual(self.client.put('/api/support/'+str(t['id']),json={'version':1,'response':'Ответ','status':'closed'},headers=self.headers).status_code,403)
 def test_csrf_validation_and_expired_subscription_support(self):
  self.assertEqual(self.client.post('/api/support',json={'message':'Вопрос по работе платформы'}).status_code,403)
  self.assertEqual(self.post('/api/support',{'message':'   '}).status_code,422)
  self.assertEqual(self.post('/api/support',{'message':'a'*4001}).status_code,422)
  with SessionLocal() as db:db.get(VenueSettings,self.oid).subscription_status='past_due';db.commit()
  self.create()
  with SessionLocal() as db:db.get(VenueSettings,self.oid).status='suspended';db.commit()
  self.create()
  self.assertEqual(self.client.get('/api/support',headers={'x-organization-id':'99999'}).status_code,403)
 def test_rate_limit_does_not_create_extra_ticket(self):
  for _ in range(8):self.create()
  r=self.post('/api/support',{'message':'Ещё один вопрос по работе платформы'});self.assertEqual(r.status_code,429)
  with SessionLocal() as db:self.assertEqual(len(db.scalars(select(SupportTicket)).all()),8)
 def test_current_customer_modules_have_no_creator_or_provider_copy(self):
  import re
  pattern=re.compile(r'(?<![A-Za-zА-Яа-яЁё])(?:AI|ИИ)(?![A-Za-zА-Яа-яЁё])|ChatGPT|Qwen|Yandex AI|ergin|frooppe|На, стой-ка|Сергей|sergey|Render|FIRST_RUN_TOKEN|SESSION_SECRET')
  for name in ['manage','drafts','editor','mentor','owner','catalog','packages','experience','support','auth','app','landing','pricing-editor']:
   source=Path('baros/static/v2/'+name+'.js').read_text();self.assertIsNone(pattern.search(source),name)
  from baros.v2.catalog import candidate
  for item in candidate()['courses']:
   course=item['course'];texts=[course['title'],course['description']]
   texts += [v for lesson in course['lessons'] for v in lesson.values() if isinstance(v,str)]
   texts += [v for q in course['questions'] for v in [q['prompt'],q['explanation'],*q['choices']]]
   self.assertIsNone(pattern.search('\n'.join(texts)),item['key'])
