FROM node:20-bookworm

WORKDIR /app

COPY workers/report-worker/package.json workers/report-worker/package-lock.json* ./
RUN npm install
RUN npx playwright install --with-deps chromium

COPY workers/report-worker/ ./
RUN npm run build

CMD ["npm", "run", "start"]
