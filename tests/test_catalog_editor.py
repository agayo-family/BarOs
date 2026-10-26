"""Shared-library drafts require owner review and preserve the approved release."""
import copy
import importlib
import os
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault('DATABASE_URL', 'sqlite:///' + tempfile.mktemp(prefix='catalog-editor-') + '.db')
os.environ['BAROS_WORKER'] = '0'
from fastapi.testclient import TestClient
from sqlalchemy import select
from baros.db import Base, engine, SessionLocal
from baros.models import Organization, Course
from baros.security import hash_password
from baros.v2 import catalog
from baros.v2.domain import dump, parse
from baros.v2.models import Account, CourseSettings, Setting, VenueSettings
from baros.v2.schemas import CourseIn

app = importlib.import_module('baros.v2.app').app


class CatalogEditorTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine)
        self.client = TestClient(app); self.client.__enter__()
        course = CourseIn(title='Сервис общего курса', positions=['waiter'], quiz_size=1,
            lessons=[{'title':'Проверка заказа','body':'Перед подачей повторяют номер заказа и согласованное изменение.'}],
            questions=[{'prompt':'Что сверяют перед подачей?', 'choices':['Заказ и изменение','Заказ и оплату','Оплату и бронь','Бронь и изменение'],
                        'correct_index':0,'explanation':'В уроке указаны номер заказа и изменение.'}]).model_dump(mode='json')
        self.base = {'version':'fixture','roles':['waiter'],'fingerprint':'1'*64,'courses':[
            {'key':'waiter-fixture','role':'waiter','version':2,'outcomes':['Проверить заказ перед подачей'],
             'sources':[],'course':course}]}
        self.mock = patch.object(catalog, 'candidate', return_value=self.base); self.mock.start()
        with SessionLocal() as db:
            o=Organization(name='Existing venue');db.add(o);db.flush();self.oid=o.id
            db.add(VenueSettings(organization_id=o.id,join_code='EDITOR01'))
            for role in ['owner','manager','employee']:
                db.add(Account(name=role,login='editor-'+role,role=role,
                    organization_id=None if role=='owner' else o.id,
                    password_hash=hash_password('catalog-editor-password')))
            db.commit()
        self.login('owner')

    def tearDown(self):
        self.mock.stop();self.client.__exit__(None,None,None)

    def login(self, role):
        self.client.cookies.clear()
        self.assertEqual(self.client.post('/api/auth/login',json={'login':'editor-'+role,'password':'catalog-editor-password'}).status_code,200)
        self.headers={'x-csrf-token':self.client.get('/api/me').json()['csrf']}

    def body(self):
        item=self.client.get('/api/owner/catalog/courses/waiter-fixture').json()
        return {'course':item['course'],'outcomes':item['outcomes'],'edit_version':item['edit_version']}

    def save(self, data):
        return self.client.put('/api/owner/catalog/courses/waiter-fixture',json=data,headers=self.headers)

    def approve(self, listing=None):
        listing=listing or self.client.get('/api/owner/catalog').json()
        return self.client.post('/api/owner/catalog/activate',json={'reviewed':True,
            'fingerprint':listing['fingerprint'],'expected_revision':listing['revision']},headers=self.headers)

    def test_owner_changes_theory_questions_and_outcomes_without_automatic_publication(self):
        before=self.client.get('/api/owner/catalog').json();data=self.body()
        data['course']['lessons'][0]['body']='Уточните номер заказа, а затем сверяйте согласованное изменение.'
        data['course']['questions'][0]['choices'][1]='Заказ и количество гостей'
        data['outcomes']=['Сверить адресата и согласованное изменение']
        result=self.save(data);self.assertEqual(result.status_code,200,result.text)
        item=self.client.get('/api/owner/catalog/courses/waiter-fixture').json()
        self.assertEqual(item['course']['lessons'],data['course']['lessons'])
        self.assertEqual(item['course']['questions'],data['course']['questions'])
        self.assertEqual(item['outcomes'],data['outcomes']);self.assertEqual(item['version'],3)
        self.assertEqual(item['edit_version'],1);self.assertNotEqual(item['fingerprint'],before['fingerprint'])
        self.assertFalse(self.client.get('/api/owner/catalog').json()['enabled'])
        with SessionLocal() as db:
            self.assertIsNone(db.scalar(select(Course)))
            self.assertFalse(parse(db.get(Setting,catalog.STATE_KEY).value).get('enabled'))

    def test_edit_does_not_change_current_venues_or_approved_future_copies_until_review(self):
        self.assertEqual(self.approve().status_code,200)
        reviewed=self.client.get('/api/owner/catalog').json();data=self.body()
        data['course']['title']='Отредактированный общий курс';self.assertEqual(self.save(data).status_code,200)
        future=self.client.post('/api/venues',json={'name':'Future venue'},headers=self.headers)
        self.assertEqual(future.status_code,200,future.text)
        with SessionLocal() as db:
            self.assertTrue(all(c.title=='Сервис общего курса' for c in db.scalars(select(Course)).all()))
        self.assertEqual(self.approve(reviewed).status_code,409)
        self.assertEqual(self.approve().status_code,200)
        with SessionLocal() as db:
            self.assertTrue(all(c.title==data['course']['title'] for c in db.scalars(select(Course)).all()))

    def test_stale_save_cannot_replace_another_window(self):
        first=self.body();stale=copy.deepcopy(first);first['course']['title']='Первая правка'
        self.assertEqual(self.save(first).status_code,200)
        stale['course']['title']='Устаревшая правка';self.assertEqual(self.save(stale).status_code,409)
        self.assertEqual(self.body()['course']['title'],'Первая правка')

    def test_editor_permission_csrf_role_and_bank_guards(self):
        data=self.body()
        self.assertEqual(self.client.put('/api/owner/catalog/courses/waiter-fixture',json=data).status_code,403)
        data['course']['positions']=['bartender'];self.assertEqual(self.save(data).status_code,400)
        data=self.body();data['course']['quiz_size']=2;self.assertEqual(self.save(data).status_code,400)
        for role in ['manager','employee']:
            self.login(role);self.assertEqual(self.save(data).status_code,403)
            self.assertEqual(self.client.get('/api/owner/catalog/courses/waiter-fixture').status_code,403)

    def test_owner_edits_survive_new_shipped_template_and_local_venue_edits_are_preserved(self):
        self.assertEqual(self.approve().status_code,200)
        with SessionLocal() as db:
            c=db.scalar(select(Course));c.title='Локальная правка заведения';db.commit()
        data=self.body();data['course']['title']='Правка владельца библиотеки';self.assertEqual(self.save(data).status_code,200)
        changed=copy.deepcopy(self.base);changed['courses'][0]['course']['title']='Новая поставка исходного шаблона'
        with patch.object(catalog,'candidate',return_value=changed):
            self.assertEqual(self.body()['course']['title'],data['course']['title'])
            result=self.approve();self.assertEqual(result.status_code,200,result.text)
            self.assertEqual(result.json()['customized'],1)
        with SessionLocal() as db:self.assertEqual(db.scalar(select(Course)).title,'Локальная правка заведения')
