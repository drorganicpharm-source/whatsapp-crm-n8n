FROM node:20-slim

# Install git + Chromium for whatsapp-web.js puppeteer
RUN apt-get update && apt-get install -y \
    git \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Force HTTPS for git (fix Baileys/libsignal SSH issue)
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" && \
    git config --global url."https://github.com/".insteadOf "git@github.com:"

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files and install deps
COPY whatsapp-gateway/package*.json ./
RUN npm install --omit=dev

# Copy all app files
COPY whatsapp-gateway/ .

# Create required directories
RUN mkdir -p /app/data /app/session /app/uploads

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
