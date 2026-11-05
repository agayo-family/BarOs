"""Authenticated, private support requests with no personal contact details in the UI."""
from typing import Literal
from fastapi import APIRouter,Depends,Request
from pydantic import BaseModel,ConfigDict,Field,StrictInt
from sqlalchemy import select
from ..db import get_db
from ..models import Organization
from .auth import actor,owner,rate,selected_venue
from .models import SupportTicket,Account
from .domain import require,iso,now,add_notice,log
router=APIRouter()
def support_org(request, db, a, lock=False):
    # Help is available even for a suspended venue.
    return selected_venue(request, db, a, lock=lock)[0]

class TicketIn(BaseModel):
    model_config=ConfigDict(extra='forbid',str_strip_whitespace=True)
    category:Literal['access','learning','technical','other']='other'
    message:str=Field(min_length=10,max_length=4000)
class ReplyIn(BaseModel):
    model_config=ConfigDict(extra='forbid',str_strip_whitespace=True)
    version:StrictInt=Field(ge=1)
    response:str=Field(default='',max_length=4000)
    status:Literal['open','in_progress','closed']='in_progress'
def data(t,authors=None,venues=None):
    return {'id':t.id,'category':t.category,'message':t.message,'response':t.response,'status':t.status,'version':t.version,'created_at':iso(t.created_at),'updated_at':iso(t.updated_at),**({'author':authors.get(t.account_id,'Участник команды'),'venue':venues.get(t.organization_id,'Платформа')} if authors is not None else {})}
def visible(db,a,tid,lock=False,oid=None):
    q=select(SupportTicket).where(SupportTicket.id==tid)
    if a.role!='owner':q=q.where(SupportTicket.account_id==a.id,SupportTicket.organization_id==oid)
    t=db.scalar(q.with_for_update() if lock else q);require(t,'Обращение не найдено',404);return t
@router.get('/api/support')
def tickets(request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=support_org(request,db,a) if a.role!='owner' else None
    q=select(SupportTicket)
    if a.role!='owner':q=q.where(SupportTicket.account_id==a.id,SupportTicket.organization_id==oid)
    rows=db.scalars(q.order_by(SupportTicket.updated_at.desc(),SupportTicket.id.desc()).limit(200)).all()
    authors={x.id:x.name for x in db.scalars(select(Account).where(Account.id.in_({t.account_id for t in rows}))).all()} if a.role=='owner' else None
    venues={o.id:o.name for o in db.scalars(select(Organization).where(Organization.id.in_({t.organization_id for t in rows if t.organization_id}))).all()} if a.role=='owner' else None
    return {'items':[data(t,authors,venues) for t in rows],'limit':200}
@router.get('/api/support/{tid}')
def ticket(tid:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=support_org(request,db,a) if a.role!='owner' else None
    return data(visible(db,a,tid,oid=oid))
@router.post('/api/support')
def create(body:TicketIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    rate(db,'support:'+str(a.id),8,3600)
    oid=support_org(request,db,a,lock=True) if a.role!='owner' else None
    t=SupportTicket(organization_id=oid,account_id=a.id,category=body.category,message=body.message);db.add(t);db.flush()
    for aid in db.scalars(select(Account.id).where(Account.role=='owner',Account.active==True)).all():
        add_notice(db,aid,'support-new:'+str(t.id),'Новое обращение','Откройте раздел поддержки, чтобы прочитать обращение.','/app/support?ticket='+str(t.id))
    log(db,a,oid,'Создано обращение в поддержку',ticket_id=t.id);db.commit();return data(t)
@router.put('/api/support/{tid}')
def reply(tid:int,body:ReplyIn,request:Request,a=Depends(actor),db=Depends(get_db)):
    owner(a);t=visible(db,a,tid,True);require(t.version==body.version,'Обращение уже изменено. Обновите страницу.',409)
    require(body.status!='closed' or body.response,'Добавьте ответ перед закрытием обращения')
    changed=body.response!=t.response;t.response=body.response;t.status=body.status;t.version+=1;t.updated_at=now()
    if changed and t.account_id!=a.id:add_notice(db,t.account_id,'support-answer:'+str(t.id)+':'+str(t.version),'Ответ службы поддержки','Откройте обращение, чтобы прочитать ответ.','/app/support?ticket='+str(t.id)+('&venue='+str(t.organization_id) if t.organization_id else ''))
    log(db,a,t.organization_id,'Обновлено обращение в поддержку',ticket_id=t.id,status=t.status);db.commit();return data(t)
