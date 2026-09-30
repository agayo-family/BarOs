from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta

import httpx
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import (
    AI_ALLOW_PAID_FALLBACK,
    AI_CONTEXT_LIMIT_CHARS,
    AI_DAILY_LIMIT,
    AI_GLOBAL_DAILY_LIMIT,
    AI_GATEWAY_API_KEY,
    AI_GATEWAY_BASE_URL,
    AI_MODEL,
    AI_PROVIDER,
    OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL,
    OPENROUTER_MODEL,
    PUBLIC_BASE_URL,
)
from .models import AIGeneration


SYSTEM = """Ты — методист корпоративного обучения HoReCa. Создавай только черновики, которые менеджер обязан проверить. Не выдумывай факты о меню, аллергенах, технологиях, составе или правилах: используй только входные материалы. Если данных недостаточно — укажи это в warnings и не заполняй пробел догадкой.

ТРЕБОВАНИЯ К ВОПРОСАМ:
1. Целевой банк полноценного курса — до 100 качественных вопросов; не раздувай банк повторами, если материалов недостаточно.
2. Ориентир по типам для банка: knowledge 40%, understanding 25%, sales 20%, scenario 15%.
3. Каждый вопрос должен проверять конкретное знание, понимание или решение, а не угадываться по здравому смыслу.
4. Все 4 варианта ответа должны быть правдоподобными, одинакового уровня конкретности и близкими по длине. Неправильные варианты должны отражать реальные вероятные ошибки сотрудника.
5. Запрещены очевидные дистракторы вроде «ничего», «неважно», «игнорировать всё», «спорить с гостем», если они резко слабее правильного ответа.
6. Не делай правильный ответ системно самым длинным, самым подробным или единственным профессионально сформулированным.
7. Для ситуационных вопросов варианты должны отличаться небольшими, но важными решениями: момент эскалации, приоритет стандарта, формулировка гостю, последовательность действий.
8. Для sales-вопросов проверяй уместность рекомендации и выявление потребности, а не агрессивную продажу.
9. correct_index может быть 0–3; не ставь правильный ответ всегда первым.
10. explanation кратко объясняет, почему правильный вариант верен и чем близкие дистракторы хуже.

Верни ТОЛЬКО валидный JSON без markdown. Структура: {"summary":"","courses":[{"title":"","target_role":"all|bartender|waiter|manager|host|cook|barista|administrator","description":"","lessons":[{"title":"","body":""}],"questions":[{"prompt":"","choices":["","","",""],"correct_index":0,"type":"knowledge|understanding|scenario|sales","explanation":""}]}],"glossary":[{"term":"","definition":"","target_role":"all"}],"warnings":[""]}."""

OUTPUT_SCHEMA = {
    "name": "baros_training_draft",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "summary": {"type": "string"},
            "courses": {
                "type": "array",
                "maxItems": 12,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "title": {"type": "string"},
                        "target_role": {
                            "type": "string",
                            "enum": ["all", "bartender", "waiter", "manager", "host", "cook", "barista", "administrator"],
                        },
                        "description": {"type": "string"},
                        "lessons": {
                            "type": "array",
                            "maxItems": 40,
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "properties": {
                                    "title": {"type": "string"},
                                    "body": {"type": "string"},
                                },
                                "required": ["title", "body"],
                            },
                        },
                        "questions": {
                            "type": "array",
                            "maxItems": 100,
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "properties": {
                                    "prompt": {"type": "string"},
                                    "choices": {
                                        "type": "array",
                                        "minItems": 4,
                                        "maxItems": 4,
                                        "items": {"type": "string"},
                                    },
                                    "correct_index": {"type": "integer", "minimum": 0, "maximum": 3},
                                    "type": {
                                        "type": "string",
                                        "enum": ["knowledge", "understanding", "scenario", "sales"],
                                    },
                                    "explanation": {"type": "string"},
                                },
                                "required": ["prompt", "choices", "correct_index", "type", "explanation"],
                            },
                        },
                    },
                    "required": ["title", "target_role", "description", "lessons", "questions"],
                },
            },
            "glossary": {
                "type": "array",
                "maxItems": 250,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "term": {"type": "string"},
                        "definition": {"type": "string"},
                        "target_role": {
                            "type": "string",
                            "enum": ["all", "bartender", "waiter", "manager", "host", "cook", "barista", "administrator"],
                        },
                    },
                    "required": ["term", "definition", "target_role"],
                },
            },
            "warnings": {"type": "array", "maxItems": 50, "items": {"type": "string"}},
        },
        "required": ["summary", "courses", "glossary", "warnings"],
    },
}


