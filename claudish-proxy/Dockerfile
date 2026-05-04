FROM node:20-slim
WORKDIR /app
# Install curl to download uv, and python3 for minimax mcp
RUN apt-get update && apt-get install -y curl python3 git && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL="/usr/local" sh
RUN npm install http-proxy @modelcontextprotocol/sdk
RUN git clone https://github.com/olbboy/claudekit-blender-mcp.git /app/claudekit-blender-mcp
RUN cd /app/claudekit-blender-mcp && npm install && npm run build
COPY src/ ./src/
COPY docs/ ./docs/
COPY scripts/ ./scripts/
COPY tests/ ./tests/
COPY request-log.json/ ./request-log.json/
EXPOSE 8080
CMD ["node", "src/bridge.js"]
