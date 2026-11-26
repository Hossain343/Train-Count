# Train Count — تصویر بسیار کوچک، بدون هیچ وابستگی npm
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY web ./web

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "server.js"]
