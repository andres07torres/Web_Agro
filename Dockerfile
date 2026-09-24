FROM python:3.11.8-slim

WORKDIR /app

# Instalar dependencias del sistema que puedan ser necesarias (como las de PostgreSQL/psycopg2)
RUN apt-get update && apt-get install -y \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copiar requirements e instalar
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copiar el resto del código
COPY . .

# Exponer el puerto
EXPOSE 5000

# Usar gunicorn (como se indica en tu Procfile)
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "main:app"]
