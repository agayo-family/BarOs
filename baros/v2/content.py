import asyncio
import math
import os
import secrets
from datetime import timedelta
from pathlib import Path
from fastapi import APIRouter, Depends, Request, UploadFile, File, Form
from fastapi.responses import Response
from sqlalchemy import select, delete, func
from sqlalchemy.orm import defer
from pydantic import ValidationError
from ..db import get_db
from ..models import Organization, Course, Lesson, Question
from .models import *
from .domain import *
from .auth import actor, manager
from .schemas import *
from .extraction import extract, validate_file, MIMES
from . import ai
from . import source_review

router=APIRouter()


def get_course(db,oid,cid):
    c=db.get(Course,cid);require(c and c.organization_id==oid,'Курс не найден',404);return c


def course_card(db,c,s=None,counts=None,program=None):
    s=s or course_settings(db,c)
    lesson_count,question_count=counts if counts is not None else (len(c.lessons),len(c.questions))
    return {'id':c.id,'title':c.title,'description':c.description,'published':c.published,'archived':s.archived,'version':s.version,
            'edit_version':s.edit_version,'positions':parse(s.positions_json,['all']),'lessons':lesson_count,'questions':question_count,
            'quiz_size':s.quiz_size,'is_intro':s.is_intro,'ai_generated':s.ai_generated,'bank_target':s.bank_target,'required':c.required,
            'passing_score':c.passing_score,'due_at':iso(s.due_at),'updated_at':iso(s.updated_at),
            'source_review_required':bool((program if program is not None else parse(getattr(db.get(CourseProgram,c.id),'payload',None))).get('source_review',{}).get('required'))}


@router.get('/api/courses')
def courses(request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a)
    rows=db.scalars(select(Course).where(Course.organization_id==oid).order_by(Course.id.desc())).all()
    ids=[c.id for c in rows]
    if not ids:return []
    configs={s.course_id:s for s in db.scalars(select(CourseSettings).where(CourseSettings.course_id.in_(ids))).all()}
    lessons=dict(db.execute(select(Lesson.course_id,func.count(Lesson.id)).where(Lesson.course_id.in_(ids)).group_by(Lesson.course_id)).all())
    questions=dict(db.execute(select(Question.course_id,func.count(Question.id)).where(Question.course_id.in_(ids)).group_by(Question.course_id)).all())
    programs={p.course_id:parse(p.payload) for p in db.scalars(select(CourseProgram).where(CourseProgram.course_id.in_(ids))).all()}
    return [course_card(db,c,configs.get(c.id),(lessons.get(c.id,0),questions.get(c.id,0)),programs.get(c.id,{})) for c in rows]


@router.get('/api/courses/{cid}')
def course(cid:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a);c=get_course(db,oid,cid)
    return {**payload(db,c),**{k:v for k,v in course_card(db,c).items() if k not in {'lessons','questions'}},'source_ids':parse(course_settings(db,c).source_ids_json,[])}


def save_course(db,c,data):
    s=course_settings(db,c)
    c.title=data.title;c.description=data.description;c.target_role=positions(data.positions)[0];c.passing_score=data.passing_score;c.required=data.required
    s.positions_json=dump(data.positions)
    for key in ['quiz_size','time_limit_minutes','max_attempts','deadline_days','is_intro']:setattr(s,key,getattr(data,key))
    s.due_at=naive_utc(data.due_at) if data.due_at else None
    for l in list(c.lessons):db.delete(l)
    for q in list(c.questions):db.delete(q)
    db.flush()
    for i,l in enumerate(data.lessons):db.add(Lesson(course_id=c.id,title=l.title,body=l.body,sort_order=i))
    for q in data.questions:db.add(Question(course_id=c.id,prompt=q.prompt,choices_json=dump(q.choices),correct_index=q.correct_index,explanation=q.explanation,question_type=q.type))
    s.edit_version+=1;s.updated_at=now();db.flush()
    db.expire(c,['lessons','questions'])


@router.post('/api/courses')
def create_course(data:CourseIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'courses_manage',True)
    c=Course(organization_id=oid,title=data.title,published=False);db.add(c);db.flush()
    save_course(db,c,data);log(db,a,oid,'Создан черновик курса',course_id=c.id);db.commit()
    return {'id':c.id,'edit_version':course_settings(db,c).edit_version}


