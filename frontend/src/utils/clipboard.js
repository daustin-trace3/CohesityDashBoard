// Copy text to the clipboard from any origin. navigator.clipboard exists only
// in secure contexts (HTTPS or localhost); an ICC reached over plain http on
// an IP or hostname gets undefined there, so fall back to a hidden textarea
// plus execCommand('copy'), which still works in every current browser.
// Resolves true when something was copied, false when both paths failed.
export async function copyText(text) {
  const value = text == null ? '' : String(text);
  if (!value) return false;
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch { /* permission denied or unsupported, try the fallback */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}
