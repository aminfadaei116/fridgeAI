# Cloudflare Containers image for the fridge agent.
#
# The app ships whole: FastAPI serves the API and also the dashboard in frontend/, so there
# is one container, one origin and no CORS. The Worker in worker/index.ts proxies every
# request here.
#
# The camera cannot work in a datacenter, so DoorWatcher.start() reports "camera 0 would not
# open" and the way in is the dashboard's simulate-cycle upload and manual add. Those run the
# same process_cycle() the camera drives (backend/pipeline.py), so nothing here is a mock.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app \
    HOME=/home/user

# opencv-python-headless links against glib, which python:*-slim does not ship.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 user

WORKDIR /app
COPY --chown=user:user . /app

# Editable, not a regular install: backend/config.py derives REPO_ROOT from its own location,
# and frontend/, data/ and var/ all have to sit beside it. A site-packages install would move
# REPO_ROOT away from the frontend and drop data/ entirely, since pyproject only declares
# backend* as packages.
RUN pip install --no-cache-dir -e . \
    && mkdir -p /app/var/frames \
    && chown -R user:user /app

USER user

# Bump this (or pass --build-arg BUILD_REV=...) to force a new image digest.
#
# That matters because a Worker redeploy reattaches to an already-running container instead
# of restarting it, and `envVars` from worker/index.ts are only read when a container starts.
# A new digest is an effective container config change, which is what makes wrangler roll the
# running instance - so this is the supported way to make a container pick up new secrets.
#
# It sits after the pip layer on purpose: only this final, tiny layer is invalidated.
ARG BUILD_REV=2
ENV BUILD_REV=${BUILD_REV}

EXPOSE 8080

CMD ["fridge", "serve", "--host", "0.0.0.0", "--port", "8080"]