def _clean_result(result):
    if not isinstance(result, dict):
        raise ValueError("AI response must be a JSON object")

    result.setdefault("summary", "")
    result.setdefault("courses", [])
    result.setdefault("glossary", [])
    result.setdefault("warnings", [])

    if not isinstance(result["courses"], list):
        result["courses"] = []
    if not isinstance(result["glossary"], list):
        result["glossary"] = []
    if not isinstance(result["warnings"], list):
        result["warnings"] = [str(result["warnings"])]

    valid_types = {"knowledge", "understanding", "scenario", "sales"}
    valid_roles = {"all", "bartender", "waiter", "manager", "host", "cook", "barista", "administrator"}

    cleaned_courses = []
    for course in result["courses"][:12]:
        if not isinstance(course, dict):
            continue
        course.setdefault("title", "Черновик курса")
        course.setdefault("target_role", "all")
        if course["target_role"] not in valid_roles:
            course["target_role"] = "all"
        course.setdefault("description", "")
        lessons = course.get("lessons", [])
        questions = course.get("questions", [])
        course["lessons"] = [
            {"title": str(x.get("title", "Урок")), "body": str(x.get("body", ""))}
            for x in lessons[:40] if isinstance(x, dict)
        ]
        clean_questions = []
        for q in questions[:120]:
            if not isinstance(q, dict):
                continue
            choices = q.get("choices")
            idx = q.get("correct_index")
            if not isinstance(choices, list) or len(choices) != 4:
                continue
            try:
                idx = int(idx)
            except Exception:
                continue
            if idx not in range(4):
                continue
            qtype = q.get("type", "knowledge")
            if qtype not in valid_types:
                qtype = "knowledge"
            prompt = str(q.get("prompt", "")).strip()
            cleaned_choices = [str(x).strip() for x in choices]
            if not prompt or any(not x for x in cleaned_choices):
                continue
            clean_questions.append({
                "prompt": prompt,
                "choices": cleaned_choices,
                "correct_index": idx,
                "type": qtype,
                "explanation": str(q.get("explanation", "")).strip(),
            })
        course["questions"] = clean_questions
        cleaned_courses.append(course)
    result["courses"] = cleaned_courses

    result["glossary"] = [
        {
            "term": str(x.get("term", "")).strip(),
            "definition": str(x.get("definition", "")).strip(),
            "target_role": x.get("target_role", "all") if x.get("target_role", "all") in valid_roles else "all",
        }
        for x in result["glossary"][:250]
        if isinstance(x, dict) and str(x.get("term", "")).strip() and str(x.get("definition", "")).strip()
    ]
    result["warnings"] = [str(x) for x in result["warnings"][:50]]
    return result


def _decode_json(text: str):
    text = (text or "").strip()
    if not text:
        raise ValueError("AI returned empty content")

    fence = chr(96) * 3
    if text.startswith(fence):
        text = re.sub(r"^" + re.escape(fence) + r"(?:json)?\s*", "", text, flags=re.I)
        text = re.sub(r"\s*" + re.escape(fence) + r"$", "", text)

    # Some models still prepend a sentence even in JSON mode. Recover the JSON
    # object rather than failing the entire generation.
    if not text.startswith("{"):
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            text = text[start:end + 1]

    return _clean_result(json.loads(text))


def _message_text(message: dict) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts)
    return ""


