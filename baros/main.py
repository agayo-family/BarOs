from __future__ import annotations
import json, random, re
from pathlib import Path
from urllib.parse import quote
from fastapi import FastAPI, Request, Depends, Form, UploadFile, File, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from .db import Base, engine, get_db, SessionLocal
from .models import Organization, User, Employee, Upload, Course, Lesson, GlossaryTerm, Question, Attempt, AIGeneration
from .security import hash_password, verify_password, make_session, read_session, invite_token
from .storage import storage
from .extractors import extract_text
from .ai_service import generate_training_draft
from .config import MAX_UPLOAD_MB, FIRST_RUN_TOKEN, COOKIE_SECURE

BASE = Path(__file__).resolve().parent
app = FastAPI(title="BarOS", version="0.3")
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
templates = Jinja2Templates(directory=BASE / "templates")

POSITIONS = [
    ("bartender","Бармен"),("waiter","Официант"),("manager","Менеджер"),("host","Хостес"),
    ("cook","Кухня"),("barista","Бариста"),("administrator","Администратор"),("all","Все роли")
]

@app.on_event("startup")
def startup():
    Base.metadata.create_all(bind=engine)

def current_user(request: Request, db: Session):
    token = request.cookies.get("baros_session")
    data = read_session(token) if token else None
    if not data: return None
    return db.get(User, data.get("uid"))

def require_user(request: Request, db: Session = Depends(get_db)):
    u = current_user(request, db)
    if not u: raise HTTPException(401)
    return u

def render(request, name, ctx=None, status=200):
    return templates.TemplateResponse(request, name, ctx or {}, status_code=status)

@app.get("/health")
def health():
    return {"status": "ok", "service": "baros", "version": "0.3-staging"}

@app.get("/", response_class=HTMLResponse)
def home(request: Request, db: Session = Depends(get_db)):
    if db.scalar(select(func.count(User.id))) == 0:
        return RedirectResponse("/first-run", 302)
    if current_user(request, db): return RedirectResponse("/app", 302)
    return render(request, "login.html", {"error": request.query_params.get("error")})

@app.get("/first-run", response_class=HTMLResponse)
def first_run(request: Request, token: str = "", db: Session = Depends(get_db)):
    if db.scalar(select(func.count(User.id))) > 0: return RedirectResponse("/", 302)
    if FIRST_RUN_TOKEN and token != FIRST_RUN_TOKEN:
        raise HTTPException(403, "Неверный токен первоначальной настройки")
    return render(request, "first_run.html", {"setup_token": token})

@app.post("/first-run")
def first_run_post(name: str=Form(...), email: str=Form(...), password: str=Form(...), venue: str=Form(...), setup_token: str=Form(""), db: Session=Depends(get_db)):
    if db.scalar(select(func.count(User.id))) > 0: return RedirectResponse("/",302)
    if FIRST_RUN_TOKEN and setup_token != FIRST_RUN_TOKEN:
        raise HTTPException(403, "Неверный токен первоначальной настройки")
    org=Organization(name=venue); db.add(org); db.flush()
    u=User(organization_id=org.id,email=email.lower().strip(),name=name,password_hash=hash_password(password),role="owner")
    db.add(u); db.commit()
    r=RedirectResponse("/onboarding",303); r.set_cookie("baros_session",make_session(u.id),httponly=True,samesite="lax",secure=COOKIE_SECURE,max_age=60*60*24*14)
    return r

@app.post("/login")
def login(email: str=Form(...), password: str=Form(...), db: Session=Depends(get_db)):
    u=db.scalar(select(User).where(User.email==email.lower().strip()))
    if not u or not verify_password(password,u.password_hash): return RedirectResponse("/?error=1",303)
    r=RedirectResponse("/app",303); r.set_cookie("baros_session",make_session(u.id),httponly=True,samesite="lax",secure=COOKIE_SECURE,max_age=60*60*24*14); return r

@app.post("/logout")
def logout():
    r=RedirectResponse("/",303); r.delete_cookie("baros_session"); return r

@app.get("/onboarding", response_class=HTMLResponse)
def onboarding(request: Request, db: Session=Depends(get_db)):
    u=current_user(request,db)
    if not u: return RedirectResponse("/",302)
    org=db.get(Organization,u.organization_id)
    data=json.loads(org.interview_json or "{}")
    return render(request,"onboarding.html",{"user":u,"org":org,"data":data,"positions":POSITIONS})

