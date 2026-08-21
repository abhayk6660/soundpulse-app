# Base image with Node.js and Python pre-installed
FROM node:20-slim

# Install system dependencies: Python 3, python-is-python3, ffmpeg, curl
RUN apt-get update && apt-get install -y \
    python3 \
    python-is-python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via python pip
RUN python3 -m pip install --break-system-packages yt-dlp

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Ensure temp directory exists
RUN mkdir -p temp_downloads

# Expose server port
EXPOSE 5000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=5000
ENV TEMP_DIR=./temp_downloads

# Start server
CMD ["node", "server.js"]
