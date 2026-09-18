// Security utilities for URL and redirect validation.

// Return the URL string if it is https, otherwise null.
export function safeHttpsUrl(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

// Validate returnTo parameter for open redirect hardening.
// Accept /path routes only (no //, backslash, or control chars).
// Otherwise fall back to the provided default.
export function safeReturnTo(value, fallback) {
  if (!value || typeof value !== 'string') return fallback;
  // Must start with / and not start with //
  if (!value.match(/^\/(?!\/)/)) return fallback;
  // No backslash or control characters
  if (value.includes('\\') || /[\x00-\x1f]/.test(value)) return fallback;
  return value;
}
