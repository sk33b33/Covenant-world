# The zone server is a long-lived process holding the live world in memory, so
# it needs a container host — not a serverless platform. See docs/DEPLOY.md.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json

# tsx runs the server directly, so the dev dependencies are needed at runtime.
RUN npm ci --include=dev

COPY server server
COPY client client

ENV PORT=2567
EXPOSE 2567

CMD ["npm", "start", "--workspace", "@covenant-world/server"]
