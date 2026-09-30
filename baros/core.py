from __future__ import annotations
import json, random, re
from pathlib import Path
from urllib.parse import quote
from fastapi import FastAPI, Request, Depends, Form, UploadFile, File, HTTPException, BackgroundTasks
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
from .ai_service import create_training_generation, process_training_generation, generation_progress, mark_stale_ai_generations, get_ai_status, get_ai_usage
from .config import MAX_UPLOAD_MB, FIRST_RUN_TOKEN, COOKIE_SECURE

BASE = Path(__file__).resolve().parent
app = FastAPI(title="BarOS", version="0.5")
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
templates = Jinja2Templates(directory=BASE / "templates")

POSITIONS = [
    ("bartender","Бармен"),("waiter","Официант"),("manager","Менеджер"),("host","Хостес"),
    ("cook","Кухня"),("barista","Бариста"),("administrator","Администратор"),("all","Все роли")
]
POSITION_LABELS = dict(POSITIONS)
QUESTION_TYPE_LABELS = {
    "knowledge":"Знание",
    "understanding":"Понимание",
    "sales":"Продажа",
    "scenario":"Ситуация",
}
QUIZ_SIZE = 30
QUESTION_BANK_TARGET = 100
QUIZ_TYPE_TARGETS = {"knowledge":12,"understanding":8,"sales":6,"scenario":4}

def _short(text: str, limit: int = 120) -> str:
    text = re.sub(r"\s+", " ", (text or "").strip())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"

def make_question(prompt: str, correct: str, distractors: list[str], qtype: str, explanation: str):
    """Build a question and randomize option order so correct answers are not positionally predictable."""
    options = [correct] + distractors[:3]
    random.shuffle(options)
    return prompt, options, options.index(correct), qtype, explanation

