FROM node:20-slim

# Install git and Chromium dependencies (git is required by Baileys/libsignal)
RUN apt-get update && apt-get install -y \
    git \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    curl \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Force git to use HTTPS instead of SSH for GitHub repos
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" && \
    git config --global url."https://github.com/".insteadOf "git@github.com:"

# Set Puppeteer to use installed Chromium (if needed by any dep)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files first (for Docker layer caching)
COPY whatsapp-gateway/package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy the rest of the gateway source
COPY whatsapp-gateway/ ./

# Create data directories
RUN mkdir -p /app/data /app/auth_session /app/uploads

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
