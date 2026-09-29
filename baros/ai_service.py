import json, uuid
import httpx
from sqlalchemy.orm import Session
from .config import AI_GATEWAY_API_KEY, AI_GATEWAY_BASE_URL, AI_MODEL
from .models import AIGeneration

SYSTEM = """Ты — методист корпоративного обучения HoReCa. Создавай только черновики, которые менеджер обязан проверить. Не выдумывай факты о меню и технологиях: используй только данные из входных материалов. Верни ТОЛЬКО валидный JSON без markdown. Структура: {\"summary\":\"\",\"courses\":[{\"title\":\"\",\"target_role\":\"all|bartender|waiter|manager|host|cook|barista\",\"description\":\"\",\"lessons\":[{\"title\":\"\",\"body\":\"\"}],\"questions\":[{\"prompt\":\"\",\"choices\":[\"\",\"\",\"\",\"\"],\"correct_index\":0,\"type\":\"knowledge|scenario|sales\",\"explanation\":\"\"}]}],\"glossary\":[{\"term\":\"\",\"definition\":\"\",\"target_role\":\"all\"}],\"warnings\":[\"\"]}."""

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