def balanced_quiz_questions(questions, limit: int = QUIZ_SIZE):
    """Sample a mixed exam. Prefer 12/8/6/4 for knowledge/understanding/sales/scenario, then fill gaps randomly."""
    questions = list(questions)
    if len(questions) <= limit:
        random.shuffle(questions)
        return questions
    by_type = {}
    for q in questions:
        by_type.setdefault(q.question_type or "knowledge", []).append(q)
    selected = []
    used = set()
    for qtype, wanted in QUIZ_TYPE_TARGETS.items():
        pool = by_type.get(qtype, [])[:]
        random.shuffle(pool)
        take = pool[:wanted]
        selected.extend(take)
        used.update(q.id for q in take)
    if len(selected) < limit:
        leftovers = [q for q in questions if q.id not in used]
        random.shuffle(leftovers)
        selected.extend(leftovers[:limit-len(selected)])
    random.shuffle(selected)
    return selected[:limit]

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
    return {"status": "ok", "service": "baros", "version": "0.5-staging"}

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
    if len(password) < 10 or not re.search(r"[A-Za-zА-Яа-яЁё]", password) or not re.search(r"\d", password):
        raise HTTPException(400, "Пароль должен быть не короче 10 символов и содержать букву и цифру")
    org=Organization(name=venue); db.add(org); db.flush()
    u=User(organization_id=org.id,email=email.lower().strip(),name=name,password_hash=hash_password(password),role="platform_owner")
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
    concept_s = _short(concept)
    guest_s = _short(guest_profile)
    service_s = _short(service_style)
    must_s = _short(must_know)
    rules_s = _short(special_rules) if special_rules else "действовать по утверждённому стандарту и при сомнении уточнить у менеджера"
    qs=[
        make_question(
            "Какое описание точнее всего передаёт концепцию заведения?",
            concept_s,
            [
                f"{venue_type}: основной акцент на скорости обслуживания, даже если формат общения с гостем меняется от смены к смене",
                f"Заведение для аудитории «{guest_s}», где концепция определяется главным образом ассортиментом, а не опытом гостя",
                f"Формат с сервисом «{service_s}», но без отдельной концепции и единых принципов подачи",
            ],
            "understanding",
            "Концепция берётся из стартового интервью заведения."
        ),
        make_question(
            "Новый сотрудник почти закончил стажировку. Что должно быть выполнено до допуска к самостоятельной смене?",
            must_s,
            [
                "Достаточно уверенно знать свой участок; остальные обязательные стандарты можно доучить в первых самостоятельных сменах",
                "Достаточно пройти вводный инструктаж и знать, к кому обратиться; детальное знание материалов не является условием допуска",
                "Можно выходить самостоятельно после одной смены с наставником, если серьёзных ошибок не было",
            ],
            "scenario",
            "Критерий допуска задаётся самим заведением в интервью."
        ),
        make_question(
            "Как сотруднику лучше выстраивать общение с гостем в этом заведении?",
            service_s,
            [
                f"Придерживаться нейтрального универсального сервиса, а стиль «{service_s}» использовать только с постоянными гостями",
                "Подстраивать стиль полностью под каждого гостя, даже если это расходится с принятыми стандартами заведения",
                "Сосредоточиться на скорости и точности заказа; стиль общения вторичен и остаётся на усмотрение сотрудника",
            ],
            "understanding",
            "Стиль сервиса указан управляющим в стартовом интервью."
        ),
        make_question(
            "На какого гостя в первую очередь рассчитан сервис и коммуникация заведения?",
            guest_s,
            [
                f"На максимально широкую аудиторию; профиль «{guest_s}» нужен только для маркетинга и не влияет на сервис",
                "В первую очередь на постоянных гостей; новым гостям используется стандартный нейтральный сценарий",
                "На того гостя, который делает более высокий чек; остальные особенности аудитории вторичны",
            ],
            "understanding",
            "Профиль гостя влияет на язык, темп и сценарии сервиса."
        ),
        make_question(
            "Гость просит сделать исключение, которое конфликтует с особым правилом заведения. Как действовать?",
            rules_s,
            [
                "Если просьба выглядит разумной, сделать исключение, а менеджеру сообщить уже после обслуживания",
                "Сначала попробовать найти компромисс самостоятельно; обращаться к менеджеру только если гость продолжает настаивать",
                "Следовать общему стандарту сервиса, даже если локальное правило заведения говорит иначе",
            ],
            "scenario",
            "Локальные правила заведения имеют приоритет; спорные исключения согласуются, а не придумываются сотрудником."
        ),
        make_question(
            "Сотрудник не уверен, как применить стандарт в нестандартной ситуации. Какой алгоритм наиболее корректный?",
            "Свериться с утверждённым правилом и, если трактовка остаётся неоднозначной, уточнить у менеджера до действия",
            [
                "Применить наиболее похожий стандарт самостоятельно и сообщить менеджеру после ситуации",
                "Выбрать решение, которое быстрее всего закроет запрос гостя, если оно не выглядит рискованным",
                "Попросить коллегу принять решение вместо себя, чтобы не задерживать гостя",
            ],
            "scenario",
            "BarOS проверяет не угадывание очевидного ответа, а понимание приоритета стандарта и эскалации."
        ),
        make_question(
            "Как использовать знание профиля гостя в работе?",
            "Как ориентир для подачи, рекомендаций и коммуникации, не превращая его в жёсткий шаблон для каждого человека",
            [
                "Как обязательный сценарий: каждому гостю из целевой аудитории нужно предлагать одинаковые позиции и формулировки",
                "Только для выбора тона приветствия; на рекомендации, продажи и работу с возражениями профиль гостя не влияет",
                "В основном для оценки платёжеспособности гостя и определения глубины дополнительной продажи",
            ],
            "sales",
            "Профиль аудитории помогает сделать сервис релевантнее, но не заменяет индивидуальную работу с гостем."
        ),
        make_question(
            "Что важнее при конфликте между личным стилем сотрудника и утверждённым стилем сервиса?",
            "Сохранить утверждённый стиль сервиса, адаптируя только подачу без изменения ключевых стандартов",
            [
                "Использовать личный стиль, если он помогает быстрее установить контакт с гостем",
                "Смешивать личный и утверждённый стиль поровну, чтобы общение не выглядело заученным",
                "Полностью копировать формулировки из стандарта слово в слово, независимо от контекста",
            ],
            "understanding",
            "Стандарт задаёт рамки поведения, но не требует роботизированного общения."
        ),
    ]
    for p,c,i,qt,ex in qs:
        db.add(Question(course_id=intro.id,prompt=p,choices_json=json.dumps(c,ensure_ascii=False),correct_index=i,question_type=qt,explanation=ex))
    db.commit(); return RedirectResponse("/app",303)

