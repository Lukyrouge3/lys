# The Typst compiler, fetched once and copied into the bot image. Pinned to
# 0.15.1 and to the checksum GitHub publishes for the static release asset:
# the same binary the owner's ~/job/typst workflow runs as
# ghcr.io/typst/typst:0.15.1. The bot is itself a container and cannot reach
# the host's Docker daemon, so it carries the compiler instead of calling out.
FROM denoland/deno:2.9.8 AS typst

ARG TYPST_VERSION=0.15.1
ARG TYPST_SHA256=a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
  && curl -fsSL -o /tmp/typst.tar.xz \
    "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz" \
  && echo "${TYPST_SHA256}  /tmp/typst.tar.xz" | sha256sum -c - \
  && tar -xJf /tmp/typst.tar.xz -C /opt --strip-components=1 \
    typst-x86_64-unknown-linux-musl/typst \
  && rm /tmp/typst.tar.xz \
  && /opt/typst --version

# Matches the Deno version the project is developed against (deno.lock).
FROM denoland/deno:2.9.8

WORKDIR /app

# pdfinfo and pdftotext, from poppler-utils like ~/job/typst/inspect.sh: the
# prep smoke test and the one-page gate read a compiled PDF through them.
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

COPY --from=typst /opt/typst /usr/local/bin/typst

# The Prisma generator writes into /app, which the base image does not
# make writable for its default `deno` user.
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

# Fonts, vendored @preview packages and the base CV/cover templates, copied
# from ~/job/typst (see assets/typst/README.md). Before src/ so editing the
# bot does not invalidate them.
COPY assets ./assets

COPY src ./src
# Fail the build on type errors, including in the generated client.
RUN deno check src/

CMD ["deno", "run", "-A", "src/main.ts", "--discord"]
