// Tiny shared route-template compiler used by both router.js (dell/zerto
// plugin-sdk pattern) — kept in its own module so neither has to require the
// other for it.
function compile(template) {
  const names = [];
  const pattern = template
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${pattern}$`), names };
}

module.exports = { compile };