def _ai_generation_card(rec: AIGeneration):
    progress = generation_progress(rec)
    result = {}
    try:
        result = json.loads(rec.result or "{}")
        if not isinstance(result, dict):
            result = {}
    except Exception:
        result = {}
    courses = result.get("courses") or []
    glossary = result.get("glossary") or []
    lesson_count = sum(len(c.get("lessons") or []) for c in courses if isinstance(c, dict))
    question_count = sum(len(c.get("questions") or []) for c in courses if isinstance(c, dict))
    role = progress.get("target_role") or "all"
    return {
        "id": rec.id,
        "short_id": rec.id[:8],
        "status": rec.status,
        "model": rec.model,
        "created_at": rec.created_at,
        "progress": progress,
        "summary": str(result.get("summary") or ""),
        "courses": len(courses),
        "lessons": lesson_count,
        "questions": question_count,
        "glossary": len(glossary),
        "role": role,
        "role_label": POSITION_LABELS.get(role, role),
        "openable": rec.status in {"complete", "error", "imported", "limited", "disabled"},
    }


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
    latest_scores=[]
    total_latest_passed=0
    total_latest_attempts=0
    ready_count=0
    not_started_count=0
    for e in employees:
        relevant=[c for c in courses if c.published and c.required and c.target_role in ("all",e.position)]
        passed=0; scores=[]; attempts_total=0; last_activity=None; attention=[]; course_details=[]; weak_counter={}
        employee_attempts=db.scalars(select(Attempt).where(Attempt.employee_id==e.id).order_by(Attempt.created_at.desc())).all()
        attempts_total=len(employee_attempts)
        if employee_attempts:
            last_activity=employee_attempts[0].created_at
            for a in employee_attempts:
                try:
                    for w in json.loads(a.weak_topics_json or "[]"):
                        weak_counter[w]=weak_counter.get(w,0)+1
                except Exception:
                    pass
        for c in relevant:
            course_attempts=[a for a in employee_attempts if a.course_id==c.id]
            latest=course_attempts[0] if course_attempts else None
            best=max((a.score for a in course_attempts),default=None)
            if latest:
                scores.append(latest.score); latest_scores.append(latest.score); total_latest_attempts+=1
                if latest.passed:
                    passed+=1; total_latest_passed+=1
                else:
                    attention.append(c.title)
            else:
                attention.append(c.title)
            course_details.append({
                "title":c.title,
                "score":latest.score if latest else None,
                "passed":latest.passed if latest else False,
                "attempts":len(course_attempts),
                "best":best,
                "last":latest.created_at if latest else None,
            })
        ready=bool(relevant) and passed==len(relevant)
        if ready: ready_count+=1
        if relevant and all(d["attempts"]==0 for d in course_details): not_started_count+=1
        weak_sorted=sorted(weak_counter.items(),key=lambda kv:(-kv[1],kv[0]))
        readiness=round(passed/max(1,len(relevant))*100) if relevant else 0
        rows.append({
            "employee":e,
            "position_label":POSITION_LABELS.get(e.position,e.position),
            "ready":ready,
            "passed":passed,
            "total":len(relevant),
            "readiness":readiness,
            "score":round(sum(scores)/len(scores),1) if scores else None,
            "attempts":attempts_total,
            "last_activity":last_activity,
            "attention":attention[:3],
            "weak":QUESTION_TYPE_LABELS.get(weak_sorted[0][0],weak_sorted[0][0]) if weak_sorted else None,
            "course_details":course_details,
        })
    stats={
        "ready":ready_count,
        "in_progress":max(0,len(employees)-ready_count-not_started_count),
        "not_started":not_started_count,
        "avg_score":round(sum(latest_scores)/len(latest_scores),1) if latest_scores else None,
        "latest_pass_rate":round(total_latest_passed/max(1,total_latest_attempts)*100,1) if total_latest_attempts else None,
    }
    mark_stale_ai_generations(db, org.id)
    ai_status=get_ai_status(); ai_usage=get_ai_usage(db,org.id)
    generations=db.scalars(
        select(AIGeneration)
        .where(AIGeneration.organization_id==org.id,AIGeneration.feature=="training_draft")
        .order_by(AIGeneration.created_at.desc())
        .limit(12)
    ).all()
    ai_generations=[_ai_generation_card(x) for x in generations]
    return render(request,"dashboard.html",{
        "user":u,"org":org,"employees":rows,"courses":courses,"uploads":uploads,"glossary":glossary,
        "positions":POSITIONS,"stats":stats,"question_bank_target":QUESTION_BANK_TARGET,"quiz_size":QUIZ_SIZE,
        "ai_configured":ai_status["configured"],"ai_model":ai_status["model"],"ai_status":ai_status,"ai_usage":ai_usage,
        "ai_generations":ai_generations
    })

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
    lesson=Lesson(course_id=c.id,title=title.strip(),body=body.strip(),sort_order=n+1)
    db.add(lesson); db.commit(); db.refresh(lesson)
    if request.headers.get("x-baros-ajax")=="1":
        return JSONResponse({
            "ok":True,
            "lesson":{"id":lesson.id,"title":lesson.title,"body":lesson.body,"sort_order":lesson.sort_order}
        })
    return RedirectResponse(f"/courses/{c.id}#lessons-section",303)

