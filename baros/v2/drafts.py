"""Manual preparation and review. Imports never invoke a model or publish content."""
from typing import Literal
from fastapi import APIRouter,Depends,Request
from pydantic import BaseModel,ConfigDict,Field,StrictInt
from sqlalchemy import select
from sqlalchemy.orm import selectinload,defer
from ..db import get_db
from ..models import Course
from .auth import actor,manager
from .models import DraftOrigin,SourceFile,CourseSettings,CourseProgram,CourseRevision,ImportedAssessment
from .domain import dump,parse,require,digest,log,course_settings,payload,iso,positions
from .source_review import fingerprint
router=APIRouter()

class SourcesIn(BaseModel):
    model_config=ConfigDict(extra='forbid')
    source_ids:list[StrictInt]=Field(default_factory=list,max_length=50)
class CreateIn(SourcesIn):
    title:str=Field(min_length=2,max_length=200)
    positions:list[str]=Field(default=['all'],min_length=1,max_length=16)
class OriginIn(SourcesIn):
    kind:Literal['course','assessment']
    resource_id:StrictInt
    origin_version:str
class LinkIn(BaseModel):
    model_config=ConfigDict(extra='forbid')
    assessment_id:StrictInt|None=None
    edit_version:StrictInt

def selected_sources(db,oid,ids):
    ids=set(ids)
    rows=db.scalars(select(SourceFile).options(defer(SourceFile.content)).where(SourceFile.organization_id==oid,SourceFile.id.in_(ids)).order_by(SourceFile.id)).all() if ids else []
    require(len(rows)==len(ids),'Один из материалов удалён или относится к другому заведению',404)
    return rows
def snapshot(sources):
    return [{'id':s.id,'name':s.name,'fingerprint':fingerprint(s)} for s in sources]
def record_origin(db,oid,kind,rid,sources):
    row=DraftOrigin(organization_id=oid,kind=kind,resource_id=rid,sources_json=dump(snapshot(sources)))
    db.add(row)
    if kind=='course':db.get(CourseSettings,rid).source_ids_json=dump([s.id for s in sources])
    return row
def acknowledge_origin(db,oid,kind,rid):
    row=db.scalar(select(DraftOrigin).where(DraftOrigin.organization_id==oid,DraftOrigin.kind==kind,DraftOrigin.resource_id==rid))
    if row:
        row.sources_json=dump(snapshot(selected_sources(db,oid,[s['id'] for s in parse(row.sources_json,[])])))
        row.review_required=False

@router.get('/api/drafts')
def drafts(request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a)
    origins={(r.kind,r.resource_id):r for r in db.scalars(select(DraftOrigin).where(DraftOrigin.organization_id==oid)).all()}
    sources={s.id:s for s in db.scalars(select(SourceFile).options(defer(SourceFile.content)).where(SourceFile.organization_id==oid)).all()}
    hashes={sid:fingerprint(s) for sid,s in sources.items()}
    courses=db.scalars(select(Course).where(Course.organization_id==oid).options(selectinload(Course.lessons),selectinload(Course.questions)).order_by(Course.id.desc())).all()
    ids=[c.id for c in courses]
    configs={s.course_id:s for s in db.scalars(select(CourseSettings).where(CourseSettings.course_id.in_(ids))).all()}
    programs={p.course_id:p for p in db.scalars(select(CourseProgram).where(CourseProgram.course_id.in_(ids))).all()}
    revisions={r.course_id:r for r in db.scalars(select(CourseRevision).join(CourseSettings,(CourseSettings.course_id==CourseRevision.course_id)&(CourseSettings.version==CourseRevision.version)).where(CourseRevision.course_id.in_(ids))).all()}
    items=[]
    for c in courses:
        cfg=configs.get(c.id) or course_settings(db,c)
        if cfg.archived:continue
        origin=origins.get(('course',c.id));old=revisions.get(c.id)
        changed=bool(c.published and (origin and origin.review_required or old and parse(old.payload)!=payload(db,c,program=programs.get(c.id))))
        if c.published and not changed:continue
        src=parse(origin.sources_json,[]) if origin else [{'id':sid,'name':sources[sid].name,'fingerprint':hashes[sid]} for sid in parse(cfg.source_ids_json,[]) if sid in sources]
        meta=parse(programs[c.id].payload) if c.id in programs else {}
        items.append({'id':c.id,'kind':'course','title':c.title,'positions':parse(cfg.positions_json,['all']),'status':'update' if c.published else 'draft','published':c.published,'sources':src,'lessons':len(c.lessons),'questions':len(c.questions),'written':0,'url':f'/app/courses/{c.id}','updated_at':iso(cfg.updated_at),'source_review_required':bool(meta.get('source_review',{}).get('required'))})
    for t in db.scalars(select(ImportedAssessment).where(ImportedAssessment.organization_id==oid,ImportedAssessment.archived==False).order_by(ImportedAssessment.id.desc())).all():
        origin=origins.get(('assessment',t.id));src=parse(origin.sources_json,[]) if origin else []
        changed=bool(origin and origin.review_required or any(hashes.get(s['id'])!=s['fingerprint'] for s in src))
        if t.published and not changed:continue
        p=parse(t.payload)
        items.append({'id':t.id,'kind':'assessment','title':t.title,'positions':p['positions'],'status':'update' if t.published else 'draft','published':t.published,'sources':src,'lessons':0,'questions':len(p['tasks']),'written':sum(x['kind']=='written' for x in p['tasks']),'url':f'/app/assessments/{t.id}/edit','updated_at':iso(t.created_at)})
    for item in items:
        origin=origins.get((item['kind'],item['id']))
        item['source_review_required']=bool(item.get('source_review_required') or origin and origin.review_required or any(hashes.get(s['id'])!=s['fingerprint'] for s in item['sources']))
        item['origin_version']=digest(dump(parse(origin.sources_json,[]) if origin else []))
    return {'items':items,'courses':sum(x['kind']=='course' for x in items),'assessments':sum(x['kind']=='assessment' for x in items)}

