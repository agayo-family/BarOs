# BarOS 2.0

BarOS — светлая premium-платформа обучения для баров и ресторанов: материалы заведения, теория, тесты, роли, должности, уведомления и аналитика в одном адаптивном PWA.

## Что уже работает

- владелец платформы: заведения, тариф/статус/лимиты, удалённый доступ, одноразовые ссылки управляющих и журнал действий;
- управляющий: команда, несколько должностей сотрудника, приглашение по коду, интервью о заведении, материалы, черновики курсов, публикация и отчёты;
- сотрудник: самостоятельная регистрация по коду, теория перед тестом, случайная выборка вопросов, перемешанные ответы, таймер, попытки, баллы, разбор ошибок и история;
- загрузка TXT/MD/CSV/TSV/PDF/DOCX/XLSX/PNG/JPG/WebP до 15 МБ с извлечением текста и OCR;
- бесплатный AI через OpenRouter (`openrouter/free`): пошаговая генерация теории и банка 100–400 вопросов, source-grounding, защита от повторов, сохранение прогресса и повтор после сбоя;
- in-app и Web Push уведомления о новом курсе, дедлайне и просрочке;
- PWA-манифест, service worker, responsive-интерфейс для телефонов, планшетов и мониторов.

AI всегда создаёт черновик. Управляющий обязан проверить факты, теорию и ответы перед публикацией.

## Локальный запуск

```bash
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # optional
uvicorn baros.main:app --reload --host 0.0.0.0 --port 8000
```

Откройте `http://localhost:8000/first-run?token=<FIRST_RUN_TOKEN>` и создайте владельца. Для production задайте PostgreSQL, длинный `SESSION_SECRET`, `FIRST_RUN_TOKEN` и `COOKIE_SECURE=1`.

## Восстановление владельца

Если забыты логин и пароль, откройте `/owner-recovery`. В Render → `baros-staging` → Environment
скопируйте `FIRST_RUN_TOKEN` (случайный секрет длиной от 24 символов) и введите его **только на сайте**.
Если ключ отсутствует, слишком короткий или уже использован, задайте новый случайный ключ в Render
и сохраните с перезапуском сервиса. На странице восстановления задайте новый логин и пароль от 12 символов.
Ключ используется один раз; прежние сеансы владельца отзываются. Существующий аккаунт, заведения,
сотрудники и обучение сохраняются. Ключи и пароли не передавайте в чат и не включайте в URL.

## AI без платного fallback

```env
OPENROUTER_API_KEY=...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=openrouter/free
AI_ALLOW_PAID_FALLBACK=0
```

Платный fallback выключен по умолчанию. Лимиты `AI_DAILY_LIMIT`, `AI_GLOBAL_DAILY_LIMIT` и `AI_PROVIDER_DAILY_CALL_LIMIT` ограничивают расход и нагрузку.

## Деплой Render

`render.yaml` содержит web service и PostgreSQL. После создания сервиса добавьте секреты `FIRST_RUN_TOKEN` и `OPENROUTER_API_KEY` в Render Dashboard. Healthcheck: `/health`.

Загрузка хранится в PostgreSQL вместе с извлечённым текстом, поэтому перезапуск бесплатного инстанса не теряет исходник. Для больших production-файлов рекомендуется object storage и отдельный worker.

## Проверки

```bash
python -m compileall -q baros
python -m unittest discover -s tests -v
for f in baros/static/v2/*.js; do node --input-type=module --check < "$f"; done
git diff --check
```
