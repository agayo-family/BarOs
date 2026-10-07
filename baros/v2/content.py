import asyncio
import math
import secrets
from datetime import timedelta
from pathlib import Path
from fastapi import APIRouter, Depends, Request, UploadFile, File, Form
from fastapi.responses import Response
from sqlalchemy import select, delete, func
from ..db import get_db
from ..models import Organization, Course, Lesson, Question
from .models import *
from .domain import *
from .auth import actor, manager
from .schemas import *
from .extraction import extract, validate_file, MIMES
from . import ai

router=APIRouter()


def get_course(db,oid,cid):
    c=db.get(Course,cid);require(c and c.organization_id==oid,'Курс не найден',404);return c


def course_card(db,c):
    s=course_settings(db,c)
    return {'id':c.id,'title':c.title,'description':c.description,'published':c.published,'archived':s.archived,'version':s.version,
            'edit_version':s.edit_version,'positions':parse(s.positions_json,['all']),'lessons':len(c.lessons),'questions':len(c.questions),
            'quiz_size':s.quiz_size,'is_intro':s.is_intro,'ai_generated':s.ai_generated,'bank_target':s.bank_target,'required':c.required,
            'passing_score':c.passing_score,'due_at':iso(s.due_at),'updated_at':iso(s.updated_at)}


@router.get('/api/courses')
def courses(request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a)
    return [course_card(db,c) for c in db.scalars(select(Course).where(Course.organization_id==oid).order_by(Course.id.desc())).all()]


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
    needed=max(s.bank_target,s.quiz_size) if s.ai_generated else s.quiz_size
    require(len(c.questions)>=needed,f'Нужно минимум {needed} вопросов. Сейчас {len(c.questions)}.')
    normalized={ai.norm(q.prompt) for q in c.questions}
    require(len(normalized)==len(c.questions),'В банке есть одинаковые вопросы. Удалите повторы.')
    for q in c.questions:QuestionIn(prompt=q.prompt,choices=parse(q.choices_json,[]),correct_index=q.correct_index,explanation=q.explanation,type=q.question_type)
    require(not s.due_at or s.due_at>now(),'Срок прохождения уже истёк. Укажите новую дату.')
    data_payload=payload(db,c)
    previous=revision(db,c)
    if c.published and previous and parse(previous.payload)==data_payload:
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
    s=course_settings(db,c);s.archived=not s.archived
    log(db,a,oid,'Курс архивирован' if s.archived else 'Курс восстановлен',course_id=cid);db.commit();return {'archived':s.archived}


@router.get('/api/interview')
def interview(request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a);return parse(db.get(Organization,oid).interview_json)


@router.put('/api/interview')
def edit_interview(data:InterviewIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'onboarding_edit',True);org=db.get(Organization,oid)
    if data.roles_present:positions(data.roles_present,False)
    org.interview_json=dump(data.model_dump());log(db,a,oid,'Сохранено интервью заведения');db.commit();return {'ok':True}


