"""Teaching checks and both provider contracts; HTTP responses are synthetic, not live models."""
import asyncio
import importlib
import json
import os
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault('DATABASE_URL','sqlite:///'+tempfile.mktemp(prefix='baros-methodology-',suffix='.db'))
os.environ['BAROS_WORKER']='0'
import httpx
from fastapi.testclient import TestClient
from sqlalchemy import select
from baros.db import Base,engine,SessionLocal
from baros.models import Organization,Course,Lesson,Question
from baros.security import hash_password
from baros.v2 import ai
from baros.v2.domain import dump,parse
from baros.v2.models import Account,VenueSettings,CourseProgram,Job,AIRequest
from baros.v2.methodology import validate_theory,quantities,review_material,reading_minutes

app=importlib.import_module('baros.v2.app').app
FACT1='Для лимонада используют сироп персика 20 мл.'
FACT2='После сиропа добавляют газированную воду 80 мл.'
SOURCE=FACT1+'\n'+FACT2
THEORY={'title':'Лимонад: состав и порядок','description':'Состав и последовательность по техкарте.',
        'lessons':[{'title':'Сироп','body':'## Результат урока\nВы сможете назвать сироп и его объём.\n## Основные факты\n'+FACT1+'\n## Коротко\nСироп персика — 20 мл.'},
                   {'title':'Вода и последовательность','body':'## Результат урока\nВы сможете назвать следующий компонент.\n## Основные факты\n'+FACT2+'\n## Коротко\nПосле сиропа — газированная вода, 80 мл.'}], 'limitations':[]}
QUESTIONS=[{'prompt':'Какой объём сиропа персика указан в технологической карте лимонада?',
            'choices':['20 мл','10 мл','30 мл','40 мл'],'correct_index':0,'type':'knowledge',
            'explanation':'В техкарте указан сироп персика 20 мл.','source_quote':FACT1,'lesson_index':0},
           {'prompt':'Какой компонент добавляют после сиропа согласно порядку приготовления?',
            'choices':['Газированная вода','Молоко','Чай','Кофе'],'correct_index':0,'type':'understanding',
            'explanation':'После сиропа в карте указана газированная вода 80 мл.','source_quote':FACT2,'lesson_index':1}]

class MethodologyTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine);self.client=TestClient(app);self.client.__enter__()
        with SessionLocal() as db:
            o=Organization(name='Изолированный аудит методиста');db.add(o);db.flush();self.oid=o.id
            db.add(VenueSettings(organization_id=o.id,join_code='METHODAUDIT'))
            a=Account(name='Управляющий теста',login='method.audit',password_hash=hash_password('local-test-password'),role='manager',organization_id=o.id)
            db.add(a);db.flush();self.aid=a.id;db.commit()

    def tearDown(self):self.client.__exit__(None,None,None)

    def make_job(self,name):
        with SessionLocal() as db:
            db.add(Job(id=name,organization_id=self.oid,account_id=self.aid,context=SOURCE,target=2,positions_json='["bartender"]',status='running',lease_token='audit-lease'));db.commit()

    def test_quantity_normalisation_and_reject_invented_theory(self):
        self.assertEqual(quantities('20.0 ml; 90 °С; 2 года'),quantities('20 мл; 90°C; 2 лет'))
        self.assertEqual(quantities('1. Цель урока\n2. Повторите'),set())
        self.assertEqual(len(validate_theory(THEORY,SOURCE)),2)
        wrong={**THEORY,'lessons':[{'title':'Опасная подмена','body':'По стандарту налейте сироп персика 999 мл.'}]}
        with self.assertRaisesRegex(ValueError,'величина'):validate_theory(wrong,SOURCE)
        wrong['lessons'][0]['body']='По стандарту нагрейте сироп до 20 °C.'
        with self.assertRaisesRegex(ValueError,'величина'):validate_theory(wrong,SOURCE)

    def test_structure_flags_are_not_a_quality_guarantee(self):
        report=review_material(THEORY['lessons'],QUESTIONS)
        self.assertTrue(report['requires_review']);self.assertEqual([x['questions'] for x in report['lessons']],[1,1])
        self.assertTrue(all(not x['remarks'] for x in report['lessons']))
        self.assertEqual(reading_minutes(' '.join(['текст']*181)),2)
        self.assertTrue(review_material([{'title':'Короткий материал','body':FACT1}],[])['lessons'][0]['remarks'])
        with self.assertRaisesRegex(ValueError,'повторил'):validate_theory({**THEORY,'lessons':[THEORY['lessons'][0]]*2},SOURCE)
        with self.assertRaisesRegex(ValueError,'список'):validate_theory({**THEORY,'limitations':'Ошибочный тип'},SOURCE)

    def test_wrong_numeric_correct_answer_is_rejected_but_distractors_allowed(self):
        good,rejected=ai.grounded_questions(QUESTIONS,SOURCE,[dict(x) for x in THEORY['lessons']],[])
        self.assertEqual(len(good),2);self.assertEqual(rejected,0)
        wrong={**QUESTIONS[0],'correct_index':1}
        good,rejected=ai.grounded_questions([wrong],SOURCE,[dict(x) for x in THEORY['lessons']],[])
        self.assertEqual(good,[]);self.assertEqual(rejected,1)

    def test_both_provider_authoring_paths_preserve_structure_and_evidence(self):
        for provider in ['qwen','yandex']:
            with self.subTest(provider=provider):
                self.make_job('method-'+provider);sent=[]
                env={'AI_PROVIDER':provider,'QWEN_ENABLED':'1','QWEN_API_KEY':'local-qwen-test-secret',
                     'QWEN_BASE_URL':'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
                     'YANDEX_ENABLED':'1','YANDEX_API_KEY':'local-yandex-test-secret','YANDEX_FOLDER_ID':'local-test-folder',
                     'AI_YANDEX_FALLBACK':'0','ALL_PROXY':'','HTTPS_PROXY':'','HTTP_PROXY':'','all_proxy':'','https_proxy':'','http_proxy':'','AI_JOB_BUDGET_USD':'100','AI_JOB_BUDGET_RUB':'10000',
                     'AI_DAILY_BUDGET_RUB':'10000','AI_MONTHLY_BUDGET_RUB':'10000','AI_VENUE_DAILY_BUDGET_RUB':'10000',
                     'AI_VENUE_MONTHLY_BUDGET_RUB':'10000'}
                async def respond(client,url,**kwargs):
                    sent.append((url,kwargs));prompt=kwargs['json']['messages'][-1]['content']
                    result=THEORY if prompt.startswith('Создай') else {'questions':QUESTIONS,'limitations':[]}
                    return httpx.Response(200,json={'choices':[{'finish_reason':'stop','message':{'content':dump(result)}}],
                                                   'usage':{'prompt_tokens':500,'completion_tokens':300}})
                with patch.dict(os.environ,env),patch.object(ai,'AI_PROVIDER',provider),patch.object(httpx.AsyncClient,'post',new=respond):
                    asyncio.run(ai.run_job('method-'+provider,'audit-lease'))
                with SessionLocal() as db: failure=db.get(Job,'method-'+provider).error
                self.assertEqual(len(sent),2,failure)
                payload=sent[0][1]['json'];self.assertEqual(payload['response_format'],{'type':'json_object'})
                self.assertIn('Результат урока',payload['messages'][0]['content']);self.assertIn('От 1 до 12',payload['messages'][1]['content'])
                if provider=='qwen':self.assertEqual(payload['model'],'qwen3.5-plus');self.assertFalse(payload['enable_thinking'])
                else:
                    self.assertEqual(payload['model'],'gpt://local-test-folder/qwen3.6-35b-a3b')
                    self.assertNotIn('enable_thinking',payload);self.assertEqual(sent[0][1]['headers']['OpenAI-Project'],'local-test-folder')
                with SessionLocal() as db:
                    job=db.get(Job,'method-'+provider);self.assertEqual(job.status,'succeeded');course=db.get(Course,job.course_id);self.assertFalse(course.published)
                    lessons=db.scalars(select(Lesson).where(Lesson.course_id==course.id).order_by(Lesson.sort_order)).all()
                    self.assertEqual([l.title for l in lessons],['Сироп','Вода и последовательность'])
                    qs=db.scalars(select(Question).where(Question.course_id==course.id)).all();self.assertEqual(len(qs),2)
                    self.assertTrue(all('Источник:' in q.explanation for q in qs))
                    report=parse(db.get(CourseProgram,course.id).payload)['review'];self.assertEqual(len(report['lessons']),2)
                    usage=db.scalars(select(AIRequest).where(AIRequest.job_id==job.id)).all();self.assertEqual(len(usage),2)
                    self.assertTrue(all(r.provider==provider and r.status=='recorded' for r in usage))

    def test_invalid_theory_never_becomes_a_course(self):
        self.make_job('bad-theory')
        async def bad(*args,**kwargs):return {**THEORY,'lessons':[{'title':'Ошибка','body':'Сироп персика нужно налить в объёме 999 мл.'}]}
        with patch.object(ai,'call_model',new=bad):asyncio.run(ai.run_job('bad-theory','audit-lease'))
        with SessionLocal() as db:
            job=db.get(Job,'bad-theory');self.assertEqual(job.status,'failed');self.assertIsNone(job.course_id);self.assertIn('величина',job.error)

if __name__=='__main__':unittest.main()