def _provider_candidates():
    openrouter = {
        "provider": "openrouter",
        "key": OPENROUTER_API_KEY,
        "base_url": OPENROUTER_BASE_URL,
        "model": OPENROUTER_MODEL,
        "paid": False,
    }
    vercel = {
        "provider": "vercel-ai-gateway",
        "key": AI_GATEWAY_API_KEY,
        "base_url": AI_GATEWAY_BASE_URL.rstrip("/"),
        "model": AI_MODEL,
        "paid": True,
    }

    provider = AI_PROVIDER
    if provider == "openrouter":
        return [openrouter] if openrouter["key"] else []
    if provider in {"vercel", "vercel-ai-gateway"}:
        return [vercel] if vercel["key"] else []

    if openrouter["key"]:
        result = [openrouter]
        if AI_ALLOW_PAID_FALLBACK and vercel["key"]:
            result.append(vercel)
        return result
    if vercel["key"]:
        return [vercel]
    return []


def get_ai_status():
    candidates = _provider_candidates()
    active = candidates[0] if candidates else None
    return {
        "configured": bool(active),
        "provider": active["provider"] if active else "not-configured",
        "model": active["model"] if active else OPENROUTER_MODEL,
        "mode": "free" if active and not active["paid"] else ("paid" if active else "offline"),
        "daily_limit": AI_DAILY_LIMIT,
        "global_daily_limit": AI_GLOBAL_DAILY_LIMIT,
        "paid_fallback_enabled": bool(AI_ALLOW_PAID_FALLBACK and AI_GATEWAY_API_KEY),
        "openrouter_configured": bool(OPENROUTER_API_KEY),
        "vercel_configured": bool(AI_GATEWAY_API_KEY),
    }


def get_ai_usage(db: Session, organization_id: int):
    since = datetime.utcnow() - timedelta(hours=24)
    counted_statuses = ["pending", "complete", "imported", "error"]
    used = db.scalar(
        select(func.count(AIGeneration.id)).where(
            AIGeneration.organization_id == organization_id,
            AIGeneration.feature == "training_draft",
            AIGeneration.created_at >= since,
            AIGeneration.status.in_(counted_statuses),
        )
    ) or 0
    global_used = db.scalar(
        select(func.count(AIGeneration.id)).where(
            AIGeneration.feature == "training_draft",
            AIGeneration.created_at >= since,
            AIGeneration.status.in_(counted_statuses),
        )
    ) or 0
    remaining = max(0, AI_DAILY_LIMIT - int(used))
    global_remaining = max(0, AI_GLOBAL_DAILY_LIMIT - int(global_used))
    return {
        "used": int(used),
        "limit": AI_DAILY_LIMIT,
        "remaining": remaining,
        "global_used": int(global_used),
        "global_limit": AI_GLOBAL_DAILY_LIMIT,
        "global_remaining": global_remaining,
        "effective_remaining": min(remaining, global_remaining),
        "window_hours": 24,
    }


async def _call_provider(provider: dict, context: str):
    payload = {
        "model": provider["model"],
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": context[:AI_CONTEXT_LIMIT_CHARS]},
        ],
        "temperature": 0.2,
        "max_tokens": 24000,
        "response_format": {
            "type": "json_schema",
            "json_schema": OUTPUT_SCHEMA,
        },
    }
    headers = {
        "Authorization": f"Bearer {provider['key']}",
        "Content-Type": "application/json",
    }
    if provider["provider"] == "openrouter":
        if PUBLIC_BASE_URL:
            headers["HTTP-Referer"] = PUBLIC_BASE_URL
        headers["X-Title"] = "BarOS"
        headers["X-OpenRouter-Metadata"] = "enabled"
        payload["plugins"] = [{"id": "response-healing"}]
        payload["provider"] = {
            "require_parameters": True,
            "allow_fallbacks": True,
        }

    async with httpx.AsyncClient(timeout=180) as client:
        response = await client.post(
            f"{provider['base_url'].rstrip('/')}/chat/completions",
            headers=headers,
            json=payload,
        )
        response.raise_for_status()
        data = response.json()

    choices = data.get("choices") or []
    if not choices:
        raise ValueError(f"AI returned no choices; routed_model={data.get('model','unknown')}")

    choice = choices[0] or {}
    message = choice.get("message") or {}
    result_text = _message_text(message)
    routed_model = data.get("model") or provider["model"]
    finish_reason = choice.get("finish_reason")

    if not result_text.strip():
        raise ValueError(
            f"AI returned empty content; routed_model={routed_model}; finish_reason={finish_reason}"
        )

    result = _decode_json(result_text)
    meta = {
        "usage": data.get("usage", {}),
        "routed_model": routed_model,
        "finish_reason": finish_reason,
        "openrouter_metadata": data.get("openrouter_metadata", {}),
    }
    return result, meta


