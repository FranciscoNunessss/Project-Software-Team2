# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm AS dependencies
COPY --from=ghcr.io/astral-sh/uv:0.10.12 /uv /usr/local/bin/uv
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy
WORKDIR /build
COPY pyproject.toml uv.lock README.md ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev

FROM python:3.12-slim-bookworm AS runtime
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ADAPTAI_CREDENTIALS_KEY_PATH=/data/adaptai.credentials.key
WORKDIR /app
RUN groupadd --system --gid 10001 adaptai \
    && useradd --system --uid 10001 --gid adaptai --create-home adaptai \
    && install -d -o adaptai -g adaptai -m 0700 /data
COPY --from=dependencies /opt/venv /opt/venv
COPY backend/app ./backend/app
COPY backend/migrations ./backend/migrations
COPY backend/migration_tools ./backend/migration_tools
COPY backend/rubric ./backend/rubric
COPY backend/data/catalogue ./backend/data/catalogue
COPY scripts/migrate_sqlite_to_postgres.py scripts/migrate_privacy.py ./scripts/
COPY --chmod=755 backend/docker-entrypoint.sh /usr/local/bin/adaptai
USER adaptai
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.getenv('PORT','8000')+'/api/health',timeout=3).close()"
ENTRYPOINT ["adaptai"]
