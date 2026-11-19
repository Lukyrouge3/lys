# Matches the Deno version the project is developed against (deno.lock).
FROM denoland/deno:2.9.8

WORKDIR /app

# The Prisma generator writes into /app, which the base image does not
# make writable for its default `deno` user.
USER root
RUN chown deno:deno /app
USER deno

# Warm the module cache before any source lands, so source edits do not
# re-download dependencies. --frozen fails the build loudly if
# deno.lock is out of sync instead of mutating it inside the image.
COPY deno.json deno.lock ./
RUN deno install --frozen

# The Prisma client is generated, never committed (see .gitignore), so
# the image builds it from the schema. prisma7.config.ts is kept for
# `prisma migrate deploy` at container start.
COPY prisma7.config.ts ./
COPY prisma ./prisma
RUN deno run -A npm:prisma generate

COPY src ./src
# Fail the build on type errors, including in the generated client.
RUN deno check src/

CMD ["deno", "run", "-A", "src/main.ts", "--discord"]
