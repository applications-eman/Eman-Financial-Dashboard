FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN rm -f src/*.test.ts src/test-db.ts && addgroup -S app && adduser -S app -G app
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=8s CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "src/server.ts"]
