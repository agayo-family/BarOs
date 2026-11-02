"""Local, source-bound assembly. No network calls, invented facts or auto-publish."""
import re
from collections import defaultdict
from fastapi import APIRouter, Depends, Request
from pydantic import Field
from ..db import get_db
from ..models import Course
from .auth import actor, manager, rate
from .schemas import StrictModel, CourseIn
from .models import CourseProgram, ImportedAssessment
from .domain import dump, positions, log, require
from .drafts import selected_sources, record_origin
from .content import save_course

router=APIRouter()
class BuildIn(StrictModel):
    title:str=Field(min_length=2,max_length=200)
    source_ids:list[int]=Field(min_length=1,max_length=20)
    positions:list[str]=Field(default=['all'],min_length=1,max_length=16)

def assemble(sources,title,roles):
    blocks=[];facts=defaultdict(list)
    for source in sources:
        heading='Основные правила';parts=[]
        def flush():
            if parts:
                body='\n\n'.join(parts).strip()
                if len(body)>=30:blocks.append({'title':heading[:200],'body':body})
                parts.clear()
        for line in source.text.replace('\r','').split('\n'):
            line=line.strip()
            if not line:continue
            match=re.match(r'^#{1,4}\s+(.+)',line)
            if match:flush();heading=match[1];continue
            if sum(map(len,parts))+len(line)>2200:flush()
            parts.append(line)
            fact=re.match(r'^(.{3,90}?)\s*(?::|=|\s[—–]\s)\s*(\d+(?:[.,]\d+)?\s*[A-Za-zА-Яа-яЁё%° ]{1,30})$',line)
            if fact:
                unit=re.sub(r'^[\d.,\s]+','',fact[2]).lower().strip();facts[unit].append((fact[1],fact[2]))
        flush()
    require(blocks,'Недостаточно проверенного текста. Добавьте материал или сохраните распознанный текст.')
    require(len(blocks)<=100,'Выберите меньше материалов: не более 100 учебных блоков',413)
    questions=[]
    for unit,items in facts.items():
        by_key=defaultdict(set)
        for key,answer in items:by_key[key.casefold()].add(answer)
        values=list(dict.fromkeys(value for _,value in items))
        if len(values)<4:continue
        for key,answer in items:
            if len(by_key[key.casefold()])!=1:continue
            choices=[answer]+[v for v in values if v!=answer][:3]
            questions.append({'prompt':'Какое значение указано для «'+key+'» ('+unit+')?','choices':choices,'correct_index':0,'explanation':key+': '+answer+'.','type':'knowledge'})
    questions=list({q['prompt']:q for q in questions}.values())[:100]
    cards=[{'question':'Что важно помнить: '+b['title']+'?','answer':b['body'],'explanation':'Сверьте формулировку с правилами своего заведения.'} for b in blocks[:60]]
    tasks=[{'id':'topic_'+str(i),'section_id':'main','kind':'written','prompt':'Объясните своими словами тему «'+b['title']+'». Перечислите действия, ограничения и важные числа.','points':10,'rubric':[{'id':'facts','label':'Точность правил и чисел','points':7,'guidance':b['body'][:8000]},{'id':'clarity','label':'Понятное объяснение порядка действий','points':3,'guidance':'Ответ должен соответствовать утверждённым правилам без выдуманных деталей.'}]} for i,b in enumerate(blocks[:60])]
    assessment={'title':(title+' · проверка понимания')[:200],'description':'Письменная проверка по темам курса.','instructions':'Отвечайте своими словами. Если точного правила нет, отметьте, что требуется уточнение.','positions':roles,'sections':[{'id':'main','title':'Правила и применение'}],'tasks':tasks,'time_limit_minutes':180,'max_attempts':3,'passing_score':80,'sequential_sections':False}
    course=CourseIn(title=title,positions=roles,description='Правила и стандарты для работы команды.',lessons=blocks,questions=questions,quiz_size=min(30,len(questions)))
    return course,assessment,cards

@router.post('/api/drafts/assemble')
def build(body:BuildIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a,'courses_manage',True);roles=positions(body.positions)
    rate(db,'source-assembly:'+str(a.id),10,3600)
    sources=selected_sources(db,oid,body.source_ids)
    require(all(s.extraction_status=='ready' and s.text.strip() for s in sources),'Сначала проверьте распознанный текст каждого материала')
    require(sum(len(s.text) for s in sources)<=200000,'Выберите меньше материалов',413)
    data,assessment,cards=assemble(sources,body.title,roles)
    # Use the same validation and publication path as hand-authored content.
    from .packages import AssessmentIn
    checked=AssessmentIn.model_validate(assessment).model_dump(mode='json')
    test=ImportedAssessment(organization_id=oid,title=checked['title'][:200],payload=dump(checked));db.add(test);db.flush()
    c=Course(organization_id=oid,title=data.title,published=False);db.add(c);db.flush();save_course(db,c,data)
    db.add(CourseProgram(course_id=c.id,payload=dump({'flashcards':cards,'written_assessment_id':test.id,'assembly':'source_bound'})))
    record_origin(db,oid,'course',c.id,sources);record_origin(db,oid,'assessment',test.id,sources)
    log(db,a,oid,'Собрано обучение по материалам',course_id=c.id,assessment_id=test.id);db.commit()
    return {'course_id':c.id,'assessment_id':test.id,'lessons':len(data.lessons),'questions':len(data.questions),'written':len(checked['tasks']),'cards':len(cards),'url':'/app/drafts','published':False}
