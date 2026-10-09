"""Bounded OpenAI-compatible adapters for Qwen and Yandex AI Studio."""
import json
import math
import os
import secrets
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from urllib.parse import urlsplit

import httpx
from sqlalchemy import select, func
from ..db import SessionLocal
from .models import AIRequest, AIUsage, Setting, Job
from .domain import now, dump, parse


class ProviderError(ValueError):
    def __init__(self, message, retryable=False):
        super().__init__(message)
        self.retryable = retryable


def enabled(name):
    return os.getenv(name, '0').lower() in {'1', 'true', 'yes', 'on'}


def number(name, default):
    try: value = Decimal(os.getenv(name, str(default)))
    except InvalidOperation: raise ValueError('Проверьте настройку AI: '+name) from None
    if not value.is_finite() or value < 0: raise ValueError('Проверьте настройку AI: '+name)
    return value


def count_limit(name, default):
    value = number(name, default)
    if value != int(value): raise ValueError('Лимит AI должен быть целым: '+name)
    return int(value)


def provider(name, purpose='authoring'):
    if name == 'qwen':
        key = os.getenv('QWEN_API_KEY', '')
        base = os.getenv('QWEN_BASE_URL', '').rstrip('/')
        if not enabled('QWEN_ENABLED') or not key or not base: return None
        host = urlsplit(base).hostname or ''
        # Built-in prices are for Singapore International, not Global/China pricing.
        if host != 'dashscope-intl.aliyuncs.com' and not host.endswith('.ap-southeast-1.maas.aliyuncs.com'):
            raise ValueError('QWEN_BASE_URL: используйте Singapore International; тариф другого региона требует отдельного адаптера.')
        model = os.getenv('QWEN_CHAT_MODEL' if purpose == 'mentor' else 'QWEN_AUTHOR_MODEL',
                          'qwen3.5-flash' if purpose == 'mentor' else 'qwen3.5-plus')
        if model in {'qwen3.5-flash', 'qwen3.5-flash-2026-02-23'}:
            tiers = [[1000000, '.1', '.01', '.4', '.125']]
        elif model in {'qwen3.5-plus', 'qwen3.5-plus-2026-02-15', 'qwen3.5-plus-2026-04-20'}:
            tiers = [[256000, '.4', '.04', '2.4', '.5'], [1000000, '.5', '.05', '3', '.625']]
        else: raise ValueError('Для этой модели Qwen ещё нет проверенного тарифа. Используйте Qwen3.5 Flash/Plus.')
        currency, headers = 'USD', {'Authorization': 'Bearer '+key}
    elif name == 'yandex':
        key, folder = os.getenv('YANDEX_API_KEY', ''), os.getenv('YANDEX_FOLDER_ID', '')
        if not enabled('YANDEX_ENABLED') or not key or not folder: return None
        base = 'https://ai.api.cloud.yandex.net/v1'
        alias = os.getenv('YANDEX_CHAT_MODEL' if purpose == 'mentor' else 'YANDEX_AUTHOR_MODEL',
                          'aliceai-llm-flash' if purpose == 'mentor' else 'qwen3.6-35b-a3b')
        prices = {'aliceai-llm-flash': ['100', '25', '200', '100'],
                  'qwen3.6-35b-a3b': ['200', '50', '300', '200'],
                  'yandexgpt-lite/latest': ['200', '200', '200', '200']}
        if alias not in prices: raise ValueError('Для этой модели Yandex нет проверенного тарифа в BarOS.')
        if purpose == 'vision' and alias != 'qwen3.6-35b-a3b':
            raise ValueError('Резервное распознавание фото требует YANDEX_AUTHOR_MODEL=qwen3.6-35b-a3b.')
        model, tiers, currency = f'gpt://{folder}/{alias}', [[131072, *prices[alias]]], 'RUB'
        headers = {'Authorization': 'Api-Key '+key, 'OpenAI-Project': folder}
    else: return None
    parsed = urlsplit(base)
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Адрес API должен быть HTTPS без секретов и параметров в URL.')
    return {'provider': name, 'base': base, 'model': model, 'currency': currency,
            'headers': headers, 'tiers': tiers, 'free': False}


def choose(purpose='authoring'):
    primary = os.getenv('MENTOR_PROVIDER' if purpose == 'mentor' else 'AI_PROVIDER', 'auto').lower()
    return provider(primary, purpose)


