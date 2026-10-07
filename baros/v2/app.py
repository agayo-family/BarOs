import asyncio
import os
import secrets
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlparse
from fastapi import FastAPI, Request, Depends, HTTPException
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError
from sqlalchemy import select, delete, func, text
from sqlalchemy.exc import IntegrityError
from ..config import FIRST_RUN_TOKEN, DATABASE_URL, COOKIE_SECURE
from ..db import Base, engine, SessionLocal, get_db
from ..models import Organization, Employee, Course, User
from ..security import hash_password, verify_password
from .models import *
from .domain import *
from .auth import actor, owner, manager, tenant, rate, ip, make_session, COOKIE
from .schemas import *
from . import ai

STATIC = Path(__file__).resolve().parent.parent/'static'/'v2'


@asynccontextmanager
async def lifespan(app):
    if DATABASE_URL.startswith('sqlite:'):
        path = DATABASE_URL.removeprefix('sqlite:///')
        if path != ':memory:': Path(path).parent.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        migrate(db)
        for key in ['ai_quota_lock','maintenance_lock']:
            if not db.get(Setting,key): db.add(Setting(key=key,value=''))
        db.commit()
        from .notifications import ensure_vapid
        ensure_vapid(db)
    stop = asyncio.Event()
    task = asyncio.create_task(ai.worker(stop)) if os.getenv('BAROS_WORKER','1') == '1' else None
    yield
    stop.set()
    if task:
        task.cancel()
        try: await task
        except asyncio.CancelledError: pass


app = FastAPI(title='BarOS', version='2.0.0', lifespan=lifespan, docs_url=None, redoc_url=None)
app.mount('/static/v2',StaticFiles(directory=STATIC),name='assets')


@app.middleware('http')
async def guard(request, call_next):
    if request.method not in {'GET','HEAD','OPTIONS'}:
        origin=request.headers.get('origin')
        if origin and urlparse(origin).netloc != request.headers.get('host'):
            return JSONResponse({'detail':'Запрос с другого сайта отклонён'},status_code=403)
        if request.headers.get('sec-fetch-site') == 'cross-site':
            return JSONResponse({'detail':'Запрос с другого сайта отклонён'},status_code=403)
        content_len=request.headers.get('content-length','0')
        try:
            if int(content_len) > 17*1024*1024: return JSONResponse({'detail':'Максимальный размер файла — 15 МБ'},status_code=413)
        except ValueError: return JSONResponse({'detail':'Некорректный запрос'},status_code=400)
        # Bodyless action endpoints (publish/archive/start exam) are valid; when a
        # body is present, require JSON everywhere except the multipart uploader.
        if request.url.path.startswith('/api/') and request.url.path != '/api/sources' and int(content_len or 0) > 0 and 'application/json' not in request.headers.get('content-type',''):
            return JSONResponse({'detail':'Ожидается JSON'},status_code=415)
    response=await call_next(request)
    response.headers['X-Content-Type-Options']='nosniff'
    response.headers['X-Frame-Options']='DENY'
    response.headers['Referrer-Policy']='no-referrer'
    response.headers['Permissions-Policy']='camera=(), microphone=(), geolocation=()'
    response.headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
    if request.url.path.startswith('/api/') or 'text/html' in response.headers.get('content-type',''):
        response.headers['Cache-Control']='no-store'
    return response


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    fields=[]
    for e in exc.errors()[:8]: fields.append('.'.join(str(x) for x in e['loc'][1:])+': '+e['msg'])
    return JSONResponse({'detail':'Проверьте заполнение полей', 'fields':fields},status_code=422)


@app.get('/health')
def health(db=Depends(get_db)):
    db.execute(text('SELECT 1'))
    return {'status':'ok','service':'baros','version':'2.0.0'}


@app.get('/api/public')
def public(db=Depends(get_db)):
    return {'positions':POSITIONS,'setup_required':not db.scalar(select(Account.id).limit(1)), 'version':'2.0.0'}