@app.post("/onboarding")
def onboarding_post(request: Request, venue_type: str=Form(...), concept: str=Form(...), guest_profile: str=Form(...), service_style: str=Form(...), average_check: str=Form(""), team_size: str=Form(""), roles_present: list[str]=Form(default=[]), must_know: str=Form(...), common_mistakes: str=Form(""), tone: str=Form(""), special_rules: str=Form(""), db: Session=Depends(get_db)):
    u=current_user(request,db)
    if not u: return RedirectResponse("/",302)
    org=db.get(Organization,u.organization_id)
    data={"venue_type":venue_type,"concept":concept,"guest_profile":guest_profile,"service_style":service_style,"average_check":average_check,"team_size":team_size,"roles_present":roles_present,"must_know":must_know,"common_mistakes":common_mistakes,"tone":tone,"special_rules":special_rules}
    org.interview_json=json.dumps(data,ensure_ascii=False)
    # create/update introduction course draft
    intro=db.scalar(select(Course).where(Course.organization_id==org.id,Course.title=="О заведении"))
    if not intro:
        intro=Course(organization_id=org.id,title="О заведении",description="Вводный модуль на основе интервью",target_role="all",passing_score=80,published=True)
        db.add(intro); db.flush()
    for old in list(intro.lessons): db.delete(old)
    for q in list(intro.questions): db.delete(q)
    body=f"Концепция: {concept}\n\nНаш гость: {guest_profile}\n\nСтиль сервиса: {service_style}\n\nДо первой самостоятельной смены сотрудник обязан знать: {must_know}\n\nОсобые правила: {special_rules or 'не указаны'}"
    db.add(Lesson(course_id=intro.id,title="Как устроено наше заведение",body=body,sort_order=1))
    qs=[
        ("Как лучше всего описать концепцию нашего заведения?",[concept,"Только быстрый сервис","Только доставка","Концепция не определена"],0,"knowledge"),
        ("Что сотрудник обязан знать до самостоятельной смены?",[must_know,"Только расписание","Только имена коллег","Ничего"],0,"knowledge"),
        ("Какой стиль сервиса мы поддерживаем?",[service_style,"Случайный, без стандарта","Только самообслуживание","Неважно"],0,"knowledge"),
        ("Кто наш основной гость?",[guest_profile,"Только сотрудники заведения","Любой человек без понимания аудитории","Только поставщики"],0,"knowledge"),
        ("Что делать, если ситуация противоречит особым правилам заведения?",[special_rules or "Следовать утверждённым правилам и уточнить у менеджера","Импровизировать без согласования","Игнорировать правило","Спорить с гостем"],0,"scenario"),
    ]
    for p,c,i,qt in qs: db.add(Question(course_id=intro.id,prompt=p,choices_json=json.dumps(c,ensure_ascii=False),correct_index=i,question_type=qt,explanation="Ответ сформирован из интервью заведения."))
    db.commit(); return RedirectResponse("/app",303)

@app.get("/app", response_class=HTMLResponse)
def dashboard(request: Request, db: Session=Depends(get_db)):
    u=current_user(request,db)
    if not u: return RedirectResponse("/",302)
    org=db.get(Organization,u.organization_id)
    employees=db.scalars(select(Employee).where(Employee.organization_id==org.id,Employee.active==True).order_by(Employee.created_at.desc())).all()
    courses=db.scalars(select(Course).where(Course.organization_id==org.id).order_by(Course.created_at.desc())).all()
    uploads=db.scalars(select(Upload).where(Upload.organization_id==org.id).order_by(Upload.created_at.desc())).all()
    glossary=db.scalars(select(GlossaryTerm).where(GlossaryTerm.organization_id==org.id).order_by(GlossaryTerm.term)).all()
    rows=[]
    for e in employees:
        relevant=[c for c in courses if c.published and c.required and c.target_role in ("all",e.position)]
        passed=0; scores=[]
        for c in relevant:
            a=db.scalar(select(Attempt).where(Attempt.employee_id==e.id,Attempt.course_id==c.id).order_by(Attempt.created_at.desc()))
            if a:
                scores.append(a.score)
                if a.passed: passed+=1
        ready=bool(relevant) and passed==len(relevant)
        rows.append({"employee":e,"ready":ready,"passed":passed,"total":len(relevant),"score":round(sum(scores)/len(scores),1) if scores else None})
    return render(request,"dashboard.html",{"user":u,"org":org,"employees":rows,"courses":courses,"uploads":uploads,"glossary":glossary,"positions":POSITIONS})

@app.post("/employees")
def add_employee(request: Request,name: str=Form(...),position: str=Form(...),db: Session=Depends(get_db)):
    u=current_user(request,db)
    if not u: raise HTTPException(401)
    e=Employee(organization_id=u.organization_id,name=name,position=position,invite_token=invite_token()); db.add(e); db.commit()
    return RedirectResponse("/app#employees",303)

