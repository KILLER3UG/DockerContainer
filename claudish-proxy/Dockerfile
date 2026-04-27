FROM node:20-slim
WORKDIR /app
RUN npm install http-proxy
COPY bridge.js config.json ui.html ./
COPY adapters/ ./adapters/
COPY utils/ ./utils/
EXPOSE 8080
CMD ["node", "bridge.js"]
