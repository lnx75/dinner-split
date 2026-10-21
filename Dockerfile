FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app

# The application uses only Node.js built-in modules.
COPY package.json server.mjs auth.mjs ./
COPY public ./public
COPY scripts ./scripts

# New named volumes inherit these directory permissions. Bind mounts must be
# prepared by the operator for UID/GID 1000 instead.
RUN mkdir -p /app/data \
    && chown node:node /app/data \
    && chmod 700 /app/data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/state', { signal: AbortSignal.timeout(4000) }).then(response => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
