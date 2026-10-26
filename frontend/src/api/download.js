import client from './client';

/**
 * Fetch a server-built CSV and hand it to the browser as a download.
 * Rejects on any failure so the caller can toast; a JSON error body from the
 * server is unwrapped into the Error message when present.
 */
export async function downloadCsv(path, params, filename, timeout) {
  const config = { params, responseType: 'blob' };
  if (timeout) config.timeout = timeout;
  let res;
  try {
    res = await client.get(path, config);
  } catch (err) {
    let message = err?.message || 'Export failed';
    const body = err?.response?.data;
    if (body && typeof body.text === 'function') {
      try { message = JSON.parse(await body.text()).error || message; } catch { /* keep message */ }
    }
    throw new Error(message);
  }
  const blob = res.data instanceof Blob ? res.data : new Blob([res.data], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
