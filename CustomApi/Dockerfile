FROM node:22-alpine

RUN apk add --no-cache git curl

RUN npm install -g @kilocode/cli@latest

WORKDIR /app

COPY kilo.json /root/.config/kilo/kilo.json
COPY .env .

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -s http://localhost:8787/ || exit 1

CMD ["kilo", "serve", "--port", "8787", "--hostname", "0.0.0.0", "--cors", "*", "--print-logs", "--log-level", "DEBUG"]