@app.post("/courses/{course_id}/questions")
def add_question(course_id:int,request:Request,prompt:str=Form(...),choice1:str=Form(...),choice2:str=Form(...),choice3:str=Form(...),choice4:str=Form(...),correct_index:int=Form(...),question_type:str=Form("knowledge"),explanation:str=Form(""),db:Session=Depends(get_db)):
    u=current_user(request,db); c=db.get(Course,course_id)
    if not u or not c or c.organization_id!=u.organization_id: raise HTTPException(404)
    q=Question(
        course_id=c.id,prompt=prompt.strip(),
        choices_json=json.dumps([choice1.strip(),choice2.strip(),choice3.strip(),choice4.strip()],ensure_ascii=False),
        correct_index=max(0,min(3,correct_index)),question_type=question_type,explanation=explanation.strip()
    )
    db.add(q); db.commit(); db.refresh(q)
    if request.headers.get("x-baros-ajax")=="1":
        count=db.scalar(select(func.count(Question.id)).where(Question.course_id==c.id)) or 0
        return JSONResponse({
            "ok":True,
            "count":count,
            "question":{"id":q.id,"prompt":q.prompt,"question_type":q.question_type,"type_label":QUESTION_TYPE_LABELS.get(q.question_type,q.question_type)}
        })
    return RedirectResponse(f"/courses/{c.id}#questions-section",303)

