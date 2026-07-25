# ============================================================
# Stage 1: Build the React application
# ============================================================
FROM node:18-alpine AS builder

WORKDIR /app

# Copy dependency manifests first (layer cache optimization)
COPY package*.json ./

# Install all dependencies (including devDependencies needed for build)
RUN npm ci --frozen-lockfile

# Copy the rest of the source code
COPY . .

# Build arguments injected at image build time
# These become REACT_APP_* environment variables baked into the static build
ARG REACT_APP_API_BASE
ARG REACT_APP_SOCKET_URL

ENV REACT_APP_API_BASE=$REACT_APP_API_BASE
ENV REACT_APP_SOCKET_URL=$REACT_APP_SOCKET_URL

# Produce optimized production build
RUN npm run build

# ============================================================
# Stage 2: Serve the static build with nginx (minimal image)
# ============================================================
FROM nginx:1.25-alpine

# Remove default nginx static content
RUN rm -rf /usr/share/nginx/html/*

# Copy built assets from builder stage
COPY --from=builder /app/build /usr/share/nginx/html

# Copy custom nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80 for HTTP
EXPOSE 80

# nginx runs in the foreground
CMD ["nginx", "-g", "daemon off;"]
