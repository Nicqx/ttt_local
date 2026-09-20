FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
RUN chown -R node:node /app
USER 1000:1000
EXPOSE 8090
CMD ["node", "index.js"]
