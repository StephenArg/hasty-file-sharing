FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY frontend/package*.json ./frontend/

# Install dependencies
RUN npm install
WORKDIR /app/frontend
RUN npm install

# Build frontend
WORKDIR /app
COPY . .
WORKDIR /app/frontend
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy built frontend
COPY --from=builder /app/frontend/dist ./public

# Copy backend code
COPY backend ./backend

# Create necessary directories
RUN mkdir -p /app/data /app/uploads

# Install curl for healthcheck
RUN apk add --no-cache curl

EXPOSE 3000

CMD ["node", "backend/server.js"]

