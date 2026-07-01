FROM node:20-slim

# Install git and openssh for Baileys dependency (libsignal-node)
RUN apt-get update && apt-get install -y \
    git \
    openssh-client \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Configure git to use HTTPS instead of SSH for GitHub
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" && \
    git config --global url."https://github.com/".insteadOf "git@github.com:"

WORKDIR /app

# Copy package files and install
COPY whatsapp-gateway/package*.json ./
RUN npm install --omit=dev

# Copy all source files
COPY whatsapp-gateway/ .

# Create data directories
RUN mkdir -p /app/data /app/auth_session /app/uploads

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
