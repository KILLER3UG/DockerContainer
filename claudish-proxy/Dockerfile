FROM node:20-slim
WORKDIR /app
# Install curl to download uv, and python3 for minimax mcp
RUN apt-get update && apt-get install -y curl python3 git && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL="/usr/local" sh
RUN npm install http-proxy @modelcontextprotocol/sdk
RUN git clone https://github.com/olbboy/claudekit-blender-mcp.git /app/claudekit-blender-mcp
RUN cd /app/claudekit-blender-mcp && npm install && npm run build
COPY bridge.js config.json ui.html ./
COPY adapters/ ./adapters/
COPY utils/ ./utils/
EXPOSE 8080
CMD ["node", "bridge.js"]
