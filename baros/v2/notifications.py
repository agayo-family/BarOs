import base64
import os
from datetime import datetime, timedelta
from urllib.parse import urlparse
from fastapi import APIRouter, Depends, Request
from sqlalchemy import select, delete
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid
from pywebpush import webpush, WebPushException
from ..db import SessionLocal, get_db
from .models import Setting, Account, Notice, PushSubscription, Enrollment, CourseRevision, Exam, VenueSettings
from .domain import now, iso, dump, parse, digest, require, add_notice, learner_stats_many
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
        from .shifts import remind_shifts
        remind_shifts(db)
        from .games import cleanup_games
        cleanup_games(db)
        for exam in db.scalars(select(Exam).where(Exam.finished_at.is_(None),Exam.expires_at<=now()).limit(100)).all():
            rev=db.get(CourseRevision,exam.revision_id)
            finish(db,exam,parse(rev.payload))
        from .models import WrittenAttempt
        from .packages import submit_attempt
        for x in db.scalars(select(WrittenAttempt).where(WrittenAttempt.status=='in_progress',WrittenAttempt.expires_at<=now()).with_for_update(skip_locked=True).limit(100)).all():submit_attempt(x)
        employees=db.scalars(select(Account).where(Account.role=='employee',Account.active==True)).all()
        progress=learner_stats_many(db,employees)
        for a in employees:
            venue=db.get(VenueSettings,a.organization_id)
            if not venue or venue.status in {'suspended','archived'}:continue
            for c in progress[a.id]['courses']:
                if c['learning_complete'] or not c['due_at']:continue
                if c['written_status']=='submitted' and c['read_count']>=c['lesson_count'] and (not c['question_count'] or c['passed']):continue
                remaining=(datetime.fromisoformat(c['due_at'].replace('Z','+00:00')).replace(tzinfo=None)-now()).total_seconds()
                if remaining<86400:
                    late=remaining<0;key=('overdue:' if late else 'due:')+str(c['revision_id'])
                    add_notice(db,a.id,key,'Срок обучения прошёл' if late else 'До дедлайна меньше суток','Завершите «'+c['title']+'».',f'/app/learn/{c["id"]}')
        db.commit()
        key=db.get(Setting,'vapid_private')
        if not key:return
        from .push_delivery import deliver
        deliver(db,webpush,Vapid.from_pem(key.value.encode()),os.getenv('VAPID_SUBJECT','https://baros-staging.onrender.com'))