@app.post('/api/auth/setup')
def setup(data:dict,request:Request,db=Depends(get_db)):
    require(not db.scalar(select(Account.id).limit(1)),'Владелец уже создан',409)
    rate(db,'setup:'+ip(request),5)
    require(FIRST_RUN_TOKEN and secrets.compare_digest(str(data.get('token','')),FIRST_RUN_TOKEN),'Неверный ключ первоначальной настройки',403)
    require(len(str(data.get('password','')))>=12,'Пароль владельца: минимум 12 символов')
    require(2 <= len(str(data.get('name',''))) <= 160,'Укажите имя')
    require(3 <= len(str(data.get('login',''))) <= 255,'Укажите логин')
    a=Account(name=data['name'],login=data['login'].lower(),role='owner',password_hash=hash_password(data['password']))
    db.add(a); db.flush()
    response=JSONResponse({'ok':True}); make_session(db,response,a); return response


@app.post('/api/auth/login')
def login(data:LoginIn,request:Request,db=Depends(get_db)):
    rate(db,'login:'+ip(request)+':'+data.login.lower(),12)
    rate(db,'login-ip:'+ip(request),80)
    a=db.scalar(select(Account).where(Account.login==data.login.lower()))
    valid=verify_password(data.password,a.password_hash if a else hash_password('no-account-dummy'))
    require(a and a.active and valid,'Неверный логин или пароль',401)
    response=JSONResponse({'ok':True}); make_session(db,response,a); return response


@app.post('/api/auth/join')
def join(data:JoinIn,request:Request,db=Depends(get_db)):
    rate(db,'join:'+ip(request),12)
    s=db.scalar(select(VenueSettings).where(VenueSettings.join_code==data.code.replace('-','').upper()).with_for_update())
    require(s and s.status=='active','Код не найден или регистрация закрыта',400)
    require(s.subscription_status in {'trial','active'} and (not s.paid_until or s.paid_until>now()),'Подписка заведения приостановлена',402)
    require(parse(s.permissions_json).get('employee_access',True),'Регистрация временно закрыта',403)
    count=db.scalar(select(func.count(Account.id)).where(Account.organization_id==s.organization_id,Account.role=='employee',Account.active==True)) or 0
    require(count<s.seat_limit,'Достигнут лимит сотрудников. Обратитесь к управляющему.',409)
    pos=positions(data.positions,False)
    require(not db.scalar(select(Account.id).where(Account.login==data.login.lower())),'Этот логин уже занят',409)
    e=Employee(organization_id=s.organization_id,name=data.name,position=pos[0],invite_token=secrets.token_urlsafe(32))
    db.add(e);db.flush()
    a=Account(organization_id=s.organization_id,employee_id=e.id,login=data.login.lower(),name=data.name,
              role='employee',password_hash=hash_password(data.password),positions_json=dump(pos))
    db.add(a);db.flush();ensure_enrollments(db,a)
    log(db,a,s.organization_id,'Сотрудник зарегистрировался')
    response=JSONResponse({'ok':True});make_session(db,response,a);return response


@app.get('/api/invites/{token}')
def invite_info(token:str,db=Depends(get_db)):
    invite=db.scalar(select(Invite).where(Invite.token_hash==digest(token),Invite.used_at.is_(None),Invite.expires_at>now()))
    require(invite,'Ссылка использована или истекла. Запросите новую у владельца.',404)
    org=db.get(Organization,invite.organization_id)
    return {'organization':org.name,'kind':invite.kind}


@app.post('/api/invites/{token}')
def accept_invite(token:str,data:InviteIn,request:Request,db=Depends(get_db)):
    rate(db,'invite:'+ip(request),15)
    inv=db.scalar(select(Invite).where(Invite.token_hash==digest(token)).with_for_update())
    require(inv and not inv.used_at and inv.expires_at>now(),'Ссылка использована или истекла',410)
    require(settings(db,inv.organization_id).status not in {'suspended','archived'},'Заведение недоступно',403)
    secret=secrets.token_urlsafe(18)
    if inv.kind=='recovery':
        a=db.get(Account,inv.account_id); require(a and a.active,'Аккаунт недоступен',403)
        a.name=data.name;a.password_hash=hash_password(secret)
        db.execute(delete(LoginSession).where(LoginSession.account_id==a.id))
    else:
        a=Account(organization_id=inv.organization_id,name=data.name,login='manager-'+secrets.token_hex(5),role='manager',password_hash=hash_password(secret))
        db.add(a);db.flush()
        db.get(Organization,inv.organization_id).name=data.organization
    inv.used_at=now()
    log(db,a,inv.organization_id,'Приглашение принято',kind=inv.kind)
    response=JSONResponse({'ok':True,'login':a.login,'recovery_key':secret})
    make_session(db,response,a);return response


