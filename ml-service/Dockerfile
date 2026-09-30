# Multi-stage Dockerfile for Load Forecasting ML Service

# Stage 1: Builder
FROM python:3.11-slim as builder

WORKDIR /build

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    make \
    libhdf5-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir --user -r requirements.txt

# Stage 2: Runtime
FROM python:3.11-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    libgomp1 \
    libhdf5-103 \
    && rm -rf /var/lib/apt/lists/*

# Copy Python packages from builder
COPY --from=builder /root/.local /root/.local

# Make sure scripts in .local are usable
ENV PATH=/root/.local/bin:$PATH

# Copy application code
COPY src/ ./src/
COPY scripts/ ./scripts/

# Create directories
RUN mkdir -p models data logs

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV FLASK_APP=src/prediction_service.py
ENV ML_SERVICE_PORT=5000

# Expose port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD python -c "import requests; requests.get('http://localhost:5000/health', timeout=5)"

# Default command
CMD ["python", "src/prediction_service.py", "--host", "0.0.0.0", "--port", "5000"]
