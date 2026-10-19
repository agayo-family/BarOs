"""Portable packages, preview-before-import and isolated written assessments."""
import hashlib
import json
import math
import secrets
from datetime import timedelta
from decimal import Decimal
from typing import Literal
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from ..db import get_db
from ..models import Course
from .models import Account, ImportedAssessment, PackageReceipt, WrittenAttempt, Exam, Notice
from .auth import actor, manager, tenant
from .domain import POSITIONS, applies, course_settings, dump, iso, log, now, parse, require
from .schemas import CourseIn

router=APIRouter()

class Strict(BaseModel):
    model_config=ConfigDict(extra='forbid',str_strip_whitespace=True,allow_inf_nan=False)

class Criterion(Strict):
    id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,50}$')
    label: str = Field(min_length=1,max_length=300)
    points: float = Field(gt=0,le=100)
    guidance: str = Field(default='',max_length=8000)

class Section(Strict):
    id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,50}$')
    title: str = Field(min_length=2,max_length=200)
    instructions: str = Field(default='',max_length=30000)

class ScoreCap(Strict):
    points: float = Field(ge=0,le=100)
    guidance: str = Field(min_length=5,max_length=4000)

class Task(Strict):
    id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,50}$')
    section_id: str
    kind: Literal['single_choice','written']
    prompt: str = Field(min_length=5,max_length=20000)
    points: float = Field(gt=0,le=100)
    choices: list[str] = Field(default_factory=list,max_length=8)
    correct_index: StrictInt | None = None
    explanation: str = Field(default='',max_length=10000)
    rubric: list[Criterion] = Field(default_factory=list,max_length=20)
    score_cap: ScoreCap | None = None
    max_length: int = Field(default=12000,ge=100,le=30000)
    @model_validator(mode='after')
    def check(self):
        if self.kind=='single_choice':
            if not 2<=len(self.choices)<=8 or any(not x.strip() or len(x)>1500 for x in self.choices) or len({x.casefold().strip() for x in self.choices})!=len(self.choices):raise ValueError('Нужны различные непустые варианты ответа')
            if self.correct_index is None or not 0<=self.correct_index<len(self.choices) or self.rubric:raise ValueError('Проверьте правильный ответ')
        elif self.choices or self.correct_index is not None or not self.rubric or len({x.id for x in self.rubric})!=len(self.rubric):
            raise ValueError('Для письменного задания нужна рубрика с уникальными критериями')
        if self.score_cap and (self.kind!='written' or self.score_cap.points>=self.points):raise ValueError('Ограничение балла должно быть ниже максимума письменного задания')
        return self

class AssessmentIn(Strict):
    title: str = Field(min_length=2,max_length=200)
    description: str = Field(default='',max_length=3000)
    instructions: str = Field(default='',max_length=30000)
    positions: list[str] = Field(default=['all'],min_length=1,max_length=8)
    sections: list[Section] = Field(min_length=1,max_length=30)
    tasks: list[Task] = Field(min_length=1,max_length=1000)
    time_limit_minutes: int = Field(default=180,ge=1,le=720)
    max_attempts: int = Field(default=1,ge=1,le=20)
    passing_score: float | None = Field(default=None,ge=0,le=100)
    sequential_sections: bool = True
    @model_validator(mode='after')
    def check(self):
        ids={s.id for s in self.sections}
        if len(ids)!=len(self.sections) or len({t.id for t in self.tasks})!=len(self.tasks):raise ValueError('Идентификаторы должны быть уникальными')
        if any(t.section_id not in ids for t in self.tasks) or any(not any(t.section_id==s.id for t in self.tasks) for s in self.sections):raise ValueError('Каждый раздел должен содержать задания')
        if any(p not in {'all',*POSITIONS} for p in self.positions):raise ValueError('Неизвестная должность')
        return self