@app.post("/glossary")
def add_glossary(request: Request,term: str=Form(...),definition: str=Form(...),target_role: str=Form("all"),db: Session=Depends(get_db)):
    u=current_user(request,db)
    if not u: raise HTTPException(401)
    db.add(GlossaryTerm(organization_id=u.organization_id,term=term.strip(),definition=definition.strip(),target_role=target_role)); db.commit()
    return RedirectResponse("/app#glossary",303)

@app.post("/uploads")
async def upload_document(request: Request, file: UploadFile=File(...), category: str=Form("other"), target_role: str=Form("all"), db: Session=Depends(get_db)):
    u=current_user(request,db)
    if not u: raise HTTPException(401)
    data=await file.read()
    if len(data)>MAX_UPLOAD_MB*1024*1024: raise HTTPException(413,"Файл слишком большой")
    path=await storage.save(file.filename or "upload",data)
    text=extract_text(file.filename or "upload",data)
    rec=Upload(organization_id=u.organization_id,filename=file.filename or "upload",stored_path=path,mime_type=file.content_type or "",category=category,target_role=target_role,extracted_text=text)
    db.add(rec); db.commit()
    return RedirectResponse("/app#files",303)

@app.post("/courses")
def add_course(request: Request,title: str=Form(...),description: str=Form(""),target_role: str=Form("all"),passing_score: int=Form(80),published: str|None=Form(None),db: Session=Depends(get_db)):
    u=current_user(request,db)
    if not u: raise HTTPException(401)
    c=Course(organization_id=u.organization_id,title=title,description=description,target_role=target_role,passing_score=max(1,min(100,passing_score)),published=bool(published)); db.add(c); db.commit()
    return RedirectResponse(f"/courses/{c.id}",303)

@app.get("/courses/{course_id}",response_class=HTMLResponse)
def course_editor(course_id:int,request:Request,db:Session=Depends(get_db)):
    u=current_user(request,db)
    if not u:return RedirectResponse("/",302)
    c=db.get(Course,course_id)
    if not c or c.organization_id!=u.organization_id: raise HTTPException(404)
    return render(request,"course_editor.html",{"user":u,"course":c,"positions":POSITIONS})

@app.post("/courses/{course_id}/lessons")
def add_lesson(course_id:int,request:Request,title:str=Form(...),body:str=Form(...),db:Session=Depends(get_db)):
    u=current_user(request,db); c=db.get(Course,course_id)
    if not u or not c or c.organization_id!=u.organization_id: raise HTTPException(404)
    n=db.scalar(select(func.count(Lesson.id)).where(Lesson.course_id==c.id)) or 0
    db.add(Lesson(course_id=c.id,title=title,body=body,sort_order=n+1)); db.commit(); return RedirectResponse(f"/courses/{c.id}",303)

@app.post("/courses/{course_id}/questions")
def add_question(course_id:int,request:Request,prompt:str=Form(...),choice1:str=Form(...),choice2:str=Form(...),choice3:str=Form(...),choice4:str=Form(...),correct_index:int=Form(...),question_type:str=Form("knowledge"),explanation:str=Form(""),db:Session=Depends(get_db)):
    u=current_user(request,db); c=db.get(Course,course_id)
    if not u or not c or c.organization_id!=u.organization_id: raise HTTPException(404)
    db.add(Question(course_id=c.id,prompt=prompt,choices_json=json.dumps([choice1,choice2,choice3,choice4],ensure_ascii=False),correct_index=max(0,min(3,correct_index)),question_type=question_type,explanation=explanation)); db.commit(); return RedirectResponse(f"/courses/{c.id}",303)

@app.post("/ai/training-draft")
async def ai_training_draft(request: Request, upload_ids: list[int]=Form(default=[]), target_role: str=Form("all"), db: Session=Depends(get_db)):
    u=current_user(request,db)
    if not u: raise HTTPException(401)
    org=db.get(Organization,u.organization_id)
    docs=[]
    if upload_ids:
        docs=db.scalars(select(Upload).where(Upload.organization_id==org.id,Upload.id.in_(upload_ids))).all()
    else:
        docs=db.scalars(select(Upload).where(Upload.organization_id==org.id).order_by(Upload.created_at.desc()).limit(5)).all()
    context="ИНТЕРВЬЮ ЗАВЕДЕНИЯ:\n"+(org.interview_json or "{}")+f"\n\nЦЕЛЕВАЯ РОЛЬ: {target_role}\n\nМАТЕРИАЛЫ:\n"
    for d in docs: context+=f"\n--- {d.filename} / {d.category} / role={d.target_role} ---\n{d.extracted_text[:30000]}\n"
    gid,result=await generate_training_draft(db,org.id,u.id,context)
    return render(request,"ai_draft.html",{"user":u,"generation_id":gid,"result":result})

