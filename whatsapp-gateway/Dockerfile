FROM node:20-slim

# Baileys needs basic build tools for some optional native deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

# Persisted WhatsApp session data (mount a Railway Volume on this path from the dashboard:
# Service -> Settings -> Volumes -> Mount Path: /app/auth_info)
RUN mkdir -p /app/auth_info

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
