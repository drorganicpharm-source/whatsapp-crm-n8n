FROM node:20-slim

# Baileys needs basic build tools for some optional native deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    git \
    ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && git config --global url."https://".insteadOf "git://"

COPY whatsapp-gateway/package.json ./
RUN npm install --omit=dev

COPY whatsapp-gateway/server.js ./

# Persisted WhatsApp session data (mount a Railway Volume on this path from the dashboard:
# Service -> Settings -> Volumes -> Mount Path: /app/auth_info)
RUN mkdir -p /app/auth_info

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
