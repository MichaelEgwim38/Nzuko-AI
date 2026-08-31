FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
RUN mkdir -p /data && chown -R node:node /data
USER node
ENV PORT=3100
EXPOSE 3100
CMD ["npm", "start"]
