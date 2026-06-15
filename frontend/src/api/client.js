import axios from 'axios';

const client = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': import.meta.env.VITE_DASHBOARD_API_KEY
  }
});

// ── Global network activity tracking ─────────────────────────────────────────
// Components (GlobalLoadingBar) subscribe to the in-flight request count so the
// UI can always tell the user when data is being fetched in the background.
let inFlight = 0;
const listeners = new Set();

function notify() {
  for (const fn of listeners) fn(inFlight);
}

export function subscribeNetworkActivity(fn) {
  listeners.add(fn);
  fn(inFlight);
  return () => listeners.delete(fn);
}

client.interceptors.request.use((config) => {
  inFlight += 1;
  notify();
  return config;
});

client.interceptors.response.use(
  (response) => {
    inFlight = Math.max(0, inFlight - 1);
    notify();
    return response;
  },
  (error) => {
    inFlight = Math.max(0, inFlight - 1);
    notify();
    return Promise.reject(error);
  }
);

export default client;
