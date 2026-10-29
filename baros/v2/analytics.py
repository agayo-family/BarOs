"""Tenant-scoped, explainable manager analytics. All requests are read-only."""
import csv,io,statistics
from collections import defaultdict
from datetime import date,datetime,timedelta,timezone
from zoneinfo import ZoneInfo
from fastapi import APIRouter,Depends,Request,Query
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import defer
from ..db import get_db
from ..models import Course
from .auth import actor,manager
from .models import Account,CourseSettings,CourseRevision,Exam,WrittenAttempt,ImportedAssessment
from .domain import parse,iso,now,require,POSITIONS,learner_stats_many,applies
from .readiness import content_key
from .packages import score_result

router=APIRouter();MSK=ZoneInfo('Europe/Moscow')
def average(values):return round(statistics.mean(values),1) if values else None
def median(values):return round(statistics.median(values),1) if values else None
def pct(n,d):return round(100*n/d,1) if d else None
def local_day(value):return value.replace(tzinfo=timezone.utc).astimezone(MSK).date().isoformat()
def criteria_percent(task,grades):
    values=[]
    for r in task.get('rubric',[]):
        points=float(r['points']);value=float(grades.get(r['id'],0))
        values.append((r,value,points))
    return values

def build(db,oid,days=30,start=None,end=None,position='',account_id=None,course_id=None,assessment_id=None,history=False,include_inactive=False):
    today=now().replace(tzinfo=timezone.utc).astimezone(MSK).date()
    require(days in {0,7,30,90,365},'Неизвестный период',422)
    end=end or today;start=start or (end-timedelta(days=days-1) if days else None)
    require(not start or start<=end,'Начало периода позже окончания',422)
    require(not start or (end-start).days<=3660,'Выберите период до десяти лет',422)
    require(not position or position in POSITIONS,'Неизвестная должность',422)
    low=datetime.combine(start,datetime.min.time(),MSK).astimezone(timezone.utc).replace(tzinfo=None) if start else None
    high=datetime.combine(end+timedelta(days=1),datetime.min.time(),MSK).astimezone(timezone.utc).replace(tzinfo=None)
    all_staff=db.scalars(select(Account).where(Account.organization_id==oid,Account.role=='employee').order_by(Account.name,Account.id)).all()
    all_courses=db.scalars(select(Course).where(Course.organization_id==oid).order_by(Course.title,Course.id)).all()
    all_tests=db.scalars(select(ImportedAssessment).where(ImportedAssessment.organization_id==oid).order_by(ImportedAssessment.title,ImportedAssessment.id)).all()
    require(not account_id or any(a.id==account_id for a in all_staff),'Сотрудник не найден',404)
    require(not course_id or any(c.id==course_id for c in all_courses),'Курс не найден',404)
    require(not assessment_id or any(t.id==assessment_id for t in all_tests),'Тест не найден',404)
    require(not(course_id and assessment_id),'Выберите курс или отдельный тест',422)
    staff=[a for a in all_staff if (include_inactive or a.active) and (not account_id or a.id==account_id) and (not position or position in parse(a.positions_json,[]))]
    people={a.id:a for a in staff};aids=list(people)
    configs={s.course_id:s for s in db.scalars(select(CourseSettings).where(CourseSettings.course_id.in_([c.id for c in all_courses]))).all()}
    revisions={r.id:r for r in db.scalars(select(CourseRevision).where(CourseRevision.course_id.in_([c.id for c in all_courses]))).all()}
    courses={c.id:c for c in all_courses};tests={t.id:t for t in all_tests}
    current={rid for rid,r in revisions.items() if r.course_id in configs and configs[r.course_id].version==r.version and not configs[r.course_id].archived and courses[r.course_id].published}
    data={rid:parse(r.payload) for rid,r in revisions.items()}
    selected_revisions={rid for rid,r in revisions.items() if (history or rid in current) and (not course_id or r.course_id==course_id) and not assessment_id}
    stats=learner_stats_many(db,staff)
    rows={}
    linked={data[rid].get('program',{}).get('written_assessment_id') for rid in selected_revisions if data[rid].get('program')} - {None}
    for a in staff:
        s=stats[a.id];cs=[c for c in s['courses'] if not assessment_id and (not course_id or c['id']==course_id)]
        linked.update(c['written_assessment_id'] for c in cs if c['written_assessment_id'])
        local_linked={c['written_assessment_id'] for c in cs if c['written_assessment_id']}
        ts=[t for t in s['assessments'] if (not assessment_id or t['id']==assessment_id) and (not course_id or t['id'] in local_linked)]
        standalone=[t for t in ts if t['id'] not in local_linked]
        total=len(cs)+len(standalone);complete=sum(c['learning_complete'] for c in cs)+sum(t['passed'] for t in standalone)
        rows[a.id]={'id':a.id,'name':a.name,'active':a.active,'positions':parse(a.positions_json,[]),'last_seen_at':iso(a.last_seen_at),'assigned':total,'complete':complete,'completion_percent':pct(complete,total),'overdue':sum(c['overdue'] for c in cs),'pending_review':sum(t['status']=='submitted' for t in ts),'courses':cs,'assessments':ts,'scores':[],'durations':[],'attempts':0,'passed_attempts':0,'written_graded':0,'written_scores':[]}
    per_course={}
    for rid in selected_revisions:
        r=revisions[rid];p=data[rid]
        assigned=[a for a in staff if applies(a,p)]
        current_cards=[c for row in rows.values() for c in row['courses'] if c['revision_id']==rid]
        per_course[rid]={'id':r.course_id,'revision_id':rid,'version':r.version,'title':p['title'],'current':rid in current,'assigned':len(assigned) if rid in current else None,'complete':sum(c['learning_complete'] for c in current_cards) if rid in current else None,'overdue':sum(c['overdue'] for c in current_cards),'started':set(),'passed_people':set(),'attempts':0,'scores':[],'durations':[],'passing_score':p['passing_score']}
    per_test={t.id:{'id':t.id,'title':t.title,'published':t.published,'archived':t.archived,'assigned':sum(any(x['id']==t.id for x in r['assessments']) for r in rows.values()),'graded':0,'submitted':0,'scores':[],'durations':[]} for t in all_tests if (history or t.published and not t.archived) and (not assessment_id or t.id==assessment_id) and (not course_id or t.id in linked)}
    daily=defaultdict(lambda:{'auto':0,'written':0,'passed':0,'scores':[]})
    attempts=[];question_last={};progressions=defaultdict(list);timed_out=0
    q=select(Exam).options(defer(Exam.questions_json),defer(Exam.answers_json)).where(Exam.account_id.in_(aids),Exam.revision_id.in_(selected_revisions),Exam.finished_at.is_not(None),Exam.finished_at<high)
    if low:q=q.where(Exam.finished_at>=low)
    for x in db.scalars(q.order_by(Exam.finished_at,Exam.started_at,Exam.id)).yield_per(200):
        p=data[x.revision_id]
        if not history and not applies(people[x.account_id],p):continue
        r=parse(x.result_json);score=r.get('score')
        if not isinstance(score,(int,float)):continue
        seconds=r.get('duration_seconds');passed=bool(r.get('passed'));row=rows[x.account_id];c=per_course[x.revision_id]
        row['attempts']+=1;row['passed_attempts']+=passed;row['scores'].append(score);c['attempts']+=1;c['scores'].append(score);c['started'].add(x.account_id)
        if passed:c['passed_people'].add(x.account_id)
        if isinstance(seconds,(int,float)) and seconds>=0:row['durations'].append(seconds);c['durations'].append(seconds)
        day=daily[local_day(x.finished_at)];day['auto']+=1;day['passed']+=passed;day['scores'].append(score)
        progressions[(x.account_id,x.revision_id)].append(score)
        question_last[(x.account_id,x.revision_id)]=(r.get('review',[]),row['name'])
        attempts.append({'id':x.id,'kind':'auto','account_id':x.account_id,'name':row['name'],'title':p['title'],'course_id':revisions[x.revision_id].course_id,'version':revisions[x.revision_id].version,'current':x.revision_id in current,'at':iso(x.finished_at),'score':score,'passed':passed,'seconds':seconds})
        timed_out+=bool(r.get('expired'))
    question_rows={}
    for (uid,rid),(review,name) in question_last.items():
        for item in review:
            prompt=item.get('prompt','')
            if not prompt:continue
            key=(rid,' '.join(prompt.casefold().split()))
            row=question_rows.setdefault(key,{'course_id':revisions[rid].course_id,'version':revisions[rid].version,'course_title':data[rid]['title'],'prompt':prompt,'type':item.get('type','knowledge'),'checked':0,'mistakes':0,'employees':[],'distractors':{},'explanation':item.get('explanation','')})
            row['checked']+=1
            if not item.get('correct'):
                row['mistakes']+=1;row['employees'].append({'id':uid,'name':name});sel=item.get('selected');choices=item.get('choices',[])
                if isinstance(sel,int) and 0<=sel<len(choices):row['distractors'][choices[sel]]=row['distractors'].get(choices[sel],0)+1
    rubric_rows={};queue=[];written_keys={t.id:content_key(parse(t.payload)) for t in all_tests};test_versions={}
    for tid,t in per_test.items():test_versions[(tid,written_keys[tid])]={**t,'revision':written_keys[tid][:12],'current':True,'scores':[],'durations':[]}
    q=select(WrittenAttempt).options(defer(WrittenAttempt.answers)).where(WrittenAttempt.organization_id==oid,WrittenAttempt.account_id.in_(aids),WrittenAttempt.assessment_id.in_(per_test)).order_by(WrittenAttempt.started_at,WrittenAttempt.id)
    for x in db.scalars(q).yield_per(20):
        p=parse(x.snapshot);is_current=content_key(p)==written_keys[x.assessment_id]
        if not history and not applies(people[x.account_id],p):continue
        if not history and (not is_current or not tests[x.assessment_id].published or tests[x.assessment_id].archived):continue
        status=x.status
        expired=status=='in_progress' and x.expires_at<=now()
        if expired:status='submitted' if any(t['kind']=='written' for t in p['tasks']) else 'graded'
        graded_at=x.graded_at or (x.expires_at if expired and status=='graded' else None)
        if status=='submitted':
            at=x.submitted_at or x.expires_at
            queue.append({'id':x.id,'assessment_id':x.assessment_id,'account_id':x.account_id,'name':people[x.account_id].name,'title':p['title'],'submitted_at':iso(at),'waiting_hours':round(max(0,(now()-at).total_seconds()/3600),1),'current':is_current,'url':'/app/assessment-attempts/'+x.id});per_test[x.assessment_id]['submitted']+=1
        if status!='graded' or not graded_at or graded_at>=high or low and graded_at<low:continue
        result=score_result(x);score=result['percent'];seconds=max(0,((x.submitted_at or x.expires_at)-x.started_at).total_seconds())
        row=rows[x.account_id];row['written_graded']+=1;row['written_scores'].append(score)
        signature=content_key(p)
        t=test_versions.setdefault((x.assessment_id,signature),{'id':x.assessment_id,'title':p['title'],'revision':signature[:12],'current':is_current,'published':tests[x.assessment_id].published,'archived':tests[x.assessment_id].archived,'assigned':None,'graded':0,'submitted':0,'scores':[],'durations':[]});t['graded']+=1;t['scores'].append(score);t['durations'].append(seconds)
        day=daily[local_day(graded_at)];day['written']+=1
        attempts.append({'id':x.id,'kind':'written','account_id':x.account_id,'name':row['name'],'title':p['title'],'assessment_id':x.assessment_id,'current':is_current,'at':iso(graded_at),'score':score,'passed':result['passed'],'seconds':seconds,'url':'/app/assessment-attempts/'+x.id})
        grades=parse(x.grades)
        # Different rubric revisions remain separate even when a title is reused.
        signature=signature[:12]
        for task in p['tasks']:
            for criterion,value,maximum in criteria_percent(task,grades.get(task['id'],{}).get('scores',{})):
                key=(x.assessment_id,signature,task['id'],criterion['id'])
                rr=rubric_rows.setdefault(key,{'assessment_id':x.assessment_id,'title':p['title'],'revision':signature,'task':task['prompt'],'criterion':criterion['label'],'graded':0,'values':[]})
                rr['graded']+=1;rr['values'].append(100*value/maximum)
    team=[]
    for row in rows.values():
        own=[values for (uid,_),values in progressions.items() if uid==row['id']]
        row['pending_review']=sum(q['account_id']==row['id'] for q in queue)
        row.update(best_score=average([max(v) for v in own]),average_score=average(row.pop('scores')),median_seconds=median(row.pop('durations')),written_average=average(row.pop('written_scores')),first_score=average([v[0] for v in own]),latest_score=average([v[-1] for v in own]),improvement_pp=average([v[-1]-v[0] for v in own if len(v)>1]),retested_course_versions=sum(len(v)>1 for v in own))
        team.append(row)
    for c in per_course.values():
        series=[v for (_,rid),v in progressions.items() if rid==c['revision_id']]
        c.update(average_score=average(c.pop('scores')),median_seconds=median(c.pop('durations')),participants=len(c.pop('started')),passed_people=len(c.pop('passed_people')),first_attempt_pass_percent=pct(sum(v[0]>=c['passing_score'] for v in series),len(series)),improvement_pp=average([v[-1]-v[0] for v in series if len(v)>1]),retested_people=sum(len(v)>1 for v in series))
    for t in test_versions.values():t.update(average_score=average(t.pop('scores')),median_seconds=median(t.pop('durations')))
    for q in question_rows.values():q['mistake_percent']=pct(q['mistakes'],q['checked']);q['distractors']=[{'answer':a,'count':n} for a,n in sorted(q['distractors'].items(),key=lambda x:-x[1])]
    for r in rubric_rows.values():r['average_percent']=average(r.pop('values'))
    questions=sorted(question_rows.values(),key=lambda q:(-q['mistake_percent'],-q['checked'],q['prompt']))
    timeline=[{'date':day,'auto':r['auto'],'written':r['written'],'passed':r['passed'],'average_score':average(r['scores'])} for day,r in sorted(daily.items())]
    assigned=sum(r['assigned'] for r in team);completed=sum(r['complete'] for r in team)
    scores=[r['score'] for r in attempts if r['kind']=='auto'];durations=[r['seconds'] for r in attempts if r['kind']=='auto' and r['seconds'] is not None]
    latest_groups=list(progressions.values());queue.sort(key=lambda q:(-q['waiting_hours'],q['id']))
    return {'period':{'start':start.isoformat() if start else None,'end':end.isoformat(),'timezone':'Europe/Moscow','history':history},'scope_note':'Готовность и очередь проверки — по текущим назначениям за всё время. Попытки и динамика — по завершению в выбранном периоде. Письменные оценки сгруппированы по дате проверки. Вопросы — по последней попытке сотрудника в каждой редакции за период.','filters':{'staff':[{'id':a.id,'name':a.name,'active':a.active} for a in all_staff],'courses':[{'id':c.id,'title':c.title} for c in all_courses],'assessments':[{'id':t.id,'title':t.title} for t in all_tests],'positions':POSITIONS},'summary':{'employees':len(team),'active_in_period':len({r['account_id'] for r in attempts}),'assigned':assigned,'complete':completed,'completion_percent':pct(completed,assigned),'overdue':sum(r['overdue'] for r in team),'pending_review':len(queue),'auto_attempts':len(scores),'average_score':average(scores),'median_seconds':median(durations),'passed_attempt_percent':pct(sum(r['passed'] is True for r in attempts if r['kind']=='auto'),len(scores)),'first_attempt_pass_percent':pct(sum(v[0]>=per_course[rid]['passing_score'] for (_,rid),v in progressions.items()),len(latest_groups)),'written_graded':sum(r['written_graded'] for r in team),'timed_out':timed_out},'team':team,'courses':sorted(per_course.values(),key=lambda c:(c['title'],-c['version'])),'assessments':list(test_versions.values()),'questions':questions,'rubrics':sorted(rubric_rows.values(),key=lambda r:r['average_percent']),'review_queue':queue,'timeline':timeline,'attempts':sorted(attempts,key=lambda r:(r['at'],r['id']),reverse=True)}


