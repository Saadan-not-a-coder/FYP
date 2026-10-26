FROM python:3.11-slim

# Avoid writing .pyc files and enable unbuffered logging
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install dependencies first (leverages Docker layer cache)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY ml_service.py .

# Render dynamically assigns $PORT; default to 8000 for local runs
ENV PORT=8000
EXPOSE 8000

# Use sh -c so the shell expands $PORT
CMD ["sh", "-c", "uvicorn ml_service:app --host 0.0.0.0 --port ${PORT}"]