@router.put('/api/courses/{cid}')
def update_course(cid:int,data:CourseIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'courses_manage',True);c=get_course(db,oid,cid)
    s=db.scalar(select(CourseSettings).where(CourseSettings.course_id==cid).with_for_update())
    require(data.edit_version==s.edit_version,'Курс изменён в другом окне. Обновите страницу перед сохранением.',409)
    if os.getenv('BAROS_AI_ENABLED','0')=='1':
        require(not db.scalar(select(Job.id).where(Job.course_id==cid,Job.status.in_(['queued','running']))),'Дождитесь окончания генерации',409)
    save_course(db,c,data);log(db,a,oid,'Обновлён черновик курса',course_id=c.id);db.commit()
    return {'ok':True,'edit_version':s.edit_version}


@router.post('/api/courses/{cid}/publish')
def publish(cid:int,data:PublishIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'courses_manage',True);c=get_course(db,oid,cid)
    s=db.scalar(select(CourseSettings).where(CourseSettings.course_id==cid).with_for_update())
    require(s.edit_version==data.edit_version,'Сначала сохраните актуальный черновик',409)
    require(data.reviewed,'Подтвердите проверку фактов, теории и ответов')
    require(c.lessons,'Добавьте хотя бы один теоретический урок')
    needed=s.quiz_size
    program=db.get(CourseProgram,cid);aid=(parse(program.payload) if program else {}).get('written_assessment_id')
    require(needed>0 or aid,'Для курса без автотеста привяжите отдельную проверку',409)
    if aid:validate_final(db,oid,aid,parse(s.positions_json,['all']))
    require(len(c.questions)>=needed,f'Нужно минимум {needed} вопросов. Сейчас {len(c.questions)}.')
    normalized={ai.norm(q.prompt) for q in c.questions}
    require(len(normalized)==len(c.questions),'В банке есть одинаковые вопросы. Удалите повторы.')
    try:
        for lesson in c.lessons: LessonIn(title=lesson.title,body=lesson.body)
        for q in c.questions: QuestionIn(prompt=q.prompt,choices=parse(q.choices_json,[]),correct_index=q.correct_index,explanation=q.explanation,type=q.question_type)
    except ValidationError:
        require(False,'В черновике есть некорректный урок или вопрос. Проверьте текст, четыре разных ответа и объяснение.',409)
    require(not s.due_at or s.due_at>now(),'Срок прохождения уже истёк. Укажите новую дату.')
    from .drafts import acknowledge_origin
    acknowledge_origin(db,oid,'course',cid)
    source_review.acknowledge(db,cid)
    data_payload=payload(db,c)
    previous=revision(db,c)
    if c.published and previous and parse(previous.payload)==data_payload:
        db.commit()
        return {'ok':True,'version':s.version,'assigned':0,'unchanged':True}
    s.version+=1;s.archived=False;c.published=True
    rev=CourseRevision(course_id=cid,version=s.version,payload=dump(data_payload));db.add(rev);db.flush()
    count=0
    for e in db.scalars(select(Account).where(Account.organization_id==oid,Account.role=='employee',Account.active==True)).all():
        if applies(e,data_payload):enroll(db,e,rev);count+=1
    log(db,a,oid,'Опубликован курс',course_id=cid,version=s.version,assigned=count);db.commit()
    return {'ok':True,'version':s.version,'assigned':count}


@router.post('/api/courses/{cid}/archive')
def archive_course(cid:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'courses_manage',True);c=get_course(db,oid,cid)
    s=db.scalar(select(CourseSettings).where(CourseSettings.course_id==cid).with_for_update())
    if s.archived and c.published:
        rev=revision(db,c);published=parse(rev.payload) if rev else {};aid=(published.get('program') or {}).get('written_assessment_id')
        if aid:validate_final(db,oid,aid,published['positions'])
    s.archived=not s.archived
    log(db,a,oid,'Курс архивирован' if s.archived else 'Курс восстановлен',course_id=cid);db.commit();return {'archived':s.archived}


@router.get('/api/interview')
def interview(request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a);return parse(db.get(Organization,oid).interview_json)


@router.put('/api/interview')
def edit_interview(data:InterviewIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'onboarding_edit',True);org=db.get(Organization,oid)
    if data.roles_present:positions(data.roles_present,False)
    org.interview_json=dump(data.model_dump());log(db,a,oid,'Сохранено интервью заведения');db.commit();return {'ok':True}


def validate_final(db,oid,aid,roles):
    t=db.scalar(select(ImportedAssessment).where(ImportedAssessment.id==aid).with_for_update())
    require(t and t.organization_id==oid and t.published and not t.archived,'Сначала проверьте и опубликуйте связанный тест',409)
    target=set(parse(t.payload)['positions']);roles=set(roles)
    require('all' in target or 'all' not in roles and roles<=target,'Назначьте итоговый тест всем должностям курса',409)


