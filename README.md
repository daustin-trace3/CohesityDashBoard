# Cohesity Dashboard

A web dashboard for monitoring Cohesity clusters — supports Helios multi-cluster and direct cluster connections with API key or username/password auth.

## Setup

### 1. Copy and configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and set:

- `ENCRYPTION_KEY` — 32-byte hex string used to encrypt stored credentials. Generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `HELIOS_API_KEY` — Your Helios API key (if using Helios connection type)
- `DASHBOARD_API_KEY` — API key required for all `/api/` requests. Generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
  ```
  **Important:** The same value must be set in both `.env` (as `DASHBOARD_API_KEY`) and `frontend/.env.local` (as `VITE_DASHBOARD_API_KEY`).
- `PORT` — Backend port (default: 3001)

### 2. Install dependencies

```bash
npm run setup
```

### 3. Start the application

```bash
npm start
```

This starts:
- **Backend** on `http://localhost:3001`
- **Frontend** on `http://localhost:5173`

### 4. Open the dashboard

Navigate to [http://localhost:5173](http://localhost:5173)

## Adding Clusters

1. Go to **Cluster Management** in the sidebar
2. Click **Add Cluster**
3. Choose connection type:
   - **Helios** — uses `HELIOS_API_KEY` from `.env`
   - **Direct** — enter the cluster VIP/hostname
4. Choose auth type (API Key or Username/Password)
5. Set polling interval (minimum 5 minutes)

## Features

- **Dashboard** — Grid view of all clusters with storage utilization, alert counts, software version
- **Alerts** — Full alert list with severity filtering, dismiss support
- **Hardware** — Node details per cluster (model, firmware, status)
- **Cluster Management** — Add/edit/delete cluster configurations

## Security Notes

- Credentials are encrypted with AES-256-GCM before being stored in SQLite
- The `ENCRYPTION_KEY` is never exposed in API responses
- All Cohesity API calls use `rejectUnauthorized: false` to handle self-signed certificates
- Session tokens (userpass auth) are cached in memory with a 20-minute TTL
