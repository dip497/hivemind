# The site as a container for Cloud Run, served by node's own http server (server.mjs). The site
# and its guide are built before this, by `npm run build` in site/ (the deploy workflow does it),
# because the guide's pages live outside site/, in guide/. The image only carries the result.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY dist ./dist
# Everything the server imports, or the container exits before it listens and Cloud Run can
# only say "the container failed to listen on PORT".
COPY server.mjs byte-range.mjs downloads.mjs redirects.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]
