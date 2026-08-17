// Tiny shared route-template compiler (dell/unifi/nutanix router.js pattern).
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
