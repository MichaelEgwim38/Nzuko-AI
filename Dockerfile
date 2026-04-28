FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=5177

EXPOSE 5177

CMD ["npm", "start"]