@app.post("/ai/training-draft")
async def ai_training_draft(
    request: Request,
    background_tasks: BackgroundTasks,
    upload_ids: list[int]=Form(default=[]),
    target_role: str=Form("all"),
    db: Session=Depends(get_db)
):
    u=current_user(request,db)
    if not u: raise HTTPException(401)
    org=db.get(Organization,u.organization_id)
    docs=[]
    if upload_ids:
        docs=db.scalars(select(Upload).where(Upload.organization_id==org.id,Upload.id.in_(upload_ids))).all()
    else:
        docs=db.scalars(select(Upload).where(Upload.organization_id==org.id).order_by(Upload.created_at.desc()).limit(5)).all()

    context="ИНТЕРВЬЮ ЗАВЕДЕНИЯ:\n"+(org.interview_json or "{}")+f"\n\nЦЕЛЕВАЯ РОЛЬ: {target_role}\n\nМАТЕРИАЛЫ:\n"
    for d in docs:
        context+=f"\n--- {d.filename} / {d.category} / role={d.target_role} ---\n{d.extracted_text[:30000]}\n"

    rec,should_run=create_training_generation(
        db,org.id,u.id,context,
        metadata={
            "target_role":target_role,
            "upload_names":[d.filename for d in docs],
            "upload_ids":[d.id for d in docs],
        }
    )
    if should_run:
        background_tasks.add_task(process_training_generation,rec.id)

    card=_ai_generation_card(rec)
    payload={
        "ok":True,
        "generation":card,
        "status_url":f"/ai/training-draft/{rec.id}/status",
        "detail_url":f"/ai/training-draft/{rec.id}",
    }
    if request.headers.get("x-baros-ajax")=="1" or "application/json" in request.headers.get("accept",""):
        return JSONResponse(payload)
    return RedirectResponse("/app#ai",303)


@app.get("/ai/training-draft/{generation_id}/status")
def ai_training_draft_status(generation_id:str,request:Request,db:Session=Depends(get_db)):
    u=current_user(request,db)
    if not u: raise HTTPException(401)
    mark_stale_ai_generations(db,u.organization_id)
    rec=db.get(AIGeneration,generation_id)
    if not rec or rec.organization_id!=u.organization_id:
        raise HTTPException(404)
    card=_ai_generation_card(rec)
    return JSONResponse({
        "ok":True,
        "generation":card,
        "detail_url":f"/ai/training-draft/{rec.id}",
    })


@app.get("/ai/training-draft/{generation_id}",response_class=HTMLResponse)
def ai_training_draft_detail(generation_id:str,request:Request,db:Session=Depends(get_db)):
    u=current_user(request,db)
    if not u: return RedirectResponse("/",302)
    mark_stale_ai_generations(db,u.organization_id)
    rec=db.get(AIGeneration,generation_id)
    if not rec or rec.organization_id!=u.organization_id:
        raise HTTPException(404)
    if rec.status=="pending":
        return RedirectResponse("/app#ai",303)
    try:
        result=json.loads(rec.result or "{}")
        if not isinstance(result,dict): result={}
    except Exception:
        result={}
    return render(request,"ai_draft.html",{
        "user":u,
        "generation_id":rec.id,
        "generation":rec,
        "result":result,
        "ai_status":get_ai_status()
    })


@app.post("/ai/training-draft/{generation_id}/retry")
async def retry_ai_training_draft(
    generation_id:str,
    request:Request,
    background_tasks:BackgroundTasks,
    db:Session=Depends(get_db)
):
    u=current_user(request,db)
    if not u: raise HTTPException(401)
    old=db.get(AIGeneration,generation_id)
    if not old or old.organization_id!=u.organization_id or old.status!="error":
        raise HTTPException(404)
    old_progress=generation_progress(old)
    rec,should_run=create_training_generation(
        db,u.organization_id,u.id,old.prompt or "",
        metadata={
            "target_role":old_progress.get("target_role","all"),
            "upload_names":old_progress.get("upload_names",[]),
            "retry_of":old.id,
        }
    )
    if should_run:
        background_tasks.add_task(process_training_generation,rec.id)
    if request.headers.get("x-baros-ajax")=="1" or "application/json" in request.headers.get("accept",""):
        return JSONResponse({
            "ok":True,
            "generation":_ai_generation_card(rec),
            "status_url":f"/ai/training-draft/{rec.id}/status",
            "detail_url":f"/ai/training-draft/{rec.id}",
        })
    return RedirectResponse("/app#ai",303)