@app.get("/employee/{token}",response_class=HTMLResponse)
def employee_home(token:str,request:Request,db:Session=Depends(get_db)):
    e=db.scalar(select(Employee).where(Employee.invite_token==token,Employee.active==True))
    if not e: raise HTTPException(404)
    courses=db.scalars(select(Course).where(Course.organization_id==e.organization_id,Course.published==True)).all()
    relevant=[c for c in courses if c.target_role in ("all",e.position)]
    cards=[]
    for c in relevant:
        a=db.scalar(select(Attempt).where(Attempt.employee_id==e.id,Attempt.course_id==c.id).order_by(Attempt.created_at.desc()))
        cards.append({"course":c,"attempt":a})
    return render(request,"employee_home.html",{"employee":e,"cards":cards,"token":token})

def decorate_glossary(text:str,terms):
    # Escape minimal HTML first, then inject safe tooltip spans.
    import html
    safe=html.escape(text).replace("\n","<br>")
    for t in sorted(terms,key=lambda x:len(x.term),reverse=True):
        pattern=re.compile(rf"(?<![\wА-Яа-яЁё])({re.escape(html.escape(t.term))})(?![\wА-Яа-яЁё])",re.I)
        definition=html.escape(t.definition,quote=True)
        safe=pattern.sub(lambda m:f'<button type="button" class="term" data-definition="{definition}">{m.group(1)}</button>',safe)
    return safe

@app.get("/employee/{token}/course/{course_id}",response_class=HTMLResponse)
def employee_course(token:str,course_id:int,request:Request,db:Session=Depends(get_db)):
    e=db.scalar(select(Employee).where(Employee.invite_token==token,Employee.active==True)); c=db.get(Course,course_id)
    if not e or not c or c.organization_id!=e.organization_id or not c.published or c.target_role not in ("all",e.position): raise HTTPException(404)
    terms=db.scalars(select(GlossaryTerm).where(GlossaryTerm.organization_id==e.organization_id)).all()
    terms=[t for t in terms if t.target_role in ("all",e.position)]
    lessons=[{"title":l.title,"body":decorate_glossary(l.body,terms)} for l in c.lessons]
    return render(request,"employee_course.html",{"employee":e,"course":c,"lessons":lessons,"token":token})

@app.get("/employee/{token}/course/{course_id}/quiz",response_class=HTMLResponse)
def quiz(token:str,course_id:int,request:Request,db:Session=Depends(get_db)):
    e=db.scalar(select(Employee).where(Employee.invite_token==token,Employee.active==True)); c=db.get(Course,course_id)
    if not e or not c or c.organization_id!=e.organization_id: raise HTTPException(404)
    qs=list(c.questions); random.shuffle(qs); qs=qs[:min(10,len(qs))]
    payload=[{"id":q.id,"prompt":q.prompt,"choices":json.loads(q.choices_json),"type":q.question_type} for q in qs]
    return render(request,"quiz.html",{"employee":e,"course":c,"questions":payload,"token":token})

@app.post("/employee/{token}/course/{course_id}/quiz")
async def quiz_submit(token:str,course_id:int,request:Request,db:Session=Depends(get_db)):
    e=db.scalar(select(Employee).where(Employee.invite_token==token,Employee.active==True)); c=db.get(Course,course_id)
    if not e or not c or c.organization_id!=e.organization_id: raise HTTPException(404)
    form=await request.form(); qids=[int(x) for x in form.getlist("question_id")]
    answers=[]; correct=0; weak=[]
    for qid in qids:
        q=db.get(Question,qid)
        if not q or q.course_id!=c.id: continue
        try: ans=int(form.get(f"q_{qid}",-1))
        except: ans=-1
        ok=ans==q.correct_index
        correct+=1 if ok else 0
        if not ok: weak.append(q.question_type)
        answers.append({"question_id":qid,"answer":ans,"correct":ok})
    score=round(correct/max(1,len(qids))*100,1); passed=score>=c.passing_score
    a=Attempt(employee_id=e.id,course_id=c.id,score=score,passed=passed,weak_topics_json=json.dumps(sorted(set(weak)),ensure_ascii=False),answers_json=json.dumps(answers,ensure_ascii=False)); db.add(a); db.commit()
    return render(request,"quiz_result.html",{"employee":e,"course":c,"attempt":a,"weak":sorted(set(weak)),"token":token})

@app.get("/health")
def health(): return {"ok":True,"version":"0.3"}
