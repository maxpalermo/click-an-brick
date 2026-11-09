#!/bin/sh
set -e
# First boot only: download the LDraw parts library into the volume (idempotent).
if [ ! -d /app/brickyard-server/ldraw/ldraw/parts ]; then
  (cd /app/brickyard-server && node dist/setup-ldraw.js) || echo "WARN: LDraw setup failed, retry at next boot"
fi
(cd /app/brickyard-server && exec node dist/index.js) &
cd /app
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
