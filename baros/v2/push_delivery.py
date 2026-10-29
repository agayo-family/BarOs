"""Per-device delivery leases and bounded retries for transient provider failures."""
from datetime import timedelta
from sqlalchemy import select,exists
from .models import Notice,PushSubscription,PushDelivery,Account
from .domain import now,parse,dump

def deliver(db,send,vapid,subject):
    pending=db.scalars(select(Notice).where(Notice.push_sent==False,~exists().where(PushDelivery.notice_id==Notice.id)).order_by(Notice.id).with_for_update(skip_locked=True).limit(100)).all()
    for n in pending:
        a=db.get(Account,n.account_id)
        subs=db.scalars(select(PushSubscription).where(PushSubscription.account_id==n.account_id)).all() if a and a.active else []
        if not subs:n.push_sent=True
        for s in subs:db.add(PushDelivery(notice_id=n.id,subscription_id=s.id))
    db.commit()
    rows=db.scalars(select(PushDelivery).where(PushDelivery.status.in_(['pending','sending']),PushDelivery.next_attempt_at<=now()).order_by(PushDelivery.next_attempt_at,PushDelivery.id).with_for_update(skip_locked=True).limit(50)).all()
    ids=[r.id for r in rows]
    for r in rows:r.status='sending';r.next_attempt_at=now()+timedelta(minutes=12)
    db.commit()
    for rid in ids:
        r=db.get(PushDelivery,rid);n=db.get(Notice,r.notice_id);s=db.get(PushSubscription,r.subscription_id);a=db.get(Account,n.account_id) if n else None
        if not s or not a or not a.active or s.account_id!=n.account_id:r.status='skipped';r.last_error='recipient_unavailable';db.commit();continue
        r.attempts+=1
        try:
            send(subscription_info=parse(s.payload),data=dump({'title':n.title,'body':n.body,'url':n.url}),vapid_private_key=vapid,vapid_claims={'sub':subject},ttl=86400,timeout=10)
            r.status='delivered';r.delivered_at=now();r.last_error='';s.failures=0
        except Exception as exc:
            response=getattr(exc,'response',None);code=getattr(response,'status_code',None)
            r.last_error='http_'+str(code) if code else 'transport_error'
            if code in {404,410}:db.delete(s)
            if code in {400,401,403,404,410,413} or r.attempts>=5:r.status='failed'
            else:r.status='pending';r.next_attempt_at=now()+timedelta(minutes=[1,5,15,60][r.attempts-1])
        db.commit()
    for n in db.scalars(select(Notice).where(Notice.push_sent==False,exists().where(PushDelivery.notice_id==Notice.id),~exists().where(PushDelivery.notice_id==Notice.id,PushDelivery.status.in_(['pending','sending'])))).all():n.push_sent=True
    db.commit()
