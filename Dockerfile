# syntax=docker/dockerfile:1
# ── md3-open: Next.js app image ───────────────────────────────────────────────
# A reference image you are meant to fork. Two stages: build the app, then a lean
# runtime that runs `prisma db push` (idempotent schema sync) before `next start`.
# See docker-compose.yml for the Postgres + app wiring and the optional
# LocalEvidence service. The kit's grounded-card seeding is gated on env vars
# (LE_LEDGER_PATH), so this image runs fine with or without LocalEvidence.

# ── build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Install against the lockfile for reproducible builds (devDeps included — the
# prisma CLI is needed at boot for `prisma db push`).
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# `npm run build` = `prisma generate && next build`. A placeholder DATABASE_URL
# satisfies the `process.env.DATABASE_URL!` reads; generation/build do not
# connect to a database. If your pages query the DB at build time, mark them
# dynamic or supply a real DATABASE_URL build arg.
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── runtime stage ───────────────────────────────────────────────────────────--
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# No standalone output is configured, so carry the whole built app: it includes
# the generated Prisma client + the prisma CLI used by the boot db-push.
COPY --from=build /app ./

EXPOSE 3000

# Idempotent schema sync (retried until the DB is reachable, so a plain
# `docker run` against a still-initialising DB waits instead of crash-looping —
# compose already gates this on a healthcheck), then serve. Seed separately, once:
#   docker compose run --rm app npm run seed
CMD ["sh", "-c", "until npx prisma db push --skip-generate; do echo 'waiting for database...'; sleep 2; done && npm run start -- -H 0.0.0.0 -p 3000"]