@app.post('/api/auth/logout')
def logout(request:Request,a=Depends(actor),db=Depends(get_db)):
    db.execute(delete(LoginSession).where(LoginSession.token_hash==digest(request.cookies.get(COOKIE,''))));db.commit()
    r=JSONResponse({'ok':True});r.delete_cookie(COOKIE);r.delete_cookie('baros_session');r.delete_cookie('baros_platform_session');return r


def account_data(a):
    return {'id':a.id,'name':a.name,'login':a.login,'role':a.role,'organization_id':a.organization_id,
            'positions':parse(a.positions_json,[]),'active':a.active,'permissions':parse(a.permissions_json),
            'created_at':iso(a.created_at),'last_seen_at':iso(a.last_seen_at)}


def venue_data(db,org):
    s=settings(db,org.id)
    count=db.scalar(select(func.count(Account.id)).where(Account.organization_id==org.id,Account.role=='employee',Account.active==True)) or 0
    course_count=db.scalar(select(func.count(Course.id)).where(Course.organization_id==org.id)) or 0
    return {'id':org.id,'name':org.name,'join_code':s.join_code,'status':s.status,'plan':s.plan,
            'subscription_status':s.subscription_status,'paid_until':iso(s.paid_until),'seat_limit':s.seat_limit,
            'storage_limit_mb':s.storage_limit_mb,'ai_daily_limit':s.ai_daily_limit,'note':s.note,'permissions':parse(s.permissions_json),
            'employees':count,'courses':course_count,'expired':bool(s.paid_until and s.paid_until<now()),'created_at':iso(org.created_at)}


@app.get('/api/me')
def me(request:Request,a=Depends(actor),db=Depends(get_db)):
    if a.role=='employee': ensure_enrollments(db,a);db.commit()
    org=db.get(Organization,a.organization_id) if a.organization_id else None
    unread=db.scalar(select(func.count(Notice.id)).where(Notice.account_id==a.id,Notice.read==False)) or 0
    return {'account':account_data(a),'venue':venue_data(db,org) if org else None,'csrf':request.state.csrf,
            'positions':POSITIONS,'permissions':PERMISSIONS,'question_types':QTYPES,'unread':unread,'ai':ai.status() if a.role!='employee' else None}


