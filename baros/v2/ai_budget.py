"""Conservative application spend guard. Provider invoices remain authoritative."""
import math
import os
import secrets
from decimal import Decimal, InvalidOperation
from sqlalchemy import select, func
from .models import AIUsage
from .domain import now

# USD per million tokens, official Standard short-context rates, checked 2026-10-08.
PRICES={'gpt-6-luna':(Decimal('.10'),Decimal('.01'),Decimal('.50'),Decimal('.125')),
        'gpt-6.1-sol':(Decimal('2'),Decimal('.10'),Decimal('10'),Decimal('2.50'))}


def money_env(name,default):
    try:value=Decimal(os.getenv(name,default))
    except InvalidOperation:raise ValueError('Проверьте бюджет AI: '+name) from None
    if not value.is_finite() or value<0:raise ValueError('Проверьте бюджет AI: '+name)
    return int(value*1_000_000)


def limits():
    return {'daily':money_env('OPENAI_DAILY_BUDGET_USD','1'),'monthly':money_env('OPENAI_MONTHLY_BUDGET_USD','10'),
            'job':money_env('OPENAI_JOB_BUDGET_USD','.75')}


def used(db,where):
    return db.scalar(select(func.coalesce(func.sum(func.coalesce(AIUsage.cost_micro_usd,AIUsage.reserved_micro_usd)),0)).where(AIUsage.provider=='openai',*where)) or 0


def reserve(db,job,model,prompt,system,max_output):
    if model not in PRICES:raise ValueError('Модель OpenAI не имеет проверенного тарифа в BarOS. Используйте gpt-6-luna или gpt-6.1-sol.')
    rates=PRICES[model]
    # A byte is an upper bound on BPE token count for text; reserve full output,
    # cache-write premium and generous framing/schema overhead. Never assume a cache hit.
    maximum=math.ceil((len((system+prompt).encode('utf-8'))+12000)*max(rates[0],rates[3])+max_output*rates[2])
    lim=limits();day=now().replace(hour=0,minute=0,second=0,microsecond=0);month=day.replace(day=1)
    for name,filters in [('daily',[AIUsage.created_at>=day]),('monthly',[AIUsage.created_at>=month]),('job',[AIUsage.job_id==job.id])]:
        if used(db,filters)+maximum>lim[name]:raise ValueError({'daily':'Дневной','monthly':'Месячный','job':'Бюджет этой генерации:'}[name]+' лимит OpenAI не позволяет следующий запрос. Прогресс сохранён. Владелец может проверить расход или изменить бюджет.')
    item=AIUsage(id=secrets.token_urlsafe(24),job_id=job.id,organization_id=job.organization_id,provider='openai',model=model,reserved_micro_usd=maximum,status='reserved')
    db.add(item);db.flush();return item.id


def settle(db,uid,usage=None,failed=False):
    item=db.get(AIUsage,uid)
    if not item:return
    if failed:item.cost_micro_usd=0;item.status='rejected';return
    if not isinstance(usage,dict) or type(usage.get('prompt_tokens')) is not int or type(usage.get('completion_tokens')) is not int:
        item.status='unconfirmed';return
    item.input_tokens=max(0,usage['prompt_tokens']);item.output_tokens=max(0,usage['completion_tokens'])
    details=usage.get('prompt_tokens_details') or {}
    item.cached_tokens=min(item.input_tokens,max(0,int(details.get('cached_tokens') or 0)))
    writes=min(item.input_tokens-item.cached_tokens,max(0,int(details.get('cache_write_tokens') or 0)))
    rates=PRICES[item.model]
    item.cost_micro_usd=math.ceil((item.input_tokens-item.cached_tokens-writes)*rates[0]+item.cached_tokens*rates[1]+writes*rates[3]+item.output_tokens*rates[2]);item.status='recorded'


def overview(db,oid=None):
    day=now().replace(hour=0,minute=0,second=0,microsecond=0);month=day.replace(day=1)
    filters=[AIUsage.organization_id==oid] if oid else []
    rows=db.scalars(select(AIUsage).where(*filters).order_by(AIUsage.created_at.desc()).limit(50)).all()
    return {'daily_usd':used(db,[*filters,AIUsage.created_at>=day])/1_000_000,'monthly_usd':used(db,[*filters,AIUsage.created_at>=month])/1_000_000,
      'limits_usd':{k:v/1_000_000 for k,v in limits().items()} if not oid else None,
      'requests':[{'job_id':r.job_id,'model':r.model,'input_tokens':r.input_tokens,'output_tokens':r.output_tokens,'cached_tokens':r.cached_tokens,
         'cost_usd':(r.cost_micro_usd if r.cost_micro_usd is not None else r.reserved_micro_usd)/1_000_000,'status':r.status,'at':r.created_at.isoformat()+'Z'} for r in rows]}
