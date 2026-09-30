# Stealthpad warden: indexer, attester and keeper in one process. Keys and DATABASE_URL arrive as runtime
# env (--env-file); nothing secret is copied into the image.
FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN chown -R node:node /app
USER node
CMD ["node_modules/.bin/tsx", "src/main.ts"]