def intro_assessment(data):
    prompts={'concept':'Объясните новому гостю идею и характер заведения своими словами.','guest_profile':'Как учесть ожидания основного гостя при рекомендации? Приведите пример.','service_style':'Один гость спешит, другой хочет обсудить меню. Как обслужить каждого по нашему стандарту?','must_know':'Что нужно знать перед самостоятельной сменой и как проверить свою готовность?','special_rules':'Гость просит исключение из правила. Опишите действия и объясните решение.','tone':'Напишите приветствие и объяснение отказа в принятом у нас тоне.','common_mistakes':'Вы заметили одну из описанных ошибок. Как исправить ситуацию и предотвратить повторение?'}
    tasks=[{'id':key,'section_id':'intro','kind':'written','prompt':prompt,'points':10,'rubric':[{'id':'source','label':'Соответствие стандарту заведения','points':7,'guidance':'Ориентир из интервью: '+data[key]+'. Принимайте разные формулировки с тем же смыслом; не требуйте дословного совпадения.'},{'id':'reason','label':'Понятное объяснение и применимость','points':3,'guidance':'Обоснованное решение и выполнимые действия в рамках стандарта.'}]} for key,prompt in prompts.items() if data.get(key)]
    return {'title':'Знакомство с заведением: ситуации','description':'Понимание концепции, сервиса и правил команды.','instructions':'Отвечайте своими словами. Если данных недостаточно, укажите, что нужно уточнить.','positions':['all'],'sections':[{'id':'intro','title':'Наши стандарты'}],'tasks':tasks,'time_limit_minutes':60,'max_attempts':3,'passing_score':80,'sequential_sections':True}


@router.post('/api/interview/draft')
def interview_draft(request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'courses_manage',True);org=db.get(Organization,oid);data=parse(org.interview_json)
    require(data.get('concept'),'Сначала заполните интервью')
    labels={'concept':'Концепция и характер','guest_profile':'Наш гость','service_style':'Стандарт сервиса','must_know':'До первой смены','common_mistakes':'Частые ошибки','special_rules':'Правила заведения','tone':'Как мы общаемся'}
    c=Course(organization_id=oid,title='Добро пожаловать в '+org.name,description='Знакомство с заведением и стандартами команды',target_role='all',published=False)
    db.add(c);db.flush()
    for i,(key,label) in enumerate(labels.items()):
        if data.get(key):db.add(Lesson(course_id=c.id,title=label,body=data[key],sort_order=i))
    test=ImportedAssessment(organization_id=oid,title='Знакомство с '+org.name,payload=dump(intro_assessment(data)))
    db.add(test);db.flush()
    db.add(CourseSettings(course_id=c.id,is_intro=True,quiz_size=0,positions_json='["all"]'))
    db.add(CourseProgram(course_id=c.id,payload=dump({'written_assessment_id':test.id})))
    log(db,a,oid,'Создан вводный черновик из интервью',course_id=c.id);db.commit();return {'id':c.id}


def source_card(s,characters=None,original=None):
    from .ai_vision import needs_vision, available
    has_original=s.content is not None if original is None else original
    return {'id':s.id,'name':s.name,'size':s.size,'characters':len(s.text) if characters is None else characters,'positions':parse(s.positions_json,['all']),
            'status':s.extraction_status,'warning':s.warning,'created_at':iso(s.created_at),'original_available':has_original,
            'vision_ready':bool(has_original and s.size and available() and needs_vision(s))}


@router.get('/api/sources')
def sources(request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a)
    rows=db.execute(select(SourceFile,func.length(SourceFile.text),SourceFile.content.is_not(None))
        .options(defer(SourceFile.text),defer(SourceFile.content))
        .where(SourceFile.organization_id==oid).order_by(SourceFile.id.desc())).all()
    return [source_card(s,characters,original) for s,characters,original in rows]