class PackageIn(Strict):
    format: Literal['baros-package']
    version: Literal[1]
    kind: Literal['course','assessment']
    course: CourseIn | None = None
    assessment: AssessmentIn | None = None
    @model_validator(mode='after')
    def check(self):
        if (self.kind=='course') != bool(self.course) or (self.kind=='assessment') != bool(self.assessment):raise ValueError('Укажите ровно один тип материала')
        if self.course:
            if not self.course.lessons or not self.course.questions:raise ValueError('Для полного обучения нужны теория и вопросы')
            if self.course.quiz_size>len(self.course.questions):raise ValueError('Размер теста больше банка вопросов')
            if any(p not in {'all',*POSITIONS} for p in self.course.positions):raise ValueError('Неизвестная должность')
        return self

class ImportIn(Strict):
    package: PackageIn

class AnswersIn(Strict):
    version: int = Field(ge=1)
    answers: dict[str, StrictInt | StrictStr]

class ReviewIn(Strict):
    version: int = Field(ge=1)
    grades: dict[str,dict[str,float]]
    feedback: dict[str,str] = Field(default_factory=dict)
    applied_caps: dict[str,StrictBool] = Field(default_factory=dict)

class ConfirmIn(Strict):
    reviewed: bool

class VersionIn(Strict):
    version: int = Field(ge=1)


def fingerprint(p):
    raw=json.dumps(p.model_dump(mode='json'),ensure_ascii=False,sort_keys=True,separators=(',',':'))
    require(len(raw.encode())<=2*1024*1024,'Пакет превышает 2 МБ',413)
    return hashlib.sha256(raw.encode()).hexdigest()

def import_info(r,duplicate=False):
    return {'id':r.course_id or r.assessment_id,'kind':'course' if r.course_id else 'assessment','duplicate':duplicate,
            'url':'/app/courses/'+str(r.course_id) if r.course_id else '/app/assessments/'+str(r.assessment_id)}

@router.post('/api/packages/preview')
def preview(data:ImportIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'courses_manage',True);p=data.package;fp=fingerprint(p)
    old=db.scalar(select(PackageReceipt).where(PackageReceipt.organization_id==oid,PackageReceipt.fingerprint==fp))
    content=p.course or p.assessment
    return {'title':content.title,'kind':p.kind,'positions':content.positions,'duplicate':import_info(old,True) if old else None,
            'lessons':len(p.course.lessons) if p.course else 0,'questions':len(p.course.questions) if p.course else len(p.assessment.tasks),
            'written':sum(t.kind=='written' for t in p.assessment.tasks) if p.assessment else 0,
            'notice':'Полный курс: теория, тест, карточки и игры из банка вопросов.' if p.course else 'Только тест. Письменные ответы проверяет управляющий по рубрикам. Уроки, карточки и игры не создаются.'}

@router.post('/api/packages/import')
def import_package(data:ImportIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'courses_manage',True);p=data.package;fp=fingerprint(p)
    old=db.scalar(select(PackageReceipt).where(PackageReceipt.organization_id==oid,PackageReceipt.fingerprint==fp))
    if old:return import_info(old,True)
    receipt=PackageReceipt(organization_id=oid,fingerprint=fp)
    if p.course:
        from .content import save_course
        c=Course(organization_id=oid,title=p.course.title,published=False);db.add(c);db.flush();save_course(db,c,p.course);receipt.course_id=c.id
    else:
        test=ImportedAssessment(organization_id=oid,title=p.assessment.title,payload=dump(p.assessment.model_dump(mode='json')));db.add(test);db.flush();receipt.assessment_id=test.id
    db.add(receipt);log(db,a,oid,'Импортирован учебный пакет',kind=p.kind,title=(p.course or p.assessment).title)
    try:db.commit()
    except IntegrityError:
        db.rollback();old=db.scalar(select(PackageReceipt).where(PackageReceipt.organization_id==oid,PackageReceipt.fingerprint==fp))
        if old:return import_info(old,True)
        raise
    return import_info(receipt)

def accessible(request,db,a,aid,write=False):
    oid=tenant(request,db,a,learning=True) if a.role=='employee' else manager(request,db,a,'courses_manage' if write else None,write)
    test=db.get(ImportedAssessment,aid);require(test and test.organization_id==oid,'Тест не найден',404)
    p=parse(test.payload)
    if a.role=='employee':require(test.published and not test.archived and applies(a,p),'Тест недоступен',403)
    return test,p