def intro_questions(data):
    """Build a source-limited starter test from the manager interview."""
    def short(value, fallback, limit=360):
        value=' '.join(str(value or '').split()) or fallback
        return value if len(value)<=limit else value[:limit-1].rstrip()+'…'
    concept=short(data.get('concept'),'описание концепции из интервью')
    guest=short(data.get('guest_profile'),'гостевой профиль из интервью')
    service=short(data.get('service_style'),'описанный стиль сервиса')
    must=short(data.get('must_know'),'обязательные знания перед самостоятельной сменой')
    rules=short(data.get('special_rules'),'действовать по утверждённому стандарту и уточнять спорные случаи у менеджера')
    tone=short(data.get('tone'),'тон общения, описанный управляющим')
    return [
        {'prompt':'Какой вариант точнее всего передаёт концепцию заведения?', 'correct':concept,
         'wrong':['Основной ориентир — только скорость выдачи, даже если меняется впечатление гостя.', 'Концепция определяется ассортиментом, а единый опыт гостя не является отдельной задачей.', 'Единого характера у заведения нет: каждый сотрудник выбирает подачу самостоятельно.'], 'type':'understanding', 'explanation':'Правильный ответ дословно опирается на описание концепции из интервью.'},
        {'prompt':'На какого гостя в первую очередь рассчитаны сервис и коммуникация?', 'correct':guest,
         'wrong':['На любого гостя без учёта его ожиданий и повода визита.', 'Только на гостя с самым высоким чеком в конкретной смене.', 'На постоянных гостей; новым посетителям достаточно нейтрального шаблона.'], 'type':'understanding', 'explanation':'Профиль гостя берётся из интервью и задаёт контекст персонального сервиса.'},
        {'prompt':'Как должен выглядеть стиль сервиса в этом заведении?', 'correct':service,
         'wrong':['Единый нейтральный стиль без связи с характером заведения.', 'Максимально быстрый сервис; способ общения каждый сотрудник выбирает сам.', 'Только дословное чтение скрипта независимо от ситуации гостя.'], 'type':'understanding', 'explanation':'Ориентиром служит описание стандарта сервиса, которое дал управляющий.'},
        {'prompt':'Что сотрудник обязан знать до первой самостоятельной смены?', 'correct':must,
         'wrong':['Только расположение своего рабочего места; остальные стандарты можно узнать позже.', 'Лишь список популярных позиций, без критериев действий и качества.', 'Достаточно один раз услышать инструктаж, даже если материал не изучен.'], 'type':'knowledge', 'explanation':'Правильный ответ повторяет обязательный минимум из интервью заведения.'},
        {'prompt':'Гость просит исключение, а сотрудник не уверен, как применить локальное правило. Как поступить?', 'correct':rules,
         'wrong':['Сразу согласиться, если просьба кажется разумной, а менеджеру сообщить после обслуживания.', 'Придумать компромисс самостоятельно, чтобы не задерживать гостя.', 'Игнорировать правило и ориентироваться только на личный опыт сотрудника.'], 'type':'scenario', 'explanation':'В тесте нужно выбрать локальное правило заведения, а не догадку сотрудника.'},
        {'prompt':'Каким должен быть тон общения с гостем?', 'correct':tone,
         'wrong':['Одинаково формальным на любой ситуации и для любой аудитории.', 'Полностью зависеть от личного настроения сотрудника.', 'Сводиться только к скорости принятия заказа без атмосферы заведения.'], 'type':'sales', 'explanation':'Тон общения определяется тем, как его описали в интервью.'},
        {'prompt':'Какой порядок подготовки нового сотрудника соответствует интервью?', 'correct':f'Сначала изучить: {must}; затем подтвердить понимание материала перед самостоятельной сменой.',
         'wrong':['Сначала допустить к самостоятельной смене, а стандарты выдать после первой ошибки.', 'Ограничиться знакомством с коллегами и не проверять рабочие знания.', 'Попросить сотрудника выбрать собственные правила под свой стиль.'], 'type':'scenario', 'explanation':'Проверяется конкретный минимум, который управляющий указал для допуска к работе.'},
        {'prompt':'Что делать, если личная привычка сотрудника расходится со стандартом заведения?', 'correct':'Сохранить утверждённый стандарт, а личную подачу менять только в допустимых границах.',
         'wrong':['Использовать личную привычку, если она кажется быстрее.', 'Смешивать оба подхода поровну, не уточняя приоритет.', 'Отложить решение и продолжить смену без единого правила.'], 'type':'scenario', 'explanation':'Материалы заведения задают обязательную основу, которую нельзя заменять личной догадкой.'},
    ]


@router.post('/api/interview/draft')
def interview_draft(request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'courses_manage',True);org=db.get(Organization,oid);data=parse(org.interview_json)
    require(data.get('concept'),'Сначала заполните интервью')
    labels={'concept':'Концепция и характер','guest_profile':'Наш гость','service_style':'Стандарт сервиса','must_know':'До первой смены','common_mistakes':'Частые ошибки','special_rules':'Правила заведения','tone':'Как мы общаемся'}
    c=Course(organization_id=oid,title='Добро пожаловать в '+org.name,description='Знакомство с заведением и стандартами команды',target_role='all',published=False)
    db.add(c);db.flush()
    for i,(key,label) in enumerate(labels.items()):
        if data.get(key):db.add(Lesson(course_id=c.id,title=label,body=data[key],sort_order=i))
    for item in intro_questions(data):
        db.add(Question(course_id=c.id,prompt=item['prompt'],choices_json=dump([item['correct'],*item['wrong']]),correct_index=0,
                        explanation=item['explanation'],question_type=item['type']))
    db.add(CourseSettings(course_id=c.id,is_intro=True,quiz_size=8,positions_json='["all"]'))
    log(db,a,oid,'Создан вводный черновик из интервью',course_id=c.id);db.commit();return {'id':c.id}