@router.post('/api/sources')
async def upload(request:Request,file:UploadFile=File(...),roles:str=Form('["all"]'),a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'uploads_manage',True)
    role_list=positions(parse(roles,[]))
    chunks=[];total=0
    while chunk:=await file.read(1024*1024):
        total+=len(chunk);require(total<=15*1024*1024,'Максимальный размер — 15 МБ',413);chunks.append(chunk)
    raw=b''.join(chunks);name=Path(file.filename or 'document.txt').name[:255]
    try:ext=validate_file(name,raw)
    except Exception as exc:require(False,str(exc) if isinstance(exc,ValueError) else 'Файл повреждён или формат не поддерживается')
    s=db.scalar(select(VenueSettings).where(VenueSettings.organization_id==oid).with_for_update())
    used=db.scalar(select(func.coalesce(func.sum(SourceFile.size),0)).where(SourceFile.organization_id==oid)) or 0
    require(used+len(raw)<=s.storage_limit_mb*1024*1024,'Достигнут лимит материалов подписки',409)
    try:extracted,note=await asyncio.to_thread(extract,name,raw);state='ready'
    except Exception as exc:
        extracted='';note=str(exc)[:500] if isinstance(exc,ValueError) else 'Распознавание не завершено. Вставьте текст вручную.';state='needs_text'
    rec=SourceFile(organization_id=oid,name=name,mime=MIMES.get(ext,'text/plain'),size=len(raw),content=raw,text=extracted,
                   positions_json=dump(role_list),warning=note,extraction_status=state)
    db.add(rec);db.flush();log(db,a,oid,'Загружен материал',source_id=rec.id,name=name,characters=len(extracted));db.commit()
    return source_card(rec)


def get_source(db,oid,sid):
    s=db.get(SourceFile,sid);require(s and s.organization_id==oid,'Материал не найден',404);return s


@router.get('/api/sources/{sid}')
def source(sid:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a);s=get_source(db,oid,sid);return {**source_card(s),'text':s.text}


