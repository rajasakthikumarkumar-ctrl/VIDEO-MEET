# ============================================================
# Stage 1: Install dependencies
# ============================================================
FROM node:18-alpine AS deps

WORKDIR /app

# Copy dependency manifests first (layer cache optimization)
COPY package*.json ./

# Install only production dependencies
RUN npm ci --frozen-lockfile --only=production

# ============================================================
# Stage 2: Production runtime (minimal, secure image)
# ============================================================
FROM node:18-alpine AS runner

# Install dumb-init for proper signal handling and PID 1 management
RUN apk add --no-cache dumb-init

# Create a non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodeuser -u 1001 -G nodejs

WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps --chown=nodeuser:nodejs /app/node_modules ./node_modules

# Copy application source
COPY --chown=nodeuser:nodejs . .

# Switch to non-root user
USER nodeuser

# Expose the server port (matches PORT env var default)
EXPOSE 5001

# Health check: verify the server is responding on /api/rooms
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:5001/api/rooms || exit 1

# Use dumb-init as PID 1 to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
