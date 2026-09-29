FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY public ./public
ENV NODE_ENV=production PORT=8787 DATABASE_PATH=/data/applymate.sqlite
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 8787
VOLUME ["/data"]
CMD ["node", "server/index.js"]