def public_status(purpose='mentor'):
    try:
        p = choose(purpose)
        return {'configured': bool(p), 'provider': p['provider'] if p else 'local',
                'model': p['model'] if p else '', 'currency': p['currency'] if p else None,
                'fallback': enabled('AI_YANDEX_FALLBACK') and bool(provider('yandex', purpose))}
    except ValueError:
        return {'configured': False, 'provider': 'local', 'model': '', 'currency': None,
                'fallback': False, 'configuration_error': True}


def rates(p, tokens):
    for threshold, *prices in p['tiers']:
        if tokens <= threshold: return [Decimal(x) for x in prices]
    raise ValueError('Материал превышает контекст модели. Разделите его на несколько курсов.')


def budgets(currency):
    defaults = {'USD': ['1', '10', '1', '5', '.05', '.75'], 'RUB': ['100', '1000', '100', '500', '10', '100']}[currency]
    keys = ['DAILY', 'MONTHLY', 'VENUE_DAILY', 'VENUE_MONTHLY', 'EMPLOYEE_DAILY', 'JOB']
    return {k.lower(): int(number(f'AI_{k}_BUDGET_{currency}', v)*1000000) for k, v in zip(keys, defaults)}


def spend(db, currency, filters=()):
    return db.scalar(select(func.coalesce(func.sum(func.coalesce(AIRequest.cost_micro, AIRequest.reserved_micro)), 0))
                     .where(AIRequest.currency == currency, *filters)) or 0


def reserve(p, purpose, messages, maximum_output, oid, aid, job_id=None, lease_token=None):
    text_size, images = 0, 0
    for message in messages:
        content = message['content']
        if isinstance(content, str): text_size += len(content.encode('utf-8'))
        else:
            for part in content:
                if part['type'] == 'text': text_size += len(part['text'].encode('utf-8'))
                elif part['type'] == 'image_url': images += 1
    # Images are sanitised and capped at 1600px; reserve generously rather than guess OCR cost.
    bound = text_size+12000+images*65536
    values = rates(p, bound)
    maximum = math.ceil(bound*max(values[0], values[3])+maximum_output*values[2])
    day = now().replace(hour=0, minute=0, second=0, microsecond=0)
    month = day.replace(day=1)
    with SessionLocal() as db:
        db.execute(select(Setting).where(Setting.key == 'ai_quota_lock').with_for_update()).first()
        if job_id:
            job = db.get(Job, job_id)
            if not job or job.lease_token != lease_token: raise ValueError('Задача передана другому процессу')
        recent = now()-timedelta(days=1)
        total = db.scalar(select(func.count(AIRequest.id)).where(AIRequest.created_at >= recent)) or 0
        total += db.scalar(select(func.count(AIUsage.id)).where(AIUsage.created_at >= recent)) or 0
        if total >= count_limit('AI_PROVIDER_DAILY_CALL_LIMIT', 200):
            raise ValueError('Суточный лимит вызовов AI исчерпан. Учебные материалы и прогресс сохранены.')
        if purpose == 'mentor':
            for name, filters, default in [
                ('MENTOR_EMPLOYEE_DAILY_CALLS', [AIRequest.account_id == aid], 60),
                ('MENTOR_VENUE_DAILY_CALLS', [AIRequest.organization_id == oid], 600)]:
                n = db.scalar(select(func.count(AIRequest.id)).where(AIRequest.purpose == 'mentor', AIRequest.created_at >= day, *filters)) or 0
                if n >= count_limit(name, default): raise ValueError('Лимит беседы на сегодня достигнут. Уроки, карточки и игры остаются доступными.')
        lim = budgets(p['currency'])
        checks = [('daily', [AIRequest.created_at >= day]), ('monthly', [AIRequest.created_at >= month]),
                  ('venue_daily', [AIRequest.organization_id == oid, AIRequest.created_at >= day]),
                  ('venue_monthly', [AIRequest.organization_id == oid, AIRequest.created_at >= month])]
        if purpose == 'mentor': checks.append(('employee_daily', [AIRequest.account_id == aid, AIRequest.created_at >= day]))
        if job_id: checks.append(('job', [AIRequest.job_id == job_id]))
        for name, filters in checks:
            if spend(db, p['currency'], filters)+maximum > lim[name]:
                raise ValueError('Лимит расходов AI не позволяет следующий запрос. Прогресс сохранён; обратитесь к управляющему.')
        uid = secrets.token_urlsafe(24)
        db.add(AIRequest(id=uid, organization_id=oid, account_id=aid, job_id=job_id, purpose=purpose,
                         provider=p['provider'], model=p['model'], currency=p['currency'],
                         rates_json=dump(p['tiers']), reserved_micro=maximum))
        if job_id:
            job.call_count += 1
            job.lease_until = now()+timedelta(minutes=5)
        db.commit()
        return uid