@app.put('/api/profile')
def profile(data:ProfileIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    a.name=data.name
    if data.new_password:
        require(verify_password(data.current_password,a.password_hash),'Текущий пароль указан неверно')
        require(len(data.new_password)>=10,'Новый пароль: минимум 10 символов')
        a.password_hash=hash_password(data.new_password)
        db.execute(delete(LoginSession).where(LoginSession.account_id==a.id,LoginSession.token_hash!=digest(request.cookies.get(COOKIE,''))))
    if a.employee_id: db.get(Employee,a.employee_id).name=data.name
    db.commit();return {'ok':True}


@app.get('/api/venues')
def venues(a=Depends(actor),db=Depends(get_db)):
    owner(a)
    orgs=db.scalars(select(Organization).where(Organization.name!='__BAROS_PLATFORM__').order_by(Organization.id.desc())).all()
    return [venue_data(db,o) for o in orgs]


@app.post('/api/venues')
def create_venue(data:VenueIn,a=Depends(actor),db=Depends(get_db)):
    owner(a)
    org=Organization(name=data.name);db.add(org);db.flush()
    s=settings(db,org.id);s.plan=data.plan;s.seat_limit=data.seat_limit;s.paid_until=now()+timedelta(days=data.days)
    log(db,a,org.id,'Создано заведение',name=org.name)
    db.commit();return venue_data(db,org)


@app.put('/api/venues/{org_id}')
def edit_venue(org_id:int,data:VenueUpdate,a=Depends(actor),db=Depends(get_db)):
    owner(a);org=db.get(Organization,org_id);require(org,'Заведение не найдено',404)
    s=settings(db,org_id);org.name=data.name
    for key in ['status','plan','subscription_status','seat_limit','storage_limit_mb','ai_daily_limit','note']: setattr(s,key,getattr(data,key))
    s.paid_until=naive_utc(data.paid_until) if data.paid_until else None
    require(set(data.permissions)<=set(PERMISSIONS)|{'employee_access','manager_access'},'Неизвестное разрешение')
    s.permissions_json=dump(data.permissions)
    log(db,a,org_id,'Изменены доступ и подписка',status=s.status,plan=s.plan,paid_until=iso(s.paid_until))
    db.commit();return venue_data(db,org)


@app.post('/api/venues/{org_id}/invite')
def create_invite(org_id:int,a=Depends(actor),db=Depends(get_db)):
    owner(a);require(db.get(Organization,org_id),'Заведение не найдено',404)
    token=secrets.token_urlsafe(32)
    db.add(Invite(organization_id=org_id,token_hash=digest(token),expires_at=now()+timedelta(hours=72)))
    log(db,a,org_id,'Создано приглашение управляющего');db.commit()
    return {'url':'/invite/'+token,'expires_in_hours':72}


@app.post('/api/venue/code')
def rotate_code(request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'employees_manage',True);s=settings(db,oid);s.join_code=code()
    log(db,a,oid,'Обновлён код присоединения');db.commit();return {'code':s.join_code}


@app.get('/api/venue')
def venue(request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a)
    return venue_data(db,db.get(Organization,oid))


@app.get('/api/staff')
def staff(request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a)
    result=[]
    for employee in db.scalars(select(Account).where(Account.organization_id==oid).order_by(Account.name)).all():
        item=account_data(employee)
        if employee.role=='employee': ensure_enrollments(db,employee);item['stats']=learner_stats(db,employee)
        result.append(item)
    db.commit();return result


@app.put('/api/staff/{account_id}')
def edit_staff(account_id:int,data:StaffIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'employees_manage',True)
    employee=db.get(Account,account_id);require(employee and employee.organization_id==oid,'Сотрудник не найден',404)
    require(employee.role=='employee' or a.role=='owner','Управляющий может изменять только сотрудников',403)
    require(employee.role!='owner','Нельзя изменять владельца',403)
    if data.active and not employee.active and employee.role=='employee':
        s=db.scalar(select(VenueSettings).where(VenueSettings.organization_id==oid).with_for_update())
        count=db.scalar(select(func.count(Account.id)).where(Account.organization_id==oid,Account.role=='employee',Account.active==True)) or 0
        require(count<s.seat_limit,'Достигнут лимит сотрудников',409)
    employee.name=data.name;employee.active=data.active
    if employee.role=='employee':
        employee.positions_json=dump(positions(data.positions,False))
        if employee.employee_id:
            old=db.get(Employee,employee.employee_id);old.position=data.positions[0];old.name=data.name;old.active=data.active
    else:
        require(set(data.permissions)<=set(PERMISSIONS),'Неизвестное разрешение')
        employee.permissions_json=dump(data.permissions)
    if not data.active: db.execute(delete(LoginSession).where(LoginSession.account_id==employee.id))
    ensure_enrollments(db,employee)
    log(db,a,oid,'Изменён сотрудник',account_id=employee.id,active=employee.active,positions=parse(employee.positions_json,[]))
    db.commit();return account_data(employee)


@app.post('/api/staff/{account_id}/recovery')
def staff_recovery(account_id:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'employees_manage',True)
    target=db.get(Account,account_id);require(target and target.organization_id==oid,'Аккаунт не найден',404)
    require(target.role=='employee' or a.role=='owner','Только владелец восстанавливает доступ управляющего',403)
    require(target.role!='owner','Недоступное действие',403)
    token=secrets.token_urlsafe(32)
    db.add(Invite(organization_id=oid,account_id=target.id,kind='recovery',token_hash=digest(token),expires_at=now()+timedelta(hours=24)))
    log(db,a,oid,'Создана ссылка восстановления',account_id=target.id);db.commit();return {'url':'/invite/'+token}


@app.get('/api/staff/{account_id}/history')
def staff_history(account_id:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a);target=db.get(Account,account_id)
    require(target and target.organization_id==oid and target.role=='employee','Сотрудник не найден',404)
    return history_data(db,target)


def history_data(db,a):
    rows=[]
    for exam in exams_for(db,a):
        rev=db.get(CourseRevision,exam.revision_id);data=parse(rev.payload)
        rows.append({'id':exam.id,'title':data['title'],'version':rev.version,'started_at':iso(exam.started_at),
                     'finished_at':iso(exam.finished_at),'result':parse(exam.result_json) if exam.finished_at else None})
    return rows


@app.get('/api/audit')
def audit_events(request:Request,a=Depends(actor),db=Depends(get_db)):
    owner(a)
    oid=request.headers.get('x-organization-id')
    q=select(Event).order_by(Event.id.desc()).limit(150)
    if oid and oid.isdigit(): q=select(Event).where(Event.organization_id==int(oid)).order_by(Event.id.desc()).limit(150)
    return [{'id':e.id,'at':iso(e.created_at),'actor':e.actor_name,'action':e.action,'details':parse(e.details),'organization_id':e.organization_id} for e in db.scalars(q).all()]


@app.get('/api/notices')
def notices(a=Depends(actor),db=Depends(get_db)):
    return [{'id':n.id,'title':n.title,'body':n.body,'url':n.url,'read':n.read,'at':iso(n.created_at)} for n in db.scalars(select(Notice).where(Notice.account_id==a.id).order_by(Notice.id.desc()).limit(100)).all()]


@app.post('/api/notices/read')
def notice_read(a=Depends(actor),db=Depends(get_db)):
    from sqlalchemy import update
    db.execute(update(Notice).where(Notice.account_id==a.id).values(read=True));db.commit();return {'ok':True}


@app.get('/api/export')
def export(request:Request,a=Depends(actor),db=Depends(get_db)):
    import csv,io
    oid=manager(request,db,a)
    out=io.StringIO();writer=csv.writer(out,delimiter=';')
    writer.writerow(['Сотрудник','Логин','Должности','Назначено','Пройдено тестов','Успешных курсов','Попыток','Средний балл','Среднее время (сек)','Просрочено'])
    for e in db.scalars(select(Account).where(Account.organization_id==oid,Account.role=='employee')).all():
        s=learner_stats(db,e)
        values=[e.name,e.login,', '.join(POSITIONS.get(p,p) for p in parse(e.positions_json,[])),s['assigned'],s['completed'],s['passed'],s['attempts'],s['average_score'],s['average_seconds'],s['overdue']]
        writer.writerow([("'"+str(v)) if str(v).lstrip().startswith(('=','+','-','@')) else v for v in values])
    log(db,a,oid,'Экспортирован отчёт сотрудников');db.commit()
    return Response(out.getvalue().encode('utf-8-sig'),media_type='text/csv',headers={'Content-Disposition':'attachment; filename="baros-report.csv"'})


# Register only the new API. Legacy vulnerable assessment routes are not mounted.
from .content import router as content_router
from .learning import router as learning_router
from .notifications import router as push_router
app.include_router(content_router);app.include_router(learning_router);app.include_router(push_router)


@app.get('/manifest.webmanifest')
def manifest():
    return JSONResponse({'id':'/','name':'BarOS — академия команды','short_name':'BarOS','lang':'ru','start_url':'/app','scope':'/',
                         'display':'standalone','background_color':'#f7f7fb','theme_color':'#5b47d6',
                         'icons':[{'src':f'/static/v2/icon-{s}.png','sizes':f'{s}x{s}','type':'image/png','purpose':'any maskable'} for s in [192,512]],
                         'shortcuts':[{'name':'Моё обучение','url':'/app/learning'},{'name':'Уведомления','url':'/app/notices'}]})


@app.get('/sw.js')
def sw():return FileResponse(STATIC/'sw.js',media_type='application/javascript',headers={'Cache-Control':'no-cache','Service-Worker-Allowed':'/'})
@app.get('/favicon.ico')
def favicon():return FileResponse(STATIC/'icon-192.png')
@app.get('/robots.txt')
def robots():return Response('User-agent: *\nDisallow: /\n',media_type='text/plain')
@app.get('/api/{path:path}')
def missing_api(path:str):raise HTTPException(404,'Метод не найден')
@app.get('/{path:path}')
def shell(path:str):return FileResponse(STATIC/'index.html')
