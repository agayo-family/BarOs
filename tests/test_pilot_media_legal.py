"""Real media access, source-bound draft assembly and legal-version persistence."""
import copy, io, unittest
from unittest.mock import patch
from PIL import Image
from sqlalchemy import select, func
import test_packages as fixtures
from baros.db import SessionLocal
from baros.models import Course
from baros.v2.models import CourseMedia, LegalAcceptance, ImportedAssessment, SourceFile, Account
from baros.security import hash_password
from baros.v2.domain import parse

class PilotTests(unittest.TestCase):
    setUp=fixtures.PackageTests.setUp
    tearDown=fixtures.PackageTests.tearDown
    login=fixtures.PackageTests.login
    post=fixtures.PackageTests.post

    def photo(self):
        image=Image.new('RGB',(1800,1000),'#91adbd');exif=Image.Exif();exif[270]='private camera metadata'
        b=io.BytesIO();image.save(b,format='JPEG',exif=exif)
        r=self.client.post('/api/media',headers=self.headers,files={'file':('glass.jpg',b.getvalue(),'image/jpeg')})
        self.assertEqual(r.status_code,200,r.text);return r.json()

    def course(self,url):
        body=copy.deepcopy(fixtures.COURSE['course']);body['lessons'][0]['body']+='\n\n![Учебная иллюстрация]('+url+')'
        body['questions'][0]['prompt']+='\n![Иллюстрация к вопросу]('+url+')'
        r=self.post('/api/courses',body);self.assertEqual(r.status_code,200,r.text);return r.json(),body

    def test_photo_real_sanitization_and_tenant_role_publication_access(self):
        photo=self.photo();url=photo['url'];self.assertEqual(photo['width'],1600)
        with SessionLocal() as db:
            saved=db.get(CourseMedia,url.split('/')[-1]);clean=Image.open(io.BytesIO(saved.content))
            self.assertEqual(clean.format,'JPEG');self.assertFalse(clean.getexif());self.assertNotIn(b'private camera',saved.content)
        self.assertEqual(self.client.get(url).status_code,200)
        self.login('worker');self.assertEqual(self.client.get(url).status_code,404)
        self.login('foreign');self.assertEqual(self.client.get(url).status_code,404)
        self.login('manager');course,_=self.course(url)
        self.login('worker');self.assertEqual(self.client.get(url).status_code,404)
        self.login('manager');r=self.post('/api/courses/'+str(course['id'])+'/publish',{'reviewed':True,'edit_version':course['edit_version']});self.assertEqual(r.status_code,200,r.text)
        self.login('worker');r=self.client.get(url);self.assertEqual(r.status_code,200);self.assertEqual(r.headers['cache-control'],'no-store')
        cards=self.client.get('/api/learning/'+str(course['id'])+'/cards').json()['cards'];self.assertIn(url,cards[0]['question'])
        self.login('waiter');self.assertEqual(self.client.get(url).status_code,404)
        self.client.cookies.clear();self.assertEqual(self.client.get(url).status_code,401)

    def test_invalid_file_permissions_csrf_quota_and_foreign_reference(self):
        bad=self.client.post('/api/media',headers=self.headers,files={'file':('x.svg',b'<svg><script>alert(1)</script></svg>','image/svg+xml')});self.assertEqual(bad.status_code,400)
        self.assertEqual(self.client.post('/api/media',files={'file':('x.png',b'x','image/png')}).status_code,403)
        photo=self.photo();self.login('foreign')
        body=copy.deepcopy(fixtures.COURSE['course']);body['lessons'][0]['body']+='\n![]('+photo['url']+')'
        self.assertEqual(self.post('/api/courses',body).status_code,409)
        self.login('worker');self.assertEqual(self.client.post('/api/media',headers=self.headers,files={'file':('x.png',b'x','image/png')}).status_code,403)
        self.login('manager');self.assertEqual(self.client.post('/api/media?global_asset=true',headers=self.headers,files={'file':('x.png',b'x','image/png')}).status_code,403)

    def source(self,text):
        r=self.client.post('/api/sources',headers=self.headers,data={'roles':'["bartender"]'},files={'file':('standard.txt',text.encode(),'text/plain')});self.assertEqual(r.status_code,200,r.text);return r.json()['id']

    def test_local_assembly_is_reviewable_not_published_and_never_calls_ai(self):
        sid=self.source('# Подача напитка\nУточните пожелания гостя. Подтвердите состав заказа и передайте напиток по стандарту.\n# Завершение сервиса\nУбедитесь, что заказ соответствует пожеланиям. Сообщите управляющему о спорной ситуации.')
        with patch('baros.v2.ai.call_model') as ai:
            r=self.post('/api/drafts/assemble',{'source_ids':[sid],'title':'Сервис по стандарту','positions':['bartender']});self.assertEqual(r.status_code,200,r.text);ai.assert_not_called()
        result=r.json();self.assertFalse(result['published']);self.assertEqual(result['questions'],0);self.assertEqual(result['lessons'],2)
        with SessionLocal() as db:
            c=db.get(Course,result['course_id']);t=db.get(ImportedAssessment,result['assessment_id']);self.assertFalse(c.published);self.assertFalse(t.published)
            self.assertEqual({q['kind'] for q in parse(t.payload)['tasks']},{'written'})
        cid=result['course_id'];aid=result['assessment_id'];edit_version=self.client.get(f'/api/courses/{cid}').json()['edit_version']
        self.assertEqual(self.post(f'/api/courses/{cid}/publish',{'reviewed':True,'edit_version':edit_version}).status_code,409)
        self.assertEqual(self.post(f'/api/assessments/{aid}/publish',{'reviewed':True}).status_code,200)
        r=self.post(f'/api/courses/{cid}/publish',{'reviewed':True,'edit_version':edit_version});self.assertEqual(r.status_code,200,r.text)
        self.login('worker');cards=self.client.get(f'/api/learning/{cid}/cards').json()['cards'];self.assertEqual(len(cards),2)
        self.assertEqual(self.post(f'/api/learning/{cid}/cards/1/practice',{}).status_code,200)
        self.assertEqual(self.post(f'/api/learning/{cid}/cards/2/practice',{}).status_code,404)
        self.assertEqual(self.post(f'/api/learning/{cid}/exam',{}).status_code,409)

    def test_assembly_numeric_choices_from_real_facts_and_source_isolation(self):
        sid=self.source('# Объёмы\nКарта А: 20 мл\nКарта Б: 30 мл\nКарта В: 40 мл\nКарта Г: 50 мл\nПри подаче сверяйте название напитка и единицы измерения.')
        r=self.post('/api/drafts/assemble',{'source_ids':[sid],'title':'Карта объёмов','positions':['bartender']});self.assertEqual(r.status_code,200,r.text);self.assertEqual(r.json()['questions'],4)
        data=self.client.get('/api/courses/'+str(r.json()['course_id'])).json()
        for q in data['questions']:self.assertEqual(set(q['choices']),{'20 мл','30 мл','40 мл','50 мл'})
        self.login('foreign');self.assertEqual(self.post('/api/drafts/assemble',{'source_ids':[sid],'title':'Чужое обучение'}).status_code,404)
        self.login('worker');self.assertEqual(self.post('/api/drafts/assemble',{'source_ids':[sid],'title':'Без полномочий'}).status_code,403)

    def test_legal_documents_true_identity_and_explicit_versioned_ack(self):
        data=self.client.get('/api/legal').json();self.assertEqual(data['operator']['inn'],'121524098311');self.assertEqual(data['operator']['email'],'ergin.sergey2002@yandex.ru')
        self.assertIn('зарубежные',data['operator']['infrastructure']);self.assertEqual(len(data['documents']),5)
        body={'document':'privacy','version':data['version']}
        self.assertEqual(self.client.post('/api/legal/acknowledgements',json=body).status_code,403)
        for _ in range(2):self.assertEqual(self.post('/api/legal/acknowledgements',body).status_code,200)
        self.assertEqual(self.post('/api/legal/acknowledgements',{**body,'version':'obsolete'}).status_code,409)
        with SessionLocal() as db:self.assertEqual(db.scalar(select(func.count(LegalAcceptance.id))),1)
        self.login('worker');self.assertEqual(self.client.get('/api/legal/acknowledgements').json(),[])
        self.assertEqual(self.client.put('/api/owner/legal',headers=self.headers,json=data['operator']).status_code,403)

    def test_owner_changes_legal_version_and_recovery_shortcut_is_not_auth(self):
        with SessionLocal() as db:db.add(Account(role='owner',login='pilot.owner',name='Владелец',password_hash=hash_password('test-import-password')));db.commit()
        self.login('pilot.owner');before=self.client.get('/api/legal').json();body={**before['operator'],'postal_address':'Адрес для тестовой проверки'}
        r=self.client.put('/api/owner/legal',headers=self.headers,json=body);self.assertEqual(r.status_code,200,r.text);self.assertNotEqual(r.json()['version'],before['version'])
        self.assertEqual(self.client.put('/api/owner/legal',headers=self.headers,json=body).status_code,409)
        self.client.cookies.clear();r=self.client.get('/baros-vault',follow_redirects=False);self.assertEqual(r.status_code,307);self.assertEqual(r.headers['location'],'/owner-recovery')
        self.assertEqual(self.client.get('/api/me').status_code,401)

    def test_two_pricing_modes_are_separate_and_only_owner_can_edit(self):
        public=self.client.get('/api/pricing').json()
        for self_t,managed in zip(public['modes']['self']['tiers'],public['modes']['managed']['tiers']):
            self.assertLess(self_t['monthly'],managed['monthly']);self.assertEqual(self_t['preparation'],0);self.assertGreater(managed['preparation'],0)
        with SessionLocal() as db:db.add(Account(role='owner',login='pilot.owner',name='Владелец',password_hash=hash_password('test-import-password')));db.commit()
        self.login('pilot.owner');body={'version':0,'prices':[10000,16000,26000],'self_prices':[5000,8000,13000],'preparation':[30000,50000,80000]}
        r=self.client.put('/api/owner/pricing',headers=self.headers,json=body);self.assertEqual(r.status_code,200,r.text)
        r=self.client.put('/api/owner/pricing',headers=self.headers,json={**body,'version':1,'self_prices':[11000,17000,27000]});self.assertEqual(r.status_code,422)
        self.assertEqual(self.client.get('/api/pricing').json()['version'],1)

    def test_photo_quota_counts_source_files_and_rolls_back_upload(self):
        from baros.v2.models import VenueSettings
        with SessionLocal() as db:db.get(VenueSettings,self.oid).storage_limit_mb=1;db.commit()
        self.source('А'*(512*1024-1))
        with SessionLocal() as db:before=db.scalar(select(func.count(CourseMedia.id)))
        picture=Image.new('RGB',(200,200),'blue');b=io.BytesIO();picture.save(b,format='PNG')
        r=self.client.post('/api/media',headers=self.headers,files={'file':('photo.png',b.getvalue(),'image/png')})
        self.assertEqual(r.status_code,409,r.text)
        with SessionLocal() as db:self.assertEqual(db.scalar(select(func.count(CourseMedia.id))),before)

    def test_old_exam_keeps_its_photo_after_new_course_publication(self):
        photo=self.photo();course,body=self.course(photo['url']);cid=course['id']
        self.assertEqual(self.post(f'/api/courses/{cid}/publish',{'reviewed':True,'edit_version':course['edit_version']}).status_code,200)
        self.login('worker')
        with patch('baros.v2.learning.MIN_READ_SECONDS',0):self.assertEqual(self.post(f'/api/learning/{cid}/lessons/0',{'complete':True}).status_code,200)
        r=self.post(f'/api/learning/{cid}/exam',{});self.assertEqual(r.status_code,200,r.text)
        self.login('manager');body['lessons'][0]['body']='Чай заваривают при температуре 90 °C.';body['questions'][0]['prompt']='Какую температуру используют для чая?';body['edit_version']=course['edit_version']
        saved=self.client.put(f'/api/courses/{cid}',headers=self.headers,json=body);self.assertEqual(saved.status_code,200,saved.text)
        self.assertEqual(self.post(f'/api/courses/{cid}/publish',{'reviewed':True,'edit_version':saved.json()['edit_version']}).status_code,200)
        self.login('worker');self.assertEqual(self.client.get(photo['url']).status_code,200)
        self.login('peer');self.assertEqual(self.client.get(photo['url']).status_code,404,'Only the learner with the old immutable attempt can read its former photo')

    def test_conflicting_numeric_facts_do_not_create_a_guessed_key(self):
        sid=self.source('# Объёмы\nКарта А: 20 мл\nКарта А: 25 мл\nКарта Б: 30 мл\nКарта В: 40 мл\nКарта Г: 50 мл\nСверьте единицы измерения перед подачей.')
        r=self.post('/api/drafts/assemble',{'source_ids':[sid],'title':'Проверка противоречий'});self.assertEqual(r.status_code,200,r.text)
        data=self.client.get('/api/courses/'+str(r.json()['course_id'])).json()
        self.assertTrue(data['questions']);self.assertFalse(any('Карта А' in q['prompt'] for q in data['questions']))

    def test_legal_acknowledgement_keeps_exact_old_text_after_edit(self):
        old=self.client.get('/api/legal').json();r=self.post('/api/legal/acknowledgements',{'document':'privacy','version':old['version']});self.assertEqual(r.status_code,200)
        with SessionLocal() as db:db.add(Account(role='owner',login='archive.owner',name='Владелец',password_hash=hash_password('test-import-password')));db.commit()
        self.login('archive.owner');body={**old['operator'],'city':'Новый город для тестовой проверки'}
        self.assertEqual(self.client.put('/api/owner/legal',headers=self.headers,json=body).status_code,200)
        self.login('manager');restored=self.client.get('/api/legal/versions/'+old['version']);self.assertEqual(restored.status_code,200,restored.text);self.assertEqual(restored.json(),old)
        self.login('worker');self.assertEqual(self.client.get('/api/legal/versions/'+old['version']).status_code,404)

    def test_question_photo_has_readable_analytics_csv_without_private_paths(self):
        photo=self.photo();course,_=self.course(photo['url']);cid=course['id']
        self.assertEqual(self.post(f'/api/courses/{cid}/publish',{'reviewed':True,'edit_version':course['edit_version']}).status_code,200)
        self.login('worker')
        with patch('baros.v2.learning.MIN_READ_SECONDS',0):self.assertEqual(self.post(f'/api/learning/{cid}/lessons/0',{'complete':True}).status_code,200)
        exam=self.post(f'/api/learning/{cid}/exam',{}).json()
        self.assertEqual(self.post('/api/exams/'+exam['id']+'/finish',{'answers':{'0':0}}).status_code,200)
        self.login('manager');r=self.client.get('/api/reports/analytics/export?section=questions')
        self.assertEqual(r.status_code,200,r.text);self.assertNotIn('/api/media/',r.text);self.assertIn('[Фото:',r.text)

    def test_global_photo_is_previewable_in_own_draft_not_by_other_workers(self):
        with SessionLocal() as db:db.add(Account(role='owner',login='media.owner',name='Владелец',password_hash=hash_password('test-import-password')));db.commit()
        self.login('media.owner');pic=Image.new('RGB',(20,20),'white');b=io.BytesIO();pic.save(b,format='PNG')
        r=self.client.post('/api/media?global_asset=true',headers=self.headers,files={'file':('shared.png',b.getvalue(),'image/png')});self.assertEqual(r.status_code,200,r.text);url=r.json()['url']
        self.login('manager');self.assertEqual(self.client.get(url).status_code,404)
        course,_=self.course(url);self.assertEqual(self.client.get(url).status_code,200)
        self.login('worker');self.assertEqual(self.client.get(url).status_code,404)
        self.login('manager');self.assertEqual(self.post('/api/courses/'+str(course['id'])+'/publish',{'reviewed':True,'edit_version':course['edit_version']}).status_code,200)
        self.login('worker');self.assertEqual(self.client.get(url).status_code,200)
