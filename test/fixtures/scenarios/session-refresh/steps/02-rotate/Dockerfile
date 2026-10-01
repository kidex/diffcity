FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV SESSION_TTL_MS=900000
HEALTHCHECK CMD wget -q -O /dev/null http://localhost:8080/health || exit 1
CMD ["node", "src/server.js"]
