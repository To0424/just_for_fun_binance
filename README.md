# Binance BTC Real-Time Monitor

Real-time BTC/USDT price monitoring system with a C++ backend, PostgreSQL database, and Next.js dashboard.

## Architecture

```
Binance WebSocket ──▶ C++ Fetcher ──▶ PostgreSQL ──▶ C++ REST API ──▶ Next.js Dashboard
```

| Service | Tech | Description |
|---------|------|-------------|
| Data Fetcher | C++17, websocketpp, libpq | Streams Binance ticker via WebSocket, stores ticks in PostgreSQL |
| REST API | C++17, cpp-httplib, libpq | Serves JSON endpoints for the dashboard |
| Database | PostgreSQL 16 | Stores timestamped BTC/USDT price data |
| Dashboard | Next.js 14, Recharts, Tailwind | Interactive real-time price chart with candlestick view |

## Quick Start

```bash
docker compose up --build
```

Open **http://localhost:3000** in your browser.

## Services & Ports

| Service | URL |
|---------|-----|
| Dashboard | http://localhost:3000 |
| REST API | http://localhost:8080 |
| PostgreSQL | localhost:5432 |
| pgAdmin | http://localhost:5050 |

**Database credentials:** user `admin`, password `admin123`, database `binance_db`
**pgAdmin login:** email `admin@local.dev`, password `admin123`

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Health check |
| `GET /api/latest` | Latest BTC/USDT price |
| `GET /api/prices?range=1h` | Historical prices (1h, 6h, 24h, 7d, 30d) |
| `GET /api/stats?range=24h` | Aggregated statistics for a time range |

## Project Structure

```
binance_sys/
├── docker-compose.yml
├── db/init.sql
├── cpp-fetcher/        # WebSocket price fetcher
├── cpp-api/            # REST API server
└── frontend/           # Next.js dashboard
```

