FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 \
  python3-pip \
  python3-venv \
  git \
  ca-certificates \
  curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080
ENV PUBLIC_APP_URL=https://faconmodshosting.ai.studio
ENV CUSTOM_DOMAIN=faconmodshosting.ai.studio

EXPOSE 8080

CMD ["npm", "start"]
