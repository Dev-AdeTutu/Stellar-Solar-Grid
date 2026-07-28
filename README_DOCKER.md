# Docker Development Setup

This document describes how to run the Stellar Solar Grid backend using Docker Compose.

## Prerequisites

- Docker Desktop (Windows/Mac) or Docker Engine (Linux)
- Docker Compose v2 or later

## Quick Start

1. Clone the repository:

```bash
git clone https://github.com/your-org/stellar-solar-grid.git
cd stellar-solar-grid
```

2. Configure environment variables:

```bash
cp backend/.env.example backend/.env
# Edit backend/.env with your Stellar contract and admin keys
```

3. Start the development stack:

```bash
docker-compose up --build
```

The backend will be available at `http://localhost:3001` and the MQTT broker at `mqtt://localhost:1883`.

## Architecture

The Docker Compose setup includes two services:

| Service   | Description                   | Port                          |
| --------- | ----------------------------- | ----------------------------- |
| `backend` | Node.js REST API server       | 3001                          |
| `mqtt`    | Eclipse Mosquitto MQTT broker | 1883 (MQTT), 9001 (WebSocket) |

## Development Workflow

### View Logs

```bash
docker-compose logs -f
```

To follow logs for a specific service:

```bash
docker-compose logs -f backend
docker-compose logs -f mqtt
```

### Run Commands in Container

```bash
# Open a shell in the backend container
docker-compose exec backend sh

# Run npm commands
docker-compose exec backend npm run dev
```

### Restart Services

```bash
# Restart all services
docker-compose restart

# Restart specific service
docker-compose restart backend
```

## Troubleshooting

### Backend can't connect to MQTT

Ensure the `MQTT_BROKER` environment variable is set to `mqtt://mqtt:1883` (not `localhost`). The backend connects to the MQTT service via Docker's internal network.

### Port already in use

If ports 1883 or 3001 are already in use, modify the port mappings in `docker-compose.yml`:

```yaml
services:
  mqtt:
    ports:
      - "1884:1883" # Map host 1884 to container 1883
  backend:
    ports:
      - "3002:3001" # Map host 3002 to container 3001
```

### Build fails

Ensure you're in the project root directory and have the `.env` file configured:

```bash
ls docker-compose.yml backend/.env
```

## Production Deployment

For production, you should:

1. Use a proper MQTT broker with authentication
2. Configure TLS/SSL for MQTT and API endpoints
3. Use a secrets management system instead of `.env` files
4. Consider using Docker Swarm or Kubernetes for orchestration
