FROM oven/bun:1.3.10-alpine

WORKDIR /app

RUN apk add --no-cache python3 py3-pip && \
    pip3 install --no-cache-dir --break-system-packages "apprise>=1.9.0,<2"

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY test ./test

ENV PORT=8787
ENV HOST=0.0.0.0

EXPOSE 8787

CMD ["bun", "run", "start:node"]
