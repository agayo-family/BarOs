"""Current-version assessment completion; snapshots and old history are preserved."""
import copy
from sqlalchemy import select
from .models import ImportedAssessment,WrittenAttempt
from .domain import applies,dump,parse,now,digest

def content_key(value):
    p=copy.deepcopy(value)
    for t in p.get('tasks',[]):
        if t.get('kind')=='single_choice':
            answer=t['choices'][t['correct_index']];t['choices']=sorted(t['choices']);t['correct_index']=t['choices'].index(answer)
    return digest(dump(p))

def assessment_stats(db,accounts):
    if not accounts:return {}
    tests=[(t,parse(t.payload)) for t in db.scalars(select(ImportedAssessment).where(ImportedAssessment.organization_id.in_({a.organization_id for a in accounts}),ImportedAssessment.published==True,ImportedAssessment.archived==False)).all()]
    keys={t.id:content_key(p) for t,p in tests};latest={}
    for x in db.scalars(select(WrittenAttempt).where(WrittenAttempt.account_id.in_([a.id for a in accounts]),WrittenAttempt.assessment_id.in_(keys)).order_by(WrittenAttempt.started_at.desc(),WrittenAttempt.id.desc())).all() if keys else []:
        key=(x.account_id,x.assessment_id)
        if key not in latest and content_key(parse(x.snapshot))==keys[x.assessment_id]:latest[key]=x
    out={}
    for a in accounts:
        items=[]
        for t,p in tests:
            if t.organization_id!=a.organization_id or not applies(a,p):continue
            x=latest.get((a.id,t.id));status=x.status if x else 'not_started';passed=False
            if x and status=='in_progress' and x.expires_at<=now():status='submitted' if any(t['kind']=='written' for t in parse(x.snapshot)['tasks']) else 'graded'
            if x and status=='graded':
                from .packages import score_result
                passed=score_result(x)['passed'] is not False
            items.append({'id':t.id,'title':t.title,'status':status,'passed':passed,'attempt_id':x.id if x else None,'url':f'/app/assessments/{t.id}'})
        out[a.id]=items
    return out
