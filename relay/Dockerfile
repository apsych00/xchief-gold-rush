FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
