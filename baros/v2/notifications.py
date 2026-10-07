import base64
import os
from datetime import timedelta
from urllib.parse import urlparse
from fastapi import APIRouter, Depends, Request
from sqlalchemy import select, delete
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid
from pywebpush import webpush, WebPushException
from ..db import SessionLocal, get_db
from .models import Setting, Account, Notice, PushSubscription, Enrollment, CourseRevision, Exam, VenueSettings
from .domain import now, iso, dump, parse, digest, require, add_notice, accessible_courses
from .auth import actor, tenant

router=APIRouter()


def ensure_vapid(db):
    if db.get(Setting,'vapid_private'):return
    key=ec.generate_private_key(ec.SECP256R1())
    private=key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode()
    public=key.public_key().public_bytes(serialization.Encoding.X962,serialization.PublicFormat.UncompressedPoint)
    db.add(Setting(key='vapid_private',value=private))
    db.add(Setting(key='vapid_public',value=base64.urlsafe_b64encode(public).decode().rstrip('=')));db.commit()


@router.get('/api/push/key')
def push_key(a=Depends(actor),db=Depends(get_db)):
    return {'public_key':db.get(Setting,'vapid_public').value}


def valid_endpoint(endpoint):
    p=urlparse(endpoint)
    allowed={'fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com','wns.windows.com','notify.windows.com'}
    host=p.hostname or ''
    return p.scheme=='https' and not p.username and not p.password and p.port in (None,443) and any(host==x or host.endswith('.'+x) for x in allowed)


@router.post('/api/push')
def subscribe(data:dict,request:Request,a=Depends(actor),db=Depends(get_db)):
    endpoint=data.get('endpoint','')
    require(isinstance(endpoint,str) and len(endpoint)<=3000 and valid_endpoint(endpoint),'Некорректный адрес push-сервиса')
    keys=data.get('keys',{})
    require(isinstance(keys,dict) and isinstance(keys.get('p256dh'),str) and isinstance(keys.get('auth'),str),'Некорректный ключ подписки')
    require(len(keys['p256dh'])<=200 and len(keys['auth'])<=100,'Некорректный ключ подписки')
    row=db.scalar(select(PushSubscription).where(PushSubscription.endpoint_hash==digest(endpoint)))
    if row:
        row.account_id=a.id;row.payload=dump({'endpoint':endpoint,'keys':keys});row.failures=0
    else:db.add(PushSubscription(account_id=a.id,endpoint_hash=digest(endpoint),payload=dump({'endpoint':endpoint,'keys':keys})))
    db.commit();return {'ok':True}


@router.delete('/api/push')
def unsubscribe(data:dict,a=Depends(actor),db=Depends(get_db)):
    db.execute(delete(PushSubscription).where(PushSubscription.account_id==a.id,PushSubscription.endpoint_hash==digest(str(data.get('endpoint','')))));db.commit();return {'ok':True}


def deliver_and_remind():
    from .learning import finish
    with SessionLocal() as db:
        lock=db.scalar(select(Setting).where(Setting.key=='maintenance_lock').with_for_update())
        if lock.value and lock.value>iso(now()):return
        lock.value=iso(now()+timedelta(seconds=50));db.commit()
        # Expired attempts are counted even if the browser was closed.
        for exam in db.scalars(select(Exam).where(Exam.finished_at.is_(None),Exam.expires_at<=now()).limit(100)).all():
            rev=db.get(CourseRevision,exam.revision_id)
            finish(db,exam,parse(rev.payload))
        for a in db.scalars(select(Account).where(Account.role=='employee',Account.active==True)).all():
            venue=db.get(VenueSettings,a.organization_id)
            if not venue or venue.status in {'suspended','archived'}:continue
            for c,s,rev,data in accessible_courses(db,a):
                e=db.scalar(select(Enrollment).where(Enrollment.account_id==a.id,Enrollment.revision_id==rev.id))
                if not e or not e.due_at:continue
                completed=db.scalars(select(Exam).where(Exam.account_id==a.id,Exam.revision_id==rev.id,Exam.finished_at.is_not(None))).all()
                if any(parse(x.result_json).get('passed') for x in completed):continue
                remaining=(e.due_at-now()).total_seconds()
                if remaining<0:
                    add_notice(db,a.id,f'overdue:{rev.id}','Срок обучения прошёл',f'Завершите «{data["title"]}». Управляющий увидит обновлённый результат.',f'/app/learn/{c.id}')
                elif remaining<86400:
                    add_notice(db,a.id,f'due:{rev.id}','До дедлайна меньше суток',f'Не забудьте пройти «{data["title"]}».',f'/app/learn/{c.id}')
        db.commit()
        pending=db.scalars(select(Notice).where(Notice.push_sent==False).order_by(Notice.id).limit(50)).all()
        key=db.get(Setting,'vapid_private')
        if not key:return
        vapid=Vapid.from_pem(key.value.encode())
        for n in pending:
            recipient=db.get(Account,n.account_id)
            if not recipient or not recipient.active:n.push_sent=True;continue
            subs=db.scalars(select(PushSubscription).where(PushSubscription.account_id==n.account_id,PushSubscription.failures<3)).all()
            for sub in subs:
                try:
                    webpush(subscription_info=parse(sub.payload),data=dump({'title':n.title,'body':n.body,'url':n.url}),
                            vapid_private_key=vapid,vapid_claims={'sub':os.getenv('VAPID_SUBJECT','https://baros-staging.onrender.com')},ttl=86400,timeout=10)
                    sub.failures=0
                except WebPushException as exc:
                    if exc.response is not None and exc.response.status_code in {404,410}:db.delete(sub)
                    else:sub.failures+=1
                except Exception:sub.failures+=1
            # In-app delivery is durable even when browser notifications were declined.
            n.push_sent=True
        db.commit()