def params(request:Request,db,a,days,start,end,position,account_id,course_id,assessment_id,history,include_inactive):
    oid=manager(request,db,a)
    return build(db,oid,days,start,end,position,account_id,course_id,assessment_id,history,include_inactive)

@router.get('/api/reports/analytics')
def analytics(request:Request,days:int=30,start:date|None=None,end:date|None=None,position:str='',account_id:int|None=None,course_id:int|None=None,assessment_id:int|None=None,history:bool=False,include_inactive:bool=False,a=Depends(actor),db=Depends(get_db)):
    return params(request,db,a,days,start,end,position,account_id,course_id,assessment_id,history,include_inactive)

@router.get('/api/reports/analytics/export')
def export(request:Request,section:str='team',days:int=30,start:date|None=None,end:date|None=None,position:str='',account_id:int|None=None,course_id:int|None=None,assessment_id:int|None=None,history:bool=False,include_inactive:bool=False,a=Depends(actor),db=Depends(get_db)):
    result=params(request,db,a,days,start,end,position,account_id,course_id,assessment_id,history,include_inactive)
    cols={'team':[('name','Сотрудник'),('assigned','Назначено'),('complete','Завершено'),('completion_percent','Готовность, %'),('overdue','Просрочено'),('pending_review','Ожидают проверки'),('attempts','Попыток автотеста'),('average_score','Средний балл'),('first_score','Первая оценка'),('latest_score','Последняя оценка'),('improvement_pp','Изменение, п.п.'),('median_seconds','Медиана времени, сек')],'courses':[('title','Курс'),('version','Редакция'),('current','Актуальная'),('assigned','Назначено'),('complete','Завершено'),('participants','Проходили за период'),('attempts','Попыток'),('average_score','Средний балл'),('first_attempt_pass_percent','Зачёт с первой попытки, %'),('median_seconds','Медиана времени, сек')],'questions':[('course_title','Курс'),('version','Редакция'),('prompt','Вопрос'),('checked','Проверено сотрудников'),('mistakes','Ошибок'),('mistake_percent','Ошибок, %')],'attempts':[('name','Сотрудник'),('title','Проверка'),('kind','Тип'),('version','Редакция'),('at','Завершение UTC'),('score','Баллы, %'),('passed','Зачёт'),('seconds','Время, сек')],'review_queue':[('name','Сотрудник'),('title','Работа'),('submitted_at','Сдано UTC'),('waiting_hours','Ожидание, ч')],'rubrics':[('title','Тест'),('revision','Редакция'),('task','Задание'),('criterion','Критерий'),('graded','Оценено'),('average_percent','Средний результат, %')],'timeline':[('date','Дата МСК'),('auto','Автотестов'),('written','Проверено письменных'),('passed','Зачётов автотеста'),('average_score','Средний балл автотеста')]}
    require(section in cols,'Неизвестный раздел',422)
    out=io.StringIO();w=csv.writer(out,delimiter=';');w.writerow([label for _,label in cols[section]])
    for row in result[section]:
        values=['' if row.get(key) is None else str(row.get(key,'')) for key,_ in cols[section]]
        w.writerow(["'"+v if v.lstrip().startswith(('=','+','-','@','\t','\r')) else v for v in values])
    return Response(out.getvalue().encode('utf-8-sig'),media_type='text/csv',headers={'Content-Disposition':'attachment; filename="baros-analytics-'+section+'.csv"'})
