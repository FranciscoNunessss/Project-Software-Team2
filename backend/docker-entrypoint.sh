#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
    set -- python -m uvicorn app.main:app --app-dir backend \
        --host 0.0.0.0 --port "${PORT:-8000}"
fi
exec "$@"
