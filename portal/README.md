# ICC Portal (MSP multi-tenant portal)

Central portal for MSP teams running multiple Infrastructure Command Center
instances (one instance per customer). The portal keeps a tenant directory,
polls each instance's `/api/ops/summary` every 5 minutes (server-side, using
that instance's `DASHBOARD_API_KEY`), and shows a cross-customer rollup.
Clicking a tenant opens that instance's own UI (instance login applies).

## Setup

```bash
cd Portal
cp .env.example .env        # set ENCRYPTION_KEY (32-byte hex) and PORT
cd backend && npm install
cd ../frontend && npm install && npx vite build
cd ../backend && node server.js
```

First boot with no users prints a claim token in the log — enter it at the
login page to create the admin account. Additional users: Users page, or
`node backend/scripts/create-user.js <user> <pass>`.

Register tenants on the Tenants page: name, instance URL, and that
instance's `DASHBOARD_API_KEY` (stored AES-256-GCM encrypted; only ever used
server-side — the browser never sees it).

## pm2

```bash
pm2 start backend/server.js --name icc-portal
```
