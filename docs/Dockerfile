# The site as a container for Cloud Run: built once here, then served by node's own http
# server (server.mjs). The design tokens are vendored into src/generated, so this build needs
# nothing from outside docs/ and the build context stays small.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY . .
# The site is served from the root of its own domain, not from a GitHub Pages sub-path.
ARG SITE_BASE=""
ARG SITE_URL="https://hivemind.griiken.com"
ENV SITE_BASE=$SITE_BASE SITE_URL=$SITE_URL
# `npm run build`, not `astro build`: the lifecycle also vendors the design tokens (prebuild)
# and exports llms.txt + the Markdown copies for agents (postbuild step in the script).
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY server.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]
