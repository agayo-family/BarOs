import os
import secrets
from datetime import timedelta
from fastapi import APIRouter, Depends, Request
from sqlalchemy import select, update, func
from ..db import get_db
from ..models import Course
from .models import Account, CourseRevision, Enrollment, LessonRead, Exam
from .domain import *
from .auth import actor, tenant
from .schemas import ReadIn, AnswerIn
from .growth import reward

router=APIRouter()
MIN_READ_SECONDS=int(os.getenv('MIN_LESSON_SECONDS','10'))


def learner(request,db,a):
    require(a.role=='employee','Откройте кабинет сотрудника',403)
    return tenant(request,db,a,learning=True)


def learning_course(request,db,a,cid):
    oid=learner(request,db,a)
    c=db.get(Course,cid);require(c and c.organization_id==oid and c.published,'Курс недоступен',404)
    s=course_settings(db,c);require(not s.archived,'Курс архивирован',404)
    rev=revision(db,c);require(rev,'Опубликованная версия не найдена',404)
    data=parse(rev.payload);require(applies(a,data),'Курс не назначен вашим должностям',403)
    enrollment=enroll(db,a,rev)
    return c,s,rev,data,enrollment


@router.get('/api/learning')
def learning(request:Request,a=Depends(actor),db=Depends(get_db)):
    # Profile statistics remain readable after subscription expiry.
    require(a.role=='employee','Откройте кабинет сотрудника',403)
    tenant(request,db,a,learning=False)
    ensure_enrollments(db,a);result=learner_stats(db,a);db.commit();return result


@router.get('/api/learning/history')
def history(request:Request,a=Depends(actor),db=Depends(get_db)):
    require(a.role=='employee','Откройте кабинет сотрудника',403)
    tenant(request,db,a)
    from .app import history_data
    return history_data(db,a)


