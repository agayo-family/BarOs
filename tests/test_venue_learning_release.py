"""Regression coverage for venue course lifecycle, focus-mode attempts and privacy."""

import io
import json
import os
import tempfile
import unittest
from zipfile import ZipFile

os.environ.setdefault('DATABASE_URL','sqlite:///'+tempfile.mktemp(prefix='baros-venue-release-',suffix='.db'))
os.environ['BAROS_WORKER']='0'

from fastapi.testclient import TestClient
from PIL import Image

from baros.db import Base, engine, SessionLocal
from baros.main import app
from baros.security import hash_password
from baros.v2.models import Account, CourseRevision, LessonRead, Notice
from sqlalchemy import select


def course(title, stem, amount=65, quiz_size=3):
    return {'title':title,'positions':['bartender'],'quiz_size':quiz_size,'max_attempts':1,
            'lessons':[{'title':'Подача','body':'Проверьте состав и посуду перед подачей напитка.'}],
            'questions':[{'prompt':f'{stem}. Какие действия подходят в рабочей ситуации {i}?',
                          'choices':['Уточнить состав и посуду','Спросить о настроении','Сверить график','Проверить журнал смен'],
                          'correct_index':0,'explanation':'Перед подачей нужно уточнить состав и посуду.','type':'scenario'}
                         for i in range(amount)]}


class VenueLearningReleaseTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine)
        self.context=TestClient(app)
        self.context.__enter__()
        self.addCleanup(self.context.__exit__,None,None,None)
        with SessionLocal() as db:
            db.add(Account(name='Проверка владельца',login='release.owner',role='owner',
                           password_hash=hash_password('test-release-only')))
            db.commit()
        self.owner=self.login('release.owner')
        self.venue=self.request('POST','/api/venues',json={'name':'Тестовый Бульдог'},headers=self.owner)
        self.other=self.request('POST','/api/venues',json={'name':'Тестовая Настойка'},headers=self.owner)
        self.headers={**self.owner,'x-organization-id':str(self.venue['id'])}
        self.other_headers={**self.owner,'x-organization-id':str(self.other['id'])}

    def request(self, method, path, expected=200, **kw):
        response=self.context.request(method,path,**kw)
        self.assertEqual(response.status_code,expected,response.text[:600] if response.content else '')
        if 'application/json' in response.headers.get('content-type',''):
            return response.json()
        return response

    def me(self):
        return {'x-csrf-token':self.request('GET','/api/me')['csrf']}

    def login(self, login):
        self.request('POST','/api/auth/login',json={'login':login,'password':'test-release-only'})
        return self.me()

    def join(self, login, role='bartender', venue=None):
        self.request('POST','/api/auth/join',json={'code':(venue or self.venue)['join_code'],'name':login.title(),
                     'login':login,'password':'test-release-only','positions':[role]})
        return self.me()

    def publish(self, title, stem):
        draft=self.request('POST','/api/courses',headers=self.headers,json=course(title,stem))
        self.request('POST',f"/api/courses/{draft['id']}/publish",headers=self.headers,
                     json={'reviewed':True,'edit_version':draft['edit_version']})
        return draft['id']

    def test_venue_deletion_restore_cover_and_library_distribution(self):
        cid=self.publish('Напитки бара','Стандарт напитков')
        img=io.BytesIO()
        Image.new('RGB',(120,80),'#925ecf').save(img,'PNG')
        cover=self.request('POST','/api/media',headers=self.headers,
                           files={'file':('cover.png',img.getvalue(),'image/png')})
        saved=self.request('PUT',f'/api/courses/{cid}/presentation',headers=self.headers,
                           json={'cover_id':cover['url'].split('/')[-1],'priority_override':'P0'})
        self.assertEqual(self.request('GET',saved['cover_url']).headers['content-type'],'image/jpeg')
        gallery=self.request('GET','/api/owner/catalog')
        key=gallery['courses'][0]['key']
        path=f'/api/owner/catalog/courses/{key}/distribute'
        opts={'venue_ids':[self.other['id']],'fingerprint':gallery['fingerprint']}
        copy=self.request('POST',path,headers=self.owner,json=opts)[0]
        self.assertEqual(copy['status'],'draft')
        self.assertEqual(self.request('POST',path,headers=self.owner,json=opts)[0]['course_id'],copy['course_id'])
        self.assertEqual([x['id'] for x in self.request('GET','/api/courses',headers=self.headers)],[cid])
        self.join('cover.worker')
        row=self.request('GET','/api/learning')['courses'][0]
        self.assertEqual((row['cover_url'],row['priority']),(saved['cover_url'],'P0'))
        self.assertEqual(self.request('GET',row['cover_url']).headers['content-type'],'image/jpeg')
        self.join('other.worker',venue=self.other)
        self.request('GET',row['cover_url'],404)
        self.headers={**self.login('release.owner'),'x-organization-id':str(self.venue['id'])}
        self.request('DELETE',f'/api/courses/{cid}',headers=self.headers)
        self.assertEqual(self.request('GET','/api/courses',headers=self.headers),[])
        self.assertEqual(len(self.request('GET','/api/courses?trash=true',headers=self.headers)),1)
        self.request('GET',f'/api/courses/{cid}',404,headers=self.headers)
        self.request('POST',f'/api/courses/{cid}/restore',headers=self.headers)
        self.login('cover.worker')
        self.assertEqual(self.request('GET','/api/learning')['courses'][0]['id'],cid)

    def test_zip_preview_selection_manifest_priority_and_idempotence(self):
        buffer=io.BytesIO()
        with ZipFile(buffer,'w') as archive:
            for filename,name in [('local.baros.json','Барное меню'),('foreign.baros.json','Чайная карта'),
                                  ('blocked.baros.json','На проверке'),('unlisted.baros.json','Проверка без строки')]:
                archive.writestr('Пакеты/'+filename,json.dumps({'format':'baros-package','version':1,'kind':'course',
                    'course':course(name,name,4)},ensure_ascii=False))
            archive.writestr('Реестр/packages_manifest.csv','file,venues,priority,readiness\n'
                             'local.baros.json,Бульдог,P1,ЧЕРНОВИК\nforeign.baros.json,Настойка,P2,ЧЕРНОВИК\n'
                             'blocked.baros.json,Бульдог,P0,ЗАБЛОКИРОВАН\n')
        files={'file':('three-venues.zip',buffer.getvalue(),'application/zip')}
        preview=self.request('POST','/api/packages/zip/preview',headers=self.headers,files=files)
        self.assertEqual(preview['suggested_venue'],'Бульдог')
        self.assertTrue(next(row for row in preview['entries'] if row['blocked'])['error'])
        opts={'archive_hash':preview['hash'],'selection':json.dumps(['Пакеты/local.baros.json','Пакеты/foreign.baros.json']),
              'archive_venue':'Бульдог'}
        self.request('POST','/api/packages/zip/import',409,headers=self.headers,files=files,data=opts)
        self.assertEqual(self.request('GET','/api/courses',headers=self.headers),[])
        opts['selection']=json.dumps(['Пакеты/local.baros.json'])
        self.assertEqual(self.request('POST','/api/packages/zip/import',headers=self.headers,files=files,data=opts)['imported'],1)
        self.assertEqual(self.request('POST','/api/packages/zip/import',headers=self.headers,files=files,data=opts)['imported'],0)
        self.assertEqual(self.request('GET','/api/courses',headers=self.headers)[0]['priority'],'P1')
        unlisted=next(row for row in preview['entries'] if row['unlisted'])
        opts['selection']=json.dumps([unlisted['file']])
        self.request('POST','/api/packages/zip/import',409,headers=self.headers,files=files,data=opts)
        opts['include_unlisted']='true'
        self.assertEqual(self.request('POST','/api/packages/zip/import',headers=self.headers,files=files,data=opts)['imported'],1)


    def test_interruption_refreshes_course_and_role_questions_and_omits_scoring(self):
        first=self.publish('Барная практика','Процедура у стойки')
        second=self.publish('Подготовка посуды','Подготовка стаканов')
        headers=self.join('focus.worker')
        with SessionLocal() as db:
            from baros.v2.domain import now
            aid=db.scalar(select(Account.id).where(Account.login=='focus.worker'))
            rid=db.scalar(select(CourseRevision.id).where(CourseRevision.course_id==first))
            db.add(LessonRead(account_id=aid,revision_id=rid,lesson_index=0,completed_at=now()))
            db.commit()
        exam=self.request('POST',f'/api/learning/{first}/exam',headers=headers,json={})
        self.request('POST',f"/api/exams/{exam['id']}/interrupt",headers=headers,json={})
        self.request('POST',f"/api/exams/{exam['id']}/finish",409,headers=headers,json={'answers':{}})
        self.assertEqual(self.request('GET','/api/learning/history'),[])
        fresh=self.request('POST',f'/api/learning/{first}/exam',headers=headers,json={})
        self.assertTrue({q['prompt'] for q in exam['questions']}.isdisjoint(q['prompt'] for q in fresh['questions']))
        self.request('POST',f"/api/exams/{fresh['id']}/interrupt",headers=headers,json={})
        role=self.request('POST','/api/role-exams/bartender/start',headers=headers,json={})
        self.assertEqual({q['source_course_id'] for q in role['tasks']},{first,second})
        role=self.request('POST',f"/api/assessment-attempts/{role['id']}/advance",headers=headers,json={'version':role['version']})
        self.assertTrue(any(task['kind']=='written' and 'rubric' not in task for task in role['tasks']))
        self.request('POST',f"/api/assessment-attempts/{role['id']}/interrupt",headers=headers,json={})
        new_role=self.request('POST','/api/role-exams/bartender/start',headers=headers,json={})
        self.assertNotEqual(role['id'],new_role['id'])
        self.assertTrue({q['id'] for q in role['tasks']}.isdisjoint(q['id'] for q in new_role['tasks']))
        self.request('GET','/api/role-exams/cook',404)

    def test_stop_list_team_privacy_and_unread_count(self):
        bartender=self.join('bar.worker')
        self.request('POST','/api/growth/pet',headers=bartender,json={'pet_id':'storm'})
        item=self.request('POST','/api/stop-list',headers=bartender,json={'station':'bar','name':'Какао'})
        self.request('POST','/api/stop-list',403,headers=bartender,json={'station':'kitchen','name':'Паста'})
        self.request('PUT',f"/api/stop-list/{item['id']}",headers=bartender,json={'unavailable':True,'version':item['version']})
        self.join('foreign.worker',venue=self.other)
        self.assertEqual(self.request('GET','/api/stop-list')['items'],[])
        waiter=self.join('floor.worker','waiter')
        self.assertEqual([x['name'] for x in self.request('GET','/api/stop-list')['items']],['Какао'])
        self.request('PUT',f"/api/stop-list/{item['id']}",403,headers=waiter,json={'unavailable':False,'version':2})
        people=self.request('GET','/api/growth/team')
        self.assertEqual([row['name'] for row in people],['Bar.Worker','Floor.Worker'])
        self.assertEqual(people[0]['pet_id'],'storm')
        self.assertEqual(set(people[0]),{'id','name','positions','pet_id','avatar_url','decorations'})
        uid=people[1]['id']
        with SessionLocal() as db:
            db.add_all([Notice(account_id=uid,event_key=f'test:{i}',title='Сообщение',body='Проверка') for i in range(3)])
            db.commit()
        self.assertEqual(self.request('GET','/api/notices/count')['unread'],3)
        nid=self.request('GET','/api/notices')[0]['id']
        self.assertEqual(self.request('POST',f'/api/notices/{nid}/read',headers=waiter,json={})['unread'],2)
        self.assertEqual(self.request('POST','/api/notices/read',headers=waiter,json={})['unread'],0)
        self.assertTrue(all(row['read'] for row in self.request('GET','/api/notices')))
