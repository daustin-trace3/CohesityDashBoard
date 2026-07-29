import axios from 'axios';

const client = axios.create({ baseURL: '/api' });

export function setCsrfToken(token) {
  if (token) client.defaults.headers.common['x-csrf-token'] = token;
  else delete client.defaults.headers.common['x-csrf-token'];
}

export default client;
