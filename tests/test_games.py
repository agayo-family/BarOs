import importlib
import os
import tempfile
import unittest
from datetime import timedelta
from fastapi.testclient import TestClient
from sqlalchemy import select, func

os.environ.setdefault('DATABASE_URL','sqlite:///'+tempfile.mktemp(prefix='baros-games-',suffix='.db'))
os.environ['BAROS_WORKER']='0'
from baros.db import Base, engine, SessionLocal
from baros.models import Organization, Course, Question, Lesson
from baros.security import hash_password
from baros.v2.models import Account, VenueSettings, CourseSettings, CourseRevision, GameProgress, GameRun, GameTurn, Exam, LessonRead
from baros.v2.domain import dump, parse, now
from baros.v2.games import cleanup_games

app=importlib.import_module('baros.v2.app').app


def questions():
    answers=['90 °C','Высокий стакан со льдом','Уточнить состав у кухни','Предложить напиток по вкусу гостя','Сироп и вода и лёд','Чистые приборы']
    types=['knowledge','knowledge','scenario','sales','understanding','understanding']
    return [{'prompt':f'Вопрос {i}: какое действие или правило верно по материалу?',
             'choices':[answer,'Другой вариант','Неверный вариант','Ещё один вариант'],'correct_index':0,
             'explanation':f'Стандарт заведения: {answer}.','type':types[i]} for i,answer in enumerate(answers)]


class GameTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine);self.client=TestClient(app);self.client.__enter__()
        with SessionLocal() as db:
            org=Organization(name='Game venue');foreign=Organization(name='Foreign');db.add_all([org,foreign]);db.flush()
            self.oid,self.foreign=org.id,foreign.id
            db.add_all([VenueSettings(organization_id=org.id,join_code='GAMECODE1'),VenueSettings(organization_id=foreign.id,join_code='GAMECODE2')])
            self.accounts={}
            for login,role,oid in [('worker','employee',org.id),('peer','employee',org.id),('foreign','employee',foreign.id),('manager','manager',org.id),('owner','owner',None)]:
                a=Account(name=login,login=login,role=role,organization_id=oid,password_hash=hash_password('game-test-password'),positions_json='["bartender"]')
                db.add(a);db.flush();self.accounts[login]=a.id
            c=Course(organization_id=org.id,title='Unpublished draft changes',published=True)
            foreign_course=Course(organization_id=foreign.id,title='Foreign',published=True)
            draft=Course(organization_id=org.id,title='Draft only',published=False)
            db.add_all([c,foreign_course,draft]);db.flush();self.cid,self.fcid,self.draft=c.id,foreign_course.id,draft.id
            self.data={'title':'Published game topic','description':'Practice topic','positions':['bartender'],
                 'lessons':[{'title':'Theory','body':'Стандарт: чай 90 °C. Высокий стакан со льдом. Уточнить состав у кухни.'}],
                 'questions':questions(),'passing_score':80,'required':True,'quiz_size':3,'time_limit_minutes':10,
                 'max_attempts':0,'deadline_days':7,'due_at':None,'is_intro':False}
            rev=CourseRevision(course_id=c.id,version=1,payload=dump(self.data));db.add(rev)
            db.add(CourseSettings(course_id=c.id,version=1));db.add(CourseSettings(course_id=draft.id))
            db.add(Question(course_id=c.id,prompt='Private unpublished prompt',choices_json='["Secret draft","a","b","c"]',correct_index=0))
            db.add(Question(course_id=draft.id,prompt='Draft prompt',choices_json='["Preview only","a","b","c"]',correct_index=0))
            db.add(Lesson(course_id=draft.id,title='Draft theory',body='Draft theory only.'))
            db.commit();self.rev=rev.id
        self.login('worker')

    def tearDown(self):self.client.__exit__(None,None,None)
    def login(self,who):
        r=self.client.post('/api/auth/login',json={'login':who,'password':'game-test-password'});self.assertEqual(r.status_code,200)
        self.headers={'x-csrf-token':self.client.get('/api/me').json()['csrf']}
        if who=='owner':self.headers['x-organization-id']=str(self.oid)
    def start(self,mode='truth',size=5,scope='all',cid=None):
        r=self.client.post(f'/api/games/{cid or self.cid}/start',json={'mode':mode,'size':size,'scope':scope},headers=self.headers)
        self.assertEqual(r.status_code,200,r.text);return r.json()
    def turn(self,run,q=None,**kw):
        q=q or run['questions'][0]
        body={'event_id':f'event_{now().timestamp()}'.replace('.','_'),'question_id':q['id'],**kw}
        return self.client.post('/api/games/runs/'+run['id']+'/answer',json=body,headers=self.headers)

    def test_catalog_published_material_roles_and_mode_availability(self):
        catalog=self.client.get('/api/games').json();self.assertEqual(len(catalog['courses']),1)
        self.assertEqual(catalog['courses'][0]['title'],'Published game topic')
        board=self.client.get('/api/games/'+str(self.cid)).json();self.assertEqual(len(board['modes']),6)
        self.assertTrue(all(m['available'] for m in board['modes']))
        run=self.start('mix',6);self.assertNotIn('Secret draft',dump(run));self.assertNotIn('Private unpublished',dump(run))
        self.assertEqual(run['revision_id'],self.rev)
        resume=self.client.get('/api/games/runs/'+run['id']).json();self.assertEqual(resume['lessons'],self.data['lessons'])
        self.assertNotIn('lessons',run)

    def test_all_grading_modes_and_self_assessment(self):
        for mode in ['truth','words','scenario','recall','pairs','mix']:
            run=self.start(mode,6)
            for q in run['questions']:
                if q['variant']=='truth':values={'value':q['claim_true']}
                elif q['variant']=='words':values={'value':list(range(len(q['tokens'])))}
                elif q['variant']=='scenario':values={'value':q['correct_index']}
                elif q['variant']=='pairs':values={'value':q['id']}
                else:values={'rating':'remembered'}
                r=self.turn(run,q,**values);self.assertEqual(r.status_code,200,r.text);self.assertTrue(r.json()['correct'])
                self.assertEqual(r.json()['answer'],q['answer'])
            done=self.client.get('/api/games/runs/'+run['id']).json();self.assertTrue(done['finished'])
            if mode=='recall':self.assertEqual(done['summary']['objective'],0);self.assertEqual(done['summary']['self_assessed'],6)
        with SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(Exam.id))),0)
            self.assertEqual(db.scalar(select(func.count(LessonRead.id))),0)

    def test_duplicate_event_id_and_corrections_do_not_inflate_progress(self):
        run=self.start('truth',1);q=run['questions'][0]
        r=self.turn(run,q,event_id='repeatable_event',value=not q['claim_true']);self.assertFalse(r.json()['correct'])
        replay=self.turn(run,q,event_id='repeatable_event',value=not q['claim_true']);self.assertEqual(replay.status_code,200)
        self.assertEqual(self.turn(run,q,event_id='repeatable_event',value=q['claim_true']).status_code,409)
        corrected=self.turn(run,q,value=q['claim_true']);self.assertTrue(corrected.json()['correct']);self.assertFalse(corrected.json()['first'])
        self.assertEqual(corrected.json()['run']['summary']['first_correct'],0)
        with SessionLocal() as db:
            p=db.scalar(select(GameProgress));self.assertEqual(p.practiced,1);self.assertEqual(p.mistakes,1);self.assertEqual(p.streak,0)
            self.assertEqual(db.scalar(select(func.count(GameTurn.id))),2)
            self.assertNotIn('run',parse(db.scalar(select(GameTurn)).result))

    def test_adaptive_coverage_review_and_persisted_resume(self):
        first=self.start('truth',3);seen=set()
        for q in first['questions']:seen.add(q['id']);self.turn(first,q,value=q['claim_true'])
        second=self.start('truth',3);self.assertFalse(seen & {q['id'] for q in second['questions']})
        q=second['questions'][0];self.turn(second,q,value=not q['claim_true'])
        review=self.start('mix',3,'review');self.assertEqual([x['id'] for x in review['questions']],[q['id']])
        board=self.client.get('/api/games/'+str(self.cid)).json();self.assertEqual(board['progress']['practiced'],4)
        self.assertEqual(board['progress']['review'],1);self.assertTrue(board['active_run'])
        self.login('peer');self.assertEqual(self.client.get('/api/games/'+str(self.cid)).json()['progress']['practiced'],0)
        self.login('worker');self.assertEqual(self.client.get('/api/games/runs/'+second['id']).status_code,200)

    def test_pair_wrong_then_correct_remains_resumable_and_ambiguous_answers_removed(self):
        run=self.start('pairs',2);q0,q1=run['questions']
        self.turn(run,q0,value=q1['id']);self.turn(run,q1,value=q0['id'])
        self.assertFalse(self.client.get('/api/games/runs/'+run['id']).json()['finished'])
        self.assertEqual(self.client.get('/api/games/'+str(self.cid)).json()['active_run'],run['id'])
        self.turn(run,q0,value=q0['id']);self.turn(run,q1,value=q1['id'])
        self.assertTrue(self.client.get('/api/games/runs/'+run['id']).json()['finished'])
        with SessionLocal() as db:
            p={**self.data,'questions':[self.data['questions'][0],self.data['questions'][0]]};db.get(CourseRevision,self.rev).payload=dump(p);db.commit()
        board=self.client.get('/api/games/'+str(self.cid)).json();pairs=next(m for m in board['modes'] if m['id']=='pairs')
        self.assertFalse(pairs['available'])
        response=self.client.post(f'/api/games/{self.cid}/start',json={'mode':'pairs'},headers=self.headers)
        self.assertEqual(response.status_code,409)

    def test_repeated_words_accept_equal_text_when_identical_tokens_swapped(self):
        run=self.start('words',20);q=next(q for q in run['questions'] if q['answer']=='Сироп и вода и лёд')
        r=self.turn(run,q,value=[0,3,2,1,4]);self.assertEqual(r.status_code,200);self.assertTrue(r.json()['correct'])
        self.assertEqual(self.turn(run,q,value=[0,1,2,3,3]).status_code,400)

    def test_access_tenant_positions_archiving_subscription_and_expiry(self):
        run=self.start();self.login('peer');self.assertEqual(self.client.get('/api/games/runs/'+run['id']).status_code,404)
        self.login('worker');self.assertEqual(self.client.get('/api/games/'+str(self.fcid)).status_code,404)
        self.assertEqual(self.client.get('/api/games/'+str(self.draft)).status_code,404)
        self.assertEqual(self.client.get('/api/games',headers={'x-organization-id':str(self.foreign)}).status_code,403)
        with SessionLocal() as db:db.get(Account,self.accounts['worker']).positions_json='["waiter"]';db.commit()
        self.assertEqual(self.client.get('/api/games/'+str(self.cid)).status_code,403)
        self.assertEqual(self.client.get('/api/games/runs/'+run['id']).status_code,403)
        with SessionLocal() as db:db.get(Account,self.accounts['worker']).positions_json='["bartender"]';db.get(CourseSettings,self.cid).archived=True;db.commit()
        self.assertEqual(self.client.get('/api/games/runs/'+run['id']).status_code,403)
        with SessionLocal() as db:db.get(CourseSettings,self.cid).archived=False;db.get(VenueSettings,self.oid).subscription_status='past_due';db.commit()
        self.assertEqual(self.client.get('/api/games').status_code,402)
        with SessionLocal() as db:db.get(VenueSettings,self.oid).subscription_status='trial';db.get(GameRun,run['id']).expires_at=now()-timedelta(seconds=1);db.commit()
        self.assertEqual(self.client.get('/api/games/runs/'+run['id']).status_code,410)

    def test_manager_and_owner_preview_do_not_change_employee_progress(self):
        self.login('manager');published=self.start('recall',1);draft=self.start('recall',1,cid=self.draft)
        self.assertTrue(published['preview']);self.assertTrue(draft['preview'])
        self.assertEqual(published['title'],'Published game topic')
        self.turn(published,rating='remembered');self.turn(draft,rating='remembered')
        with SessionLocal() as db:self.assertEqual(db.scalar(select(func.count(GameProgress.id))),0)
        self.login('owner');self.assertEqual(len(self.client.get('/api/games',headers=self.headers).json()['courses']),2)
        self.assertEqual(self.client.get('/api/games/runs/'+published['id'],headers=self.headers).status_code,404)
        self.headers['x-organization-id']=str(self.foreign);self.assertEqual(self.client.get('/api/games/'+str(self.cid),headers=self.headers).status_code,404)

    def test_immutable_publication_during_game_and_changed_draft_preview(self):
        run=self.start('truth',1)
        with SessionLocal() as db:
            s=db.get(CourseSettings,self.cid);s.version=2
            db.add(CourseRevision(course_id=self.cid,version=2,payload=dump({**self.data,'title':'New topic','lessons':[{'title':'New','body':'New theory.'}]})));db.commit()
        self.assertEqual(self.client.get('/api/games/runs/'+run['id']).json()['lessons'],self.data['lessons'])
        self.turn(run,value=run['questions'][0]['claim_true'])
        self.assertEqual(self.client.get('/api/games/'+str(self.cid)).json()['progress']['practiced'],0)
        with SessionLocal() as db:
            db.get(CourseSettings,self.cid).version=3
            db.add(CourseRevision(course_id=self.cid,version=3,payload=dump({**self.data,'positions':['waiter']})));db.commit()
        self.assertEqual(self.client.get('/api/games/runs/'+run['id']).status_code,403)
        self.login('manager');draft=self.start('recall',1,cid=self.draft)
        with SessionLocal() as db:db.get(CourseSettings,self.draft).edit_version+=1;db.commit()
        self.assertEqual(self.client.get('/api/games/runs/'+draft['id']).status_code,409)

    def test_hints_and_self_assessment_not_reported_as_objective_confidence(self):
        run=self.start('truth',1);self.turn(run,value=run['questions'][0]['claim_true'],hinted=True)
        with SessionLocal() as db:p=db.scalar(select(GameProgress));self.assertEqual(p.streak,0);self.assertEqual(p.correct,0)
        recall=self.start('recall',1);self.turn(recall,rating='remembered')
        self.assertEqual(self.client.get('/api/games/'+str(self.cid)).json()['progress']['confident'],0)

    def test_input_csrf_and_cleanup_preserves_progress_and_existing_learning(self):
        self.assertEqual(self.client.post(f'/api/games/{self.cid}/start',json={'mode':'truth'}).status_code,403)
        self.assertEqual(self.client.post(f'/api/games/{self.cid}/start',json={'mode':'made-up'},headers=self.headers).status_code,422)
        run=self.start('truth',1);q=run['questions'][0]
        self.assertEqual(self.turn(run,{'id':999},value=True).status_code,404)
        self.assertEqual(self.turn(run,q,value='true').status_code,422)
        self.turn(run,q,value=q['claim_true'])
        with SessionLocal() as db:
            db.get(GameRun,run['id']).expires_at=now()-timedelta(seconds=1);db.commit();cleanup_games(db);db.commit()
            self.assertEqual(db.scalar(select(func.count(GameRun.id))),0)
            self.assertEqual(db.scalar(select(func.count(GameTurn.id))),0)
            self.assertEqual(db.scalar(select(func.count(GameProgress.id))),1)
            self.assertIsNotNone(db.get(Course,self.cid));self.assertIsNotNone(db.get(Account,self.accounts['worker']))


if __name__=='__main__':unittest.main()
