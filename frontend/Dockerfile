# Build multi-stage do frontend Angular. Imagem final serve os estaticos via Nginx.

# 1) Build: gera os estaticos em dist/frontend/browser (builder `application`).
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# 2) Runtime: Nginx servindo o bundle estatico.
FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/frontend/browser /usr/share/nginx/html
EXPOSE 80
