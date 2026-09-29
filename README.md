# BarOS server v0.3

Working multi-device pilot for restaurant/bar staff onboarding and certification.

## Run locally

```bash
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # optional
uvicorn baros.main:app --reload --host 0.0.0.0 --port 8000
```

Open http://localhost:8000. On the first launch create the owner account.

## Production

Set `DATABASE_URL` to PostgreSQL. SQLite is only the default for a single-server pilot.
Set a strong `SESSION_SECRET`. For horizontal scaling, move uploaded files to object storage (S3/Vercel Blob); the storage adapter is isolated in `baros/storage.py`.

## AI

Set `AI_GATEWAY_API_KEY`. The app calls the Vercel AI Gateway OpenAI-compatible endpoint and saves every generation to the database. The model is configured by `AI_MODEL`.
AI output is always a draft: a manager must review and publish it.

## Supported uploads

TXT, MD, CSV, TSV, PDF, DOCX, XLSX. Text is extracted server-side and stored with the document record for course generation.


## Cloud staging (Render)

The staging configuration is prepared in `render.yaml`:
- free Docker web service
- free managed PostgreSQL via `DATABASE_URL`
- `/health` endpoint
- secure session cookies
- protected first-run with `FIRST_RUN_TOKEN`

For the free staging tier, raw uploaded files are written only to `/tmp` and may disappear when the service restarts. The extracted text/metadata used by BarOS and AI remain in PostgreSQL. Before production, switch raw-file persistence to object storage.

Open the initial setup URL as:
`https://<staging-host>/first-run?token=<FIRST_RUN_TOKEN>`

Do not publish or share the setup token. After the owner is created, `/first-run` closes automatically.