@app.post("/ai/training-draft/{generation_id}/import")
async def import_ai_training_draft(generation_id:str,request:Request,db:Session=Depends(get_db)):
    u=current_user(request,db)
    if not u: raise HTTPException(401)
    rec=db.get(AIGeneration,generation_id)
    if not rec or rec.organization_id!=u.organization_id or rec.status!="complete":
        raise HTTPException(404)
    try:
        result=json.loads(rec.result or "{}")
    except Exception:
        raise HTTPException(400,"Некорректный AI-черновик")
    form=await request.form()
    selected=set()
    for raw in form.getlist("course_indexes"):
        try: selected.add(int(raw))
        except Exception: pass
    if not selected:
        raise HTTPException(400,"Выберите хотя бы один курс")
    imported_courses=[]
    courses=result.get("courses") or []
    for idx,course_data in enumerate(courses):
        if idx not in selected or not isinstance(course_data,dict): continue
        course=Course(
            organization_id=u.organization_id,
            title=str(course_data.get("title") or "AI-курс").strip()[:200],
            description=str(course_data.get("description") or "").strip(),
            target_role=str(course_data.get("target_role") or "all"),
            passing_score=80,required=True,published=False
        )
        db.add(course); db.flush()
        for order,lesson_data in enumerate(course_data.get("lessons") or [],start=1):
            if not isinstance(lesson_data,dict): continue
            db.add(Lesson(
                course_id=course.id,
                title=str(lesson_data.get("title") or f"Урок {order}").strip()[:200],
                body=str(lesson_data.get("body") or "").strip(),
                sort_order=order
            ))
        for qd in course_data.get("questions") or []:
            if not isinstance(qd,dict): continue
            choices=qd.get("choices") or []
            if len(choices)!=4: continue
            try: correct=max(0,min(3,int(qd.get("correct_index",0))))
            except Exception: correct=0
            db.add(Question(
                course_id=course.id,
                prompt=str(qd.get("prompt") or "").strip(),
                choices_json=json.dumps([str(x) for x in choices],ensure_ascii=False),
                correct_index=correct,
                question_type=str(qd.get("type") or "knowledge"),
                explanation=str(qd.get("explanation") or "").strip()
            ))
        imported_courses.append(course.id)

    if form.get("include_glossary")=="1":
        existing={x.term.strip().casefold() for x in db.scalars(select(GlossaryTerm).where(GlossaryTerm.organization_id==u.organization_id)).all()}
        for gd in result.get("glossary") or []:
            if not isinstance(gd,dict): continue
            term=str(gd.get("term") or "").strip()
            definition=str(gd.get("definition") or "").strip()
            if not term or not definition or term.casefold() in existing: continue
            db.add(GlossaryTerm(
                organization_id=u.organization_id,
                term=term[:160],definition=definition,target_role=str(gd.get("target_role") or "all")
            ))
            existing.add(term.casefold())

    rec.status="imported"
    db.commit()
    first_course=imported_courses[0] if imported_courses else None
    target=f"/courses/{first_course}" if first_course else "/app#courses"
    return RedirectResponse(target,303)


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
    qs=balanced_quiz_questions(c.questions, QUIZ_SIZE)
    payload=[]
    for q in qs:
        raw=json.loads(q.choices_json)
        shuffled=list(enumerate(raw)); random.shuffle(shuffled)
        payload.append({
            "id":q.id,
            "prompt":q.prompt,
            "choices":[{"value":idx,"text":text} for idx,text in shuffled],
            "type":q.question_type,
            "type_label":QUESTION_TYPE_LABELS.get(q.question_type,q.question_type),
        })
    return render(request,"quiz.html",{
        "employee":e,"course":c,"questions":payload,"token":token,
        "quiz_size":QUIZ_SIZE,"bank_size":len(c.questions),"bank_target":QUESTION_BANK_TARGET
    })

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

