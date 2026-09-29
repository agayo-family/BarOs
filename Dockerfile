FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN mkdir -p /var/data/uploads
ENV UPLOAD_DIR=/var/data/uploads
EXPOSE 10000
CMD ["sh", "-c", "uvicorn baros.main:app --host 0.0.0.0 --port ${PORT:-10000}"]