def source_card(s):
    return {'id':s.id,'name':s.name,'size':s.size,'characters':len(s.text),'positions':parse(s.positions_json,['all']),
            'status':s.extraction_status,'warning':s.warning,'created_at':iso(s.created_at),'original_available':s.content is not None}


@router.get('/api/sources')
def sources(request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a)
    return [source_card(s) for s in db.scalars(select(SourceFile).where(SourceFile.organization_id==oid).order_by(SourceFile.id.desc())).all()]


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
    s.text=data.text;s.positions_json=dump(positions(data.positions));s.extraction_status='ready' if len(data.text)>=20 else 'needs_text';s.warning='Текст проверен и отредактирован вручную'
    log(db,a,oid,'Исправлен текст материала',source_id=sid);db.commit();return source_card(s)


@router.delete('/api/sources/{sid}')
def delete_source(sid:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'uploads_manage',True);s=get_source(db,oid,sid)
    db.delete(s);log(db,a,oid,'Удалён исходный файл',source_id=sid);db.commit();return {'ok':True}


def job_card(j):
    cp=parse(j.checkpoint)
    return {'id':j.id,'status':j.status,'phase':j.phase,'progress':j.progress,'target':j.target,'questions':len(cp.get('questions',[])),
            'course_id':j.course_id,'error':j.error,'created_at':iso(j.created_at),'limitations':cp.get('limitations',[]),'calls':j.call_count}


@router.get('/api/jobs')
def jobs(request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a)
    return {'ai':ai.status(),'jobs':[job_card(j) for j in db.scalars(select(Job).where(Job.organization_id==oid).order_by(Job.created_at.desc()).limit(30)).all()]}


@router.post('/api/jobs')
def generate(data:GenerateIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'ai_use',True);manager(request,db,a,'courses_manage',True)
    require(ai.provider(),'AI не подключён: добавьте OPENROUTER_API_KEY в настройках сервера',503)
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
    for sid in data.source_ids:
        source=get_source(db,oid,sid)
        require(source.extraction_status=='ready' and len(source.text)>=20,f'Проверьте текст файла «{source.name}»')
        context+=f'\nМАТЕРИАЛ: {source.name}\n{source.text}\n'
    require(len(context)<=90000,'Выбрано более 90 000 символов. Разделите материалы на несколько курсов.')
    target=min(400,max(100,math.ceil(len(context)/10000)*40))
    j=Job(id=secrets.token_urlsafe(24),organization_id=oid,account_id=a.id,context=context,positions_json=dump(pos),
          target=target,source_ids_json=dump(data.source_ids),checkpoint=dump({'is_intro':data.interview and not data.source_ids}))
    db.add(j);log(db,a,oid,'Запущен AI-методист',job_id=j.id,target=target);db.commit();return job_card(j)


@router.post('/api/jobs/{jid}/retry')
def retry(jid:str,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'ai_use',True);manager(request,db,a,'courses_manage',True)
    j=db.get(Job,jid);require(j and j.organization_id==oid,'Задача не найдена',404)
    require(j.status in {'failed','needs_review'},'Задача уже выполняется или завершена',409)
    if j.course_id:
        s=db.get(CourseSettings,j.course_id)
        require(s.edit_version==1 and s.version==0,'Черновик уже редактировали. Дополните его вручную или создайте новое обучение.',409)
    require(ai.provider(),'AI не подключён',503)
    require(not db.scalar(select(Job.id).where(Job.organization_id==oid,Job.status.in_(['queued','running']))),'Уже создаётся обучение',409)
    j.status='queued';j.error='';j.phase='Продолжаем с сохранённого шага';j.lease_token=None;j.lease_until=None
    log(db,a,oid,'AI-генерация продолжена',job_id=j.id);db.commit();return job_card(j)