@router.put('/api/drafts/sources')
def edit_origin(data:OriginIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'courses_manage',True);cls=Course if data.kind=='course' else ImportedAssessment
    query=select(cls).where(cls.id==data.resource_id,cls.organization_id==oid)
    resource=db.scalar(query.with_for_update() if data.kind=='assessment' else query)
    require(resource,'Черновик не найден',404)
    if data.kind=='course':db.scalar(select(CourseSettings).where(CourseSettings.course_id==resource.id).with_for_update())
    src=selected_sources(db,oid,data.source_ids)
    row=db.scalar(select(DraftOrigin).where(DraftOrigin.organization_id==oid,DraftOrigin.kind==data.kind,DraftOrigin.resource_id==resource.id).with_for_update())
    require(data.origin_version==digest(dump(parse(row.sources_json,[]) if row else [])),'Привязка изменена в другом окне. Обновите список.',409)
    if row:row.sources_json=dump(snapshot(src))
    else:row=record_origin(db,oid,data.kind,resource.id,src)
    if resource.published:row.review_required=True
    if data.kind=='course':
        cfg=course_settings(db,resource);cfg.source_ids_json=dump([s.id for s in src]);cfg.edit_version+=1
        if resource.published:
            program=db.get(CourseProgram,resource.id);meta=parse(program.payload) if program else {}
            meta['source_review']={'required':True,'source_ids':[s.id for s in src],'reason':'Изменена привязка материалов'}
            if program:program.payload=dump(meta)
            else:db.add(CourseProgram(course_id=resource.id,payload=dump(meta)))
    log(db,a,oid,'Изменены материалы черновика',kind=data.kind,resource_id=resource.id);db.commit();return {'ok':True}

@router.post('/api/drafts/materials')
def materials(data:SourcesIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a);src=selected_sources(db,oid,data.source_ids)
    require(src,'Выберите материалы')
    require(all(s.extraction_status=='ready' and s.text.strip() for s in src),'Проверьте и сохраните распознанный текст материалов')
    text='# Материалы для подготовки обучения\n\nПодготовьте обучение по источникам. Не выдумывайте факты, цифры, составы и правила. Неизвестное оформите вопросами к управляющему. Пишите простыми словами. Используйте правдоподобные ответы сопоставимой длины и письменные ситуации с рубриками. Не добавляйте домашние задания в теорию.\n\n'
    text+='\n\n'.join('## '+s.name+'\n\n'+s.text for s in src)
    require(len(text.encode())<=4*1024*1024,'Выберите меньше материалов',413)
    return {'text':text,'filename':'baros-materials.md','source_ids':[s.id for s in src]}

@router.post('/api/assessments')
def create(data:CreateIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'courses_manage',True);src=selected_sources(db,oid,data.source_ids)
    title=data.title.strip();require(len(title)>=2,'Укажите название теста')
    p={'title':title,'description':'','instructions':'','positions':positions(data.positions),'sections':[{'id':'main','title':'Проверка знаний','instructions':''}],'tasks':[],'time_limit_minutes':60,'max_attempts':3,'passing_score':80,'sequential_sections':True}
    t=ImportedAssessment(organization_id=oid,title=title,payload=dump(p));db.add(t);db.flush();record_origin(db,oid,'assessment',t.id,src)
    log(db,a,oid,'Создан черновик теста',assessment_id=t.id);db.commit();return {'id':t.id,'url':f'/app/assessments/{t.id}/edit'}

@router.put('/api/drafts/courses/{cid}/assessment')
def link(cid:int,data:LinkIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'courses_manage',True);c=db.get(Course,cid);require(c and c.organization_id==oid,'Курс не найден',404)
    cfg=db.scalar(select(CourseSettings).where(CourseSettings.course_id==cid).with_for_update())
    require(cfg.edit_version==data.edit_version,'Курс изменён в другом окне',409)
    if data.assessment_id is not None:
        t=db.get(ImportedAssessment,data.assessment_id);require(t and t.organization_id==oid and not t.archived,'Тест не найден',404)
    row=db.get(CourseProgram,cid);meta=parse(row.payload) if row else {}
    if data.assessment_id:meta['written_assessment_id']=data.assessment_id
    else:meta.pop('written_assessment_id',None)
    if row:row.payload=dump(meta)
    else:db.add(CourseProgram(course_id=cid,payload=dump(meta)))
    cfg.edit_version+=1;log(db,a,oid,'Изменена итоговая проверка курса',course_id=cid);db.commit()
    return {'ok':True,'edit_version':cfg.edit_version,'program':meta}
