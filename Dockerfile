FROM node:20-slim

# Install git (needed for MCP and git operations)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (cache layer)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
RUN npm run build

# Runtime
EXPOSE 3001
ENV NODE_ENV=production
CMD ["node", "dist/server/server.js"]