@router.get('/api/sources/{sid}/download')
def download(sid:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    from urllib.parse import quote
    oid=manager(request,db,a);s=get_source(db,oid,sid);require(s.content is not None,'Оригинал старого файла не сохранился',404)
    return Response(s.content,media_type='application/octet-stream',headers={'Content-Disposition':"attachment; filename*=UTF-8''"+quote(s.name)})


@router.put('/api/sources/{sid}')
def update_source(sid:int,data:SourceUpdate,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'uploads_manage',True);s=get_source(db,oid,sid)
    roles=dump(positions(data.positions))
    changed=s.text!=data.text or parse(s.positions_json,[])!=parse(roles,[])
    affected=source_review.mark_changed(db,oid,sid,'updated') if changed else 0
    s.text=data.text;s.positions_json=roles;s.extraction_status='ready' if len(data.text)>=20 else 'needs_text';s.warning='Текст проверен и отредактирован вручную'
    log(db,a,oid,'Исправлен текст материала',source_id=sid,courses_to_review=affected);db.commit();return {**source_card(s),'courses_to_review':affected}


@router.delete('/api/sources/{sid}')
def delete_source(sid:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'uploads_manage',True);s=get_source(db,oid,sid)
    pending=db.scalars(select(Job).where(Job.organization_id==oid,Job.status.in_(['queued','running']))).all() if os.getenv('BAROS_AI_ENABLED','0')=='1' else []
    require(not any(sid in parse(j.source_ids_json,[]) for j in pending),'Материал используется в текущей генерации. Дождитесь её завершения.',409)
    affected=source_review.mark_changed(db,oid,sid,'deleted')
    db.delete(s);log(db,a,oid,'Удалён исходный файл',source_id=sid,courses_to_review=affected);db.commit();return {'ok':True,'courses_to_review':affected}


def job_card(j):
    cp=parse(j.checkpoint)
    count=len(cp.get('questions',[]))
    theory=100 if cp.get('lessons') else (5 if j.status=='running' else 0)
    bank=min(100,math.floor(100*count/max(1,j.target)))
    overall=100 if j.status=='succeeded' else min(95,round(.15*theory+.8*bank))
    return {'id':j.id,'status':j.status,'phase':j.phase,'progress':overall,'target':j.target,'questions':count,
            'theory_progress':theory,'questions_progress':bank,'model_used':cp.get('model_used',''),
            'course_id':j.course_id,'error':j.error,'created_at':iso(j.created_at),'limitations':cp.get('limitations',[]),'calls':j.call_count}


@router.get('/api/jobs')
def jobs(request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a)
    from .ai_budget import overview
    from .ai_providers import overview as compatible_usage, public_status
    return {'ai':ai.status(),'usage':overview(db,None if a.role=='owner' else oid),'compatible_usage':compatible_usage(db,None if a.role=='owner' else oid),'mentor':public_status(),'jobs':[job_card(j) for j in db.scalars(select(Job).where(Job.organization_id==oid).order_by(Job.created_at.desc()).limit(30)).all()]}


@router.post('/api/jobs')
def generate(data:GenerateIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    require(os.getenv('BAROS_AI_ENABLED','0')=='1','Встроенная генерация отключена. Загрузите готовое обучение в черновики.',409)
    oid=manager(request,db,a,'ai_use',True);manager(request,db,a,'courses_manage',True)
    try: configured=ai.provider()
    except ValueError as error: require(False,str(error),503)
    require(configured,'AI не подключён. Владелец должен настроить ключ и провайдера в Render → Environment.',503)
    pos=positions(data.positions)
    db.execute(select(Setting).where(Setting.key=='ai_quota_lock').with_for_update()).first()
    s=db.scalar(select(VenueSettings).where(VenueSettings.organization_id==oid).with_for_update())
    count=db.scalar(select(func.count(Job.id)).where(Job.organization_id==oid,Job.created_at>=now()-timedelta(days=1))) or 0
    require(count<s.ai_daily_limit,'Дневной лимит генераций заведения исчерпан',429)
    require(not db.scalar(select(Job.id).where(Job.organization_id==oid,Job.status.in_(['queued','running']))),'Уже создаётся обучение. Дождитесь результата.',409)
    context='Тема: '+data.title+'\nДолжности: '+', '.join(POSITIONS.get(p,'Все должности') for p in pos)+'\n'
    if data.interview:
        interview=parse(db.get(Organization,oid).interview_json)
        require(interview.get('concept'),'Заполните интервью заведения')
        context+='ИНТЕРВЬЮ:\n'+dump(interview)+'\n'
    require(data.source_ids or data.interview,'Выберите файлы или интервью')
    from .ai_vision import needs_vision, available
    vision_ids=[];source_fingerprints={}
    for sid in dict.fromkeys(data.source_ids):
        source=get_source(db,oid,sid)
        source_fingerprints[str(sid)]=source_review.fingerprint(source)
        if source.content and needs_vision(source) and available():
            vision_ids.append(sid);continue
        require(source.extraction_status=='ready' and len(source.text)>=20,f'Проверьте текст файла «{source.name}»')
        context+=f'\nМАТЕРИАЛ: {source.name}\n{source.text}\n'
    require(len(context)<=90000,'Выбрано более 90 000 символов. Разделите материалы на несколько курсов.')
    target=data.question_target or ai.question_target(context)
    j=Job(id=secrets.token_urlsafe(24),organization_id=oid,account_id=a.id,context=context,positions_json=dump(pos),
          target=target,source_ids_json=dump(data.source_ids),checkpoint=dump({'is_intro':data.interview and not data.source_ids,'vision_ids':vision_ids,'explicit_target':data.question_target is not None,'source_fingerprints':source_fingerprints}))
    db.add(j);log(db,a,oid,'Запущен AI-методист',job_id=j.id,target=target);db.commit();return job_card(j)


@router.post('/api/jobs/{jid}/retry')
def retry(jid:str,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'ai_use',True);manager(request,db,a,'courses_manage',True)
    j=db.get(Job,jid);require(j and j.organization_id==oid,'Задача не найдена',404)
    require(j.status in {'failed','needs_review'},'Задача уже выполняется или завершена',409)
    if j.course_id:
        s=db.get(CourseSettings,j.course_id)
        require(s.edit_version==1 and s.version==0,'Черновик уже редактировали. Дополните его вручную или создайте новое обучение.',409)
    try: configured=ai.provider()
    except ValueError as error: require(False,str(error),503)
    require(configured,'AI не подключён',503)
    require(not db.scalar(select(Job.id).where(Job.organization_id==oid,Job.status.in_(['queued','running']))),'Уже создаётся обучение',409)
    j.status='queued';j.error='';j.phase='Продолжаем с сохранённого шага';j.lease_token=None;j.lease_until=None
    log(db,a,oid,'AI-генерация продолжена',job_id=j.id);db.commit();return job_card(j)


@router.get('/api/ai/usage')
def ai_usage(request:Request,a=Depends(actor),db=Depends(get_db)):
    from .ai_budget import overview
    if a.role=='owner':return overview(db)
    oid=manager(request,db,a);return overview(db,oid)


@router.get('/api/ai/spend')
def ai_spend(request:Request,a=Depends(actor),db=Depends(get_db)):
    from .ai_providers import overview
    if a.role=='owner':return overview(db)
    return overview(db,manager(request,db,a))
