import axios from 'axios';

const client = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': import.meta.env.VITE_DASHBOARD_API_KEY
  }
});

export default client;
