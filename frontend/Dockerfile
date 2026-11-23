# University Examination Department Management System — frontend image.
# Stage 1 builds the React app, stage 2 serves the static files with nginx
# (SPA fallback so React Router routes work on refresh).
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
# No package-lock.json is shipped for the frontend yet; a plain install is
# used here. After the first local `npm install`, commit package-lock.json
# and change this line to `npm ci` for reproducible builds.
RUN npm install --no-audit --no-fund
COPY . .
# VITE_API_URL is baked into the built JS at build time, so pass it here
# (see docker-compose.yml). Default points at the local backend service.
ARG VITE_API_URL=http://localhost:5000/api
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