async def generate_training_draft(
    db: Session,
    organization_id: int,
    user_id: int | None,
    context: str,
):
    gid = uuid.uuid4().hex
    candidates = _provider_candidates()
    status = get_ai_status()

    if not candidates:
        rec = AIGeneration(
            id=gid,
            organization_id=organization_id,
            user_id=user_id,
            feature="training_draft",
            model=status["model"],
            prompt=context,
            status="disabled",
        )
        rec.result = json.dumps({
            "summary": "AI-методист ещё не подключён.",
            "courses": [],
            "glossary": [],
            "warnings": ["Добавьте OPENROUTER_API_KEY. Бесплатный OpenRouter будет использоваться первым."],
        }, ensure_ascii=False)
        db.add(rec)
        db.commit()
        return gid, json.loads(rec.result)

    usage = get_ai_usage(db, organization_id)
    if usage["effective_remaining"] <= 0:
        rec = AIGeneration(
            id=gid,
            organization_id=organization_id,
            user_id=user_id,
            feature="training_draft",
            model=f"{status['provider']}:{status['model']}",
            prompt=context,
            status="limited",
        )
        rec.result = json.dumps({
            "summary": "Дневной лимит AI-методиста исчерпан.",
            "courses": [],
            "glossary": [],
            "warnings": [f"Лимит staging: {AI_DAILY_LIMIT} генераций на заведение и {AI_GLOBAL_DAILY_LIMIT} на всю платформу за 24 часа."],
        }, ensure_ascii=False)
        db.add(rec)
        db.commit()
        return gid, json.loads(rec.result)

    first = candidates[0]
    rec = AIGeneration(
        id=gid,
        organization_id=organization_id,
        user_id=user_id,
        feature="training_draft",
        model=f"{first['provider']}:{first['model']}",
        prompt=context,
        status="pending",
    )
    db.add(rec)
    db.commit()

    errors = []
    attempt_log = []
    for provider_index, provider in enumerate(candidates):
        max_attempts = 2 if provider["provider"] == "openrouter" else 1
        for attempt in range(1, max_attempts + 1):
            try:
                result, call_meta = await _call_provider(provider, context)
                rec.model = f"{provider['provider']}:{call_meta.get('routed_model') or provider['model']}"
                rec.status = "complete"
                rec.result = json.dumps(result, ensure_ascii=False)
                attempt_log.append({
                    "provider": provider["provider"],
                    "requested_model": provider["model"],
                    "routed_model": call_meta.get("routed_model"),
                    "attempt": attempt,
                    "finish_reason": call_meta.get("finish_reason"),
                    "status": "complete",
                    "usage": call_meta.get("usage", {}),
                })
                rec.usage_json = json.dumps({
                    "provider": provider["provider"],
                    "requested_model": provider["model"],
                    "routed_model": call_meta.get("routed_model"),
                    "attempts": attempt_log,
                    "fallback_used": provider_index > 0,
                }, ensure_ascii=False)
                rec.error = ""
                db.commit()
                return gid, result
            except Exception as exc:
                err = f"{provider['provider']} attempt {attempt}: {type(exc).__name__}: {exc}"
                errors.append(err)
                attempt_log.append({
                    "provider": provider["provider"],
                    "requested_model": provider["model"],
                    "attempt": attempt,
                    "status": "error",
                    "error": f"{type(exc).__name__}: {exc}"[:1000],
                })

    rec.status = "error"
    rec.error = "\n".join(errors)[:4000]
    rec.usage_json = json.dumps({"attempts": attempt_log}, ensure_ascii=False)
    result = {
        "summary": "AI-методист не смог завершить генерацию.",
        "courses": [],
        "glossary": [],
        "warnings": [
            "Черновик не был импортирован. Проверьте подключение AI-провайдера или попробуйте ещё раз позже."
        ],
    }
    rec.result = json.dumps(result, ensure_ascii=False)
    db.commit()
    return gid, result