@router.get('/api/learning/{cid}')
def lesson_list(cid:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    c,s,rev,data,e=learning_course(request,db,a,cid)
    reads={r.lesson_index:r for r in db.scalars(select(LessonRead).where(LessonRead.account_id==a.id,LessonRead.revision_id==rev.id)).all()}
    exams=exams_for(db,a,rev.id)
    db.commit()
    return {'id':cid,'revision_id':rev.id,'version':rev.version,'title':data['title'],'description':data['description'],
            'program':data.get('program'),
            'lessons':[{**l,'index':i,'completed':bool(reads.get(i) and reads[i].completed_at),'seconds':reads[i].seconds if i in reads else 0} for i,l in enumerate(data['lessons'])],
            'quiz_size':data['quiz_size'],'bank_size':len(data['questions']),'passing_score':data['passing_score'],
            'time_limit_minutes':data['time_limit_minutes'],'max_attempts':data['max_attempts'],'attempt_count':len(exams),
            'due_at':iso(e.due_at),'min_read_seconds':MIN_READ_SECONDS,'exam_id':next((x.id for x in exams if not x.finished_at),None)}


@router.post('/api/learning/{cid}/lessons/{index}')
def read_lesson(cid:int,index:int,data:ReadIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    c,s,rev,p,e=learning_course(request,db,a,cid)
    require(0<=index<len(p['lessons']),'Урок не найден',404)
    # Serialize double taps from multiple tabs for the same learner.
    db.execute(select(Account).where(Account.id==a.id).with_for_update()).first()
    r=db.scalar(select(LessonRead).where(LessonRead.account_id==a.id,LessonRead.revision_id==rev.id,LessonRead.lesson_index==index))
    if not r:
        r=LessonRead(account_id=a.id,revision_id=rev.id,lesson_index=index,last_ping=now(),seconds=0)
        db.add(r);db.flush()
    else:
        gap=max(0,(now()-r.last_ping).total_seconds())
        # A heartbeat after closing a tab must not credit a full day of learning.
        if gap<=45:r.seconds+=int(gap)
        r.last_ping=now()
    award=None
    if data.complete:
        require(r.seconds>=MIN_READ_SECONDS,f'Изучите урок перед подтверждением (не менее {MIN_READ_SECONDS} секунд).')
        r.completed_at=r.completed_at or now()
        award=reward(db,a,f'theory:{rev.id}:{index}','theory',20,10,theory=1)
    db.commit();return {'seconds':r.seconds,'completed':bool(r.completed_at),'reward':award}


@router.get('/api/learning/{cid}/cards')
def practice_cards(cid:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    # Practice uses the same immutable, role-assigned publication as theory.
    # It never opens an exam or credits a test attempt or a completed lesson.
    c,s,rev,data,e=learning_course(request,db,a,cid)
    cards=[{'id':i,'question':q['prompt'],'answer':q['choices'][q['correct_index']],
            'explanation':q.get('explanation','')} for i,q in enumerate(data['questions'])]
    db.commit()
    return {'id':cid,'revision_id':rev.id,'version':rev.version,'title':data['title'],'cards':cards}


def visible_exam(exam,data):
    q=parse(exam.questions_json,[])
    return {'id':exam.id,'title':data['title'],'started_at':iso(exam.started_at),'expires_at':iso(exam.expires_at),
            'server_time':iso(now()),'questions':[{'id':i,'prompt':x['prompt'],'choices':x['choices'],'type':x['type']} for i,x in enumerate(q)],
            'answers':parse(exam.answers_json),'finished':bool(exam.finished_at),'result':parse(exam.result_json) if exam.finished_at else None}


@router.post('/api/learning/{cid}/exam')
def start_exam(cid:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    db.execute(select(Account).where(Account.id==a.id).with_for_update()).first()
    c,s,rev,data,e=learning_course(request,db,a,cid)
    for exam in exams_for(db,a,rev.id):
        if not exam.finished_at:
            if exam.expires_at<=now():finish(db,exam,data)
            else:return visible_exam(exam,data)
    required=set(range(len(data['lessons'])))
    done={r.lesson_index for r in db.scalars(select(LessonRead).where(LessonRead.account_id==a.id,LessonRead.revision_id==rev.id,LessonRead.completed_at.is_not(None))).all()}
    require(required<=done,'Сначала изучите и отметьте все теоретические уроки',409)
    attempts=exams_for(db,a,rev.id)
    require(not data['max_attempts'] or len(attempts)<data['max_attempts'],'Лимит попыток исчерпан. Обратитесь к управляющему.',409)
    pool=data['questions'];n=data['quiz_size']
    require(len(pool)>=n and n>0,'Недостаточно вопросов в опубликованной версии',409)
    rng=secrets.SystemRandom()
    selected=[];remaining=list(enumerate(pool));rng.shuffle(remaining)
    # Proportional stratification supports every manager-selected exam length.
    for qt,ratio in [('knowledge',.4),('understanding',.27),('sales',.2),('scenario',.13)]:
        chosen=[x for x in remaining if x[1]['type']==qt][:int(n*ratio)]
        selected+=chosen;used={i for i,_ in chosen};remaining=[x for x in remaining if x[0] not in used]
    selected+=remaining[:n-len(selected)];rng.shuffle(selected)
    questions=[]
    for original,q in selected:
        indices=list(range(4));rng.shuffle(indices)
        questions.append({**q,'original':original,'choices':[q['choices'][i] for i in indices],'correct_index':indices.index(q['correct_index'])})
    exam=Exam(id=secrets.token_urlsafe(28),account_id=a.id,revision_id=rev.id,questions_json=dump(questions),
              answers_json='{}',started_at=now(),expires_at=now()+timedelta(minutes=data['time_limit_minutes']))
    db.add(exam);db.commit();return visible_exam(exam,data)


def exam_access(request,db,a,eid):
    learner(request,db,a)
    exam=db.scalar(select(Exam).where(Exam.id==eid).with_for_update())
    require(exam and exam.account_id==a.id,'Попытка не найдена',404)
    rev=db.get(CourseRevision,exam.revision_id);c=db.get(Course,rev.course_id)
    require(c and c.organization_id==a.organization_id and c.published and not course_settings(db,c).archived,'Курс недоступен',403)
    data=parse(rev.payload)
    require(applies(a,data),'Курс больше не назначен вашим должностям',403)
    # An already-started exam uses its immutable revision even if a manager publishes another.
    return exam,data


def validate_answers(exam,data):
    questions=parse(exam.questions_json,[])
    for key,value in data.answers.items():
        require(key.isdigit() and str(int(key))==key and 0<=int(key)<len(questions),'Неизвестный вопрос')
        require(type(value) is int and 0<=value<4,'Некорректный ответ')


def finish(db,exam,data):
    if exam.finished_at:return parse(exam.result_json)
    questions=parse(exam.questions_json,[]);answers=parse(exam.answers_json)
    review=[];correct=0
    for i,q in enumerate(questions):
        answer=answers.get(str(i));ok=answer==q['correct_index'];correct+=int(ok)
        review.append({'prompt':q['prompt'],'choices':q['choices'],'selected':answer,'correct_index':q['correct_index'],
                       'correct':ok,'explanation':q['explanation'],'type':q['type']})
    score=round(100*correct/max(1,len(questions)),1)
    ended=min(now(),exam.expires_at)
    result={'score':score,'passed':score>=data['passing_score'],'correct':correct,'total':len(questions),
            'exam_id':exam.id,'course_id':db.get(CourseRevision,exam.revision_id).course_id,
            'duration_seconds':max(0,int((ended-exam.started_at).total_seconds())), 'review':review,'expired':now()>=exam.expires_at}
    exam.finished_at=ended
    account=db.get(Account,exam.account_id)
    if len(answers)>=max(1,len(questions)//2):
        attempt_no=db.scalar(select(func.count(Exam.id)).where(Exam.account_id==account.id,Exam.finished_at>=now().replace(hour=0,minute=0,second=0,microsecond=0))) or 0
        if attempt_no<3: result['reward']=reward(db,account,'exam:'+exam.id,'exam',30 if result['passed'] else 8,15 if result['passed'] else 4,exam_attempts=1)
        if result['passed']:
            perfect=score==100 and len(questions)>=10
            bonus=reward(db,account,f'passed:{exam.revision_id}','exam_pass',50,25,exam_passed=1)
            if perfect:reward(db,account,f'perfect:{exam.revision_id}','achievement',0,0,perfect=1)
            if perfect and 2<=result['duration_seconds']/len(questions)<=8:reward(db,account,f'swift:{exam.revision_id}','achievement',0,0,swift=1)
            result['pass_reward']=bonus
    exam.result_json=dump(result);db.flush()
    return result


@router.get('/api/exams/{eid}')
def get_exam(eid:str,request:Request,a=Depends(actor),db=Depends(get_db)):
    exam,data=exam_access(request,db,a,eid)
    if not exam.finished_at and exam.expires_at<=now():finish(db,exam,data);db.commit()
    return visible_exam(exam,data)


@router.put('/api/exams/{eid}')
def save_answers(eid:str,data:AnswerIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    exam,p=exam_access(request,db,a,eid)
    if exam.finished_at:return {'finished':True,'result':parse(exam.result_json)}
    if exam.expires_at<=now():result=finish(db,exam,p);db.commit();return {'finished':True,'result':result}
    validate_answers(exam,data)
    answers=parse(exam.answers_json);answers.update(data.answers);exam.answers_json=dump(answers);db.commit()
    return {'ok':True,'saved':len(answers)}


@router.post('/api/exams/{eid}/finish')
def submit(eid:str,data:AnswerIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    exam,p=exam_access(request,db,a,eid)
    if exam.finished_at:return parse(exam.result_json)
    if now()<exam.expires_at:
        validate_answers(exam,data);answers=parse(exam.answers_json);answers.update(data.answers);exam.answers_json=dump(answers)
    result=finish(db,exam,p);log(db,a,a.organization_id,'Завершён тест',exam_id=eid,score=result['score']);db.commit();return result


@router.post('/api/learning/{cid}/cards/{index}/practice')
def credit_card(cid:int,index:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    c,s,rev,p,e=learning_course(request,db,a,cid)
    require(0<=index<len(p['questions']),'Карточка не найдена',404)
    from .auth import rate
    rate(db,'card-practice:'+str(a.id),1200,3600)
    result=reward(db,a,f'card:{rev.id}:{index}:{now().date().isoformat()}','cards',2,1,cards=1)
    db.commit();return {'reward':result}
