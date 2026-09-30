import json, uuid
import httpx
from sqlalchemy.orm import Session
from .config import AI_GATEWAY_API_KEY, AI_GATEWAY_BASE_URL, AI_MODEL
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

Верни ТОЛЬКО валидный JSON без markdown. Структура: {"summary":"","courses":[{"title":"","target_role":"all|bartender|waiter|manager|host|cook|barista","description":"","lessons":[{"title":"","body":""}],"questions":[{"prompt":"","choices":["","","",""],"correct_index":0,"type":"knowledge|understanding|scenario|sales","explanation":""}]}],"glossary":[{"term":"","definition":"","target_role":"all"}],"warnings":[""]}."""

async def generate_training_draft(db: Session, organization_id: int, user_id: int | None, context: str):
    gid = uuid.uuid4().hex
    rec = AIGeneration(id=gid, organization_id=organization_id, user_id=user_id, feature="training_draft", model=AI_MODEL, prompt=context, status="pending")
    db.add(rec); db.commit()
    if not AI_GATEWAY_API_KEY:
        rec.status = "disabled"
        rec.result = json.dumps({"summary":"AI не подключён. Добавьте AI_GATEWAY_API_KEY — архитектура и сохранение генераций уже готовы.","courses":[],"glossary":[],"warnings":["Черновик не создан без AI-ключа."]}, ensure_ascii=False)
        db.commit()
        return gid, json.loads(rec.result)
    try:
        payload = {
            "model": AI_MODEL,
            "messages": [
                {"role":"system","content":SYSTEM},
                {"role":"user","content":context[:120000]},
            ],
            "temperature": 0.2,
        }
        headers = {"Authorization": f"Bearer {AI_GATEWAY_API_KEY}", "Content-Type":"application/json"}
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(f"{AI_GATEWAY_BASE_URL.rstrip('/')}/chat/completions", headers=headers, json=payload)
            r.raise_for_status()
            data = r.json()
        text = data["choices"][0]["message"]["content"]
        result = json.loads(text)
        rec.status = "complete"
        rec.result = json.dumps(result, ensure_ascii=False)
        rec.usage_json = json.dumps(data.get("usage", {}), ensure_ascii=False)
        db.commit()
        return gid, result
    except Exception as e:
        rec.status = "error"; rec.error = str(e); db.commit()
        raise
