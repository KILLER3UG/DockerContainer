FROM node:22-slim
WORKDIR /app
# Install uv/uvx plus Python for Python-based MCP servers such as MiniMax and fetch.
RUN apt-get update && apt-get install -y curl ca-certificates python3 git sqlite3 && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL="/usr/local/bin" sh
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