def settle(uid, usage=None, rejected=False):
    with SessionLocal() as db:
        item = db.get(AIRequest, uid)
        if rejected:
            item.cost_micro, item.status = 0, 'rejected'
        elif isinstance(usage, dict) and type(usage.get('prompt_tokens')) is int and type(usage.get('completion_tokens')) is int:
            item.input_tokens, item.output_tokens = max(0, usage['prompt_tokens']), max(0, usage['completion_tokens'])
            details = usage.get('prompt_tokens_details') or {}
            cached = details.get('cached_tokens', 0)
            item.cached_tokens = min(item.input_tokens, max(0, cached if type(cached) is int else 0))
            values = rates({'tiers': parse(item.rates_json, [])}, item.input_tokens)
            item.cost_micro = math.ceil((item.input_tokens-item.cached_tokens)*values[0]+item.cached_tokens*values[1]+item.output_tokens*values[2])
            item.status = 'recorded'
        else: item.status = 'unconfirmed'
        db.commit()


async def complete(purpose, messages, oid, aid, maximum_output=2000, job_id=None, lease_token=None):
    p = choose(purpose)
    if not p: raise ValueError('Подключите Qwen или Yandex AI Studio на сервере. Базовая помощь питомца доступна без API.')
    candidates = [p]
    if p['provider'] != 'yandex' and enabled('AI_YANDEX_FALLBACK'):
        backup = provider('yandex', purpose)
        if backup: candidates.append(backup)
    for index, candidate in enumerate(candidates):
        uid = reserve(candidate, purpose, messages, maximum_output, oid, aid, job_id, lease_token)
        payload = {'model': candidate['model'], 'messages': messages, 'max_tokens': maximum_output,
                   'temperature': .25 if purpose != 'mentor' else .55, 'response_format': {'type': 'json_object'}}
        if candidate['provider'] == 'qwen': payload['enable_thinking'] = False
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(90 if purpose != 'mentor' else 45, connect=10), follow_redirects=False) as client:
                response = await client.post(candidate['base']+'/chat/completions', headers=candidate['headers'], json=payload)
        except (httpx.TimeoutException, httpx.NetworkError):
            settle(uid)
            failure = ProviderError('AI временно не отвечает. Неподтверждённый расход зарезервирован, прогресс сохранён.', True)
        else:
            if response.status_code >= 400:
                settle(uid, rejected=400 <= response.status_code < 500)
                failure = ProviderError('Провайдер AI временно недоступен.' if response.status_code == 429 or response.status_code >= 500 else 'AI отклонил доступ или параметры. Проверьте ключ, регион и модель.', response.status_code == 429 or response.status_code >= 500)
            else:
                try: data = response.json()
                except ValueError:
                    settle(uid)
                    raise ProviderError('AI вернул повреждённый ответ. Подтверждённый материал сохранён.') from None
                settle(uid, data.get('usage'))
                try:
                    choice = data['choices'][0]
                    if choice.get('finish_reason') == 'length': raise ValueError()
                    text = choice['message']['content']
                    result = json.loads(text)
                    if not isinstance(result, dict): raise ValueError()
                except (KeyError, IndexError, TypeError, ValueError):
                    raise ProviderError('AI вернул неполный или неверный JSON. Расход учтён, прогресс сохранён.') from None
                result['_model_used'], result['_provider_used'] = candidate['model'], candidate['provider']
                return result
        if not failure.retryable or index == len(candidates)-1: raise failure


def overview(db, oid=None):
    filters = [AIRequest.organization_id == oid] if oid else []
    day = now().replace(hour=0, minute=0, second=0, microsecond=0)
    rows = db.scalars(select(AIRequest).where(*filters).order_by(AIRequest.created_at.desc()).limit(50)).all()
    return {'currencies': {c: {'daily': spend(db, c, [*filters, AIRequest.created_at >= day])/1000000,
                             'monthly': spend(db, c, [*filters, AIRequest.created_at >= day.replace(day=1)])/1000000,
                             'limits': {k: v/1000000 for k, v in budgets(c).items() if not oid or k.startswith('venue')}} for c in ['USD', 'RUB']},
            'requests': [{'provider': r.provider, 'model': r.model, 'purpose': r.purpose, 'currency': r.currency,
                          'cost': (r.cost_micro if r.cost_micro is not None else r.reserved_micro)/1000000,
                          'status': r.status, 'input_tokens': r.input_tokens, 'output_tokens': r.output_tokens,
                          'at': r.created_at.isoformat()+'Z'} for r in rows]}
