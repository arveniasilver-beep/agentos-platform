# Build the single-file bundle, then run it on a tiny node image. app.ts has ZERO runtime deps
# (node builtins only), so the runtime image is just node + dist/server.js.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-save esbuild@^0.24.0
COPY tsconfig.json ./
COPY src ./src
RUN npx esbuild src/server.ts --bundle --platform=node --format=esm --target=node20 \
    --outfile=dist/server.js \
    --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
ENV HOSTING_DATA_DIR=/data/sites \
    PORT=8080
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "dist/server.js"]