def card(test,p):
    return {'id':test.id,'title':test.title,'description':p['description'],'published':test.published,'archived':test.archived,
            'tasks':len(p['tasks']),'written':sum(t['kind']=='written' for t in p['tasks']),'minutes':p['time_limit_minutes']}

@router.get('/api/assessments')
def assessments(request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=tenant(request,db,a,learning=True) if a.role=='employee' else manager(request,db,a)
    result=[]
    for test in db.scalars(select(ImportedAssessment).where(ImportedAssessment.organization_id==oid).order_by(ImportedAssessment.id.desc())).all():
        p=parse(test.payload)
        if a.role=='employee' and (not test.published or test.archived or not applies(a,p)):continue
        result.append(card(test,p))
    return result

@router.get('/api/assessments/{aid}')
def assessment(aid:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    test,p=accessible(request,db,a,aid)
    if a.role!='employee':
        attempts=db.scalars(select(WrittenAttempt).where(WrittenAttempt.assessment_id==aid).order_by(WrittenAttempt.started_at.desc())).all()
        names={x.id:x.name for x in db.scalars(select(Account).where(Account.id.in_({r.account_id for r in attempts}))).all()} if attempts else {}
        return {**card(test,p),'package':p,'attempts':[{**attempt_data(x,False),'account_name':names.get(x.account_id,'Участник')} for x in attempts]}
    attempts=db.scalars(select(WrittenAttempt).where(WrittenAttempt.assessment_id==aid,WrittenAttempt.account_id==a.id).order_by(WrittenAttempt.started_at.desc())).all()
    return {**card(test,p),'instructions':p['instructions'],'max_attempts':p['max_attempts'],'attempts':[attempt_data(x,False) for x in attempts]}

@router.post('/api/assessments/{aid}/publish')
def publish(aid:int,data:ConfirmIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    require(data.reviewed,'Подтвердите проверку файла и рубрик')
    test,p=accessible(request,db,a,aid,True);test.published=True;test.archived=False
    for employee in db.scalars(select(Account).where(Account.organization_id==test.organization_id,Account.role=='employee',Account.active==True)).all():
        if applies(employee,p) and not db.scalar(select(Notice.id).where(Notice.account_id==employee.id,Notice.url=='/app/assessments/'+str(aid))):
            db.add(Notice(account_id=employee.id,event_key='assessment:'+str(aid),title='Назначен тест',body=test.title,url='/app/assessments/'+str(aid)))
    log(db,a,test.organization_id,'Опубликован импортированный тест',assessment_id=aid);db.commit();return {'ok':True}

@router.post('/api/assessments/{aid}/archive')
def archive(aid:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    test,p=accessible(request,db,a,aid,True);test.archived=not test.archived;db.commit();return {'archived':test.archived}

def submit_attempt(attempt):
    if attempt.status!='in_progress':return
    attempt.status='submitted';attempt.submitted_at=min(now(),attempt.expires_at);attempt.version+=1
    if all(t['kind']=='single_choice' for t in parse(attempt.snapshot)['tasks']):attempt.status='graded';attempt.graded_at=now()

def attempt_access(request,db,a,rid,write=False):
    attempt=db.scalar(select(WrittenAttempt).where(WrittenAttempt.id==rid).with_for_update())
    require(attempt,'Попытка не найдена',404)
    accessible(request,db,a,attempt.assessment_id,write)
    if a.role=='employee':require(attempt.account_id==a.id,'Попытка не найдена',404)
    # Keep FOR UPDATE until the endpoint commits, including an expiry followed by review.
    if attempt.status=='in_progress' and attempt.expires_at<=now():submit_attempt(attempt);db.flush()
    return attempt

def score_result(attempt):
    p=parse(attempt.snapshot);answers=parse(attempt.answers);grades=parse(attempt.grades);points=Decimal(0);maximum=Decimal(0);review=[]
    for t in p['tasks']:
        maximum+=Decimal(str(t['points']));answer=answers.get(t['id']);g=grades.get(t['id'],{})
        got=Decimal(str(t['points'])) if t['kind']=='single_choice' and answer==t['correct_index'] else Decimal(0)
        if t['kind']=='written':
            raw=sum((Decimal(str(x)) for x in g.get('scores',{}).values()),Decimal(0));scale=sum(Decimal(str(c['points'])) for c in t['rubric'])
            got=Decimal(str(t['points']))*raw/scale
            if g.get('cap_applied') and t.get('score_cap'):got=min(got,Decimal(str(t['score_cap']['points'])))
        points+=got;review.append({'id':t['id'],'prompt':t['prompt'],'points':float(got),'maximum':t['points'],'feedback':g.get('feedback',''),'cap_applied':g.get('cap_applied',False)})
    percent=round(float(100*points/maximum),2)
    return {'points':float(points),'maximum':float(maximum),'percent':percent,'passed':percent>=p['passing_score'] if p['passing_score'] is not None else None,'review':review}

def attempt_data(attempt,questions=True,keys=False):
    p=parse(attempt.snapshot)
    result={'id':attempt.id,'assessment_id':attempt.assessment_id,'account_id':attempt.account_id,'title':p['title'],'status':attempt.status,'version':attempt.version,
            'section_index':attempt.section_index,'started_at':iso(attempt.started_at),'expires_at':iso(attempt.expires_at),'server_time':iso(now()),
            'result':score_result(attempt) if attempt.status=='graded' or keys else None}
    if questions:
        allowed=p['sections'] if keys or not p['sequential_sections'] else p['sections'][:attempt.section_index+1]
        ids={s['id'] for s in allowed};items=[t for t in p['tasks'] if t['section_id'] in ids]
        result.update(instructions=p['instructions'],sections=allowed,sequential_sections=p['sequential_sections'],last_section=attempt.section_index==len(p['sections'])-1,
                      tasks=[t if keys else {k:v for k,v in t.items() if k not in {'correct_index','explanation','rubric','score_cap'}} for t in items],answers=parse(attempt.answers))
        if keys:result['grades']=parse(attempt.grades)
    return result

@router.post('/api/assessments/{aid}/start')
def start(aid:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    require(a.role=='employee','Откройте кабинет сотрудника',403)
    test,p=accessible(request,db,a,aid)
    db.execute(select(Account).where(Account.id==a.id).with_for_update()).first()
    previous=db.scalars(select(WrittenAttempt).where(WrittenAttempt.assessment_id==aid,WrittenAttempt.account_id==a.id).order_by(WrittenAttempt.started_at.desc())).all()
    for attempt in previous:
        if attempt.status=='in_progress':
            if attempt.expires_at<=now():submit_attempt(attempt)
            else:db.commit();return attempt_data(attempt)
    require(len(previous)<p['max_attempts'],'Лимит попыток исчерпан',409)
    require(not db.scalar(select(WrittenAttempt.id).where(WrittenAttempt.account_id==a.id,WrittenAttempt.status=='in_progress',WrittenAttempt.expires_at>now())),'Завершите другой письменный тест',409)
    require(not db.scalar(select(Exam.id).where(Exam.account_id==a.id,Exam.finished_at.is_(None),Exam.expires_at>now())),'Завершите текущий итоговый тест',409)
    rng=secrets.SystemRandom()
    for t in p['tasks']:
        if t['kind']=='single_choice':
            order=list(range(len(t['choices'])));rng.shuffle(order);t['choices']=[t['choices'][i] for i in order];t['correct_index']=order.index(t['correct_index'])
    attempt=WrittenAttempt(id=secrets.token_urlsafe(28),organization_id=test.organization_id,assessment_id=aid,account_id=a.id,snapshot=dump(p),expires_at=now()+timedelta(minutes=p['time_limit_minutes']))
    db.add(attempt);db.commit();return attempt_data(attempt)

@router.get('/api/assessment-attempts/{rid}')
def attempt(rid:str,request:Request,a=Depends(actor),db=Depends(get_db)):
    row=attempt_access(request,db,a,rid);result=attempt_data(row,keys=a.role!='employee')
    if a.role!='employee':result['account_name']=db.get(Account,row.account_id).name
    db.commit()
    return result

@router.put('/api/assessment-attempts/{rid}')
def answers(rid:str,data:AnswersIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    require(a.role=='employee','Только участник может сохранять свои ответы',403)
    row=attempt_access(request,db,a,rid);require(row.status=='in_progress','Работа уже сдана',409);require(row.version==data.version,'Ответы изменены в другом окне. Обновите попытку.',409)
    p=parse(row.snapshot);tasks={t['id']:t for t in p['tasks']};saved=parse(row.answers)
    for key,value in data.answers.items():
        t=tasks.get(key);require(t,'Неизвестное задание')
        require(not p['sequential_sections'] or t['section_id']==p['sections'][row.section_index]['id'],'Раздел закрыт для редактирования',409)
        require((t['kind']=='written' and type(value) is str and len(value)<=t['max_length']) or (t['kind']=='single_choice' and type(value) is int and 0<=value<len(t['choices'])),'Некорректный ответ')
        saved[key]=value
    row.answers=dump(saved);row.version+=1;db.commit();return attempt_data(row)

@router.post('/api/assessment-attempts/{rid}/advance')
def advance(rid:str,data:VersionIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    require(a.role=='employee','Только участник может сдавать разделы',403)
    row=attempt_access(request,db,a,rid);require(row.status=='in_progress' and row.version==data.version,'Обновите попытку',409);p=parse(row.snapshot)
    require(p['sequential_sections'] and row.section_index<len(p['sections'])-1,'Следующего раздела нет',409)
    row.section_index+=1;row.version+=1;db.commit();return attempt_data(row)

@router.post('/api/assessment-attempts/{rid}/submit')
def submit(rid:str,data:VersionIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    require(a.role=='employee','Только участник может сдавать работу',403)
    row=attempt_access(request,db,a,rid)
    if row.status!='in_progress':
        result=attempt_data(row);db.commit();return result
    require(row.version==data.version,'Сначала сохраните актуальные ответы',409);p=parse(row.snapshot)
    require(not p['sequential_sections'] or row.section_index==len(p['sections'])-1,'Сначала сдайте предыдущие разделы',409)
    submit_attempt(row);db.commit();return attempt_data(row)

@router.post('/api/assessment-attempts/{rid}/review')
def review(rid:str,data:ReviewIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    require(a.role in {'owner','manager'},'Проверка доступна управляющему',403)
    row=attempt_access(request,db,a,rid,True);require(row.status=='submitted','Работа ещё не сдана или уже проверена',409);require(row.version==data.version,'Оценку изменили в другом окне',409)
    tasks=[t for t in parse(row.snapshot)['tasks'] if t['kind']=='written'];require(set(data.grades)=={t['id'] for t in tasks},'Оцените каждое письменное задание')
    require(set(data.applied_caps)<={t['id'] for t in tasks if t.get('score_cap')},'Для этого задания ограничение балла не задано')
    grades={}
    for t in tasks:
        scores=data.grades[t['id']];require(set(scores)=={c['id'] for c in t['rubric']},'Оцените все критерии')
        for c in t['rubric']:require(type(scores[c['id']]) in {int,float} and math.isfinite(scores[c['id']]) and 0<=scores[c['id']]<=c['points'],'Баллы за критерий вне диапазона')
        feedback=data.feedback.get(t['id'],'');require(len(feedback)<=4000,'Комментарий слишком длинный')
        cap=data.applied_caps.get(t['id'],False)
        require(not cap or bool(feedback.strip()),'Укажите в комментарии причину ограничения балла')
        grades[t['id']]={'scores':scores,'feedback':feedback,'cap_applied':cap}
    row.grades=dump(grades);row.status='graded';row.graded_at=now();row.version+=1;log(db,a,row.organization_id,'Проверен письменный тест',attempt_id=rid);db.commit();return attempt_data(row,keys=True)
