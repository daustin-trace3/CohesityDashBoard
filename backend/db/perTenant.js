// For the few modules that want prepared statements (or one-time DDL) kept
// around between calls. Preparing at module load would bind the statements to
// whichever tenant happened to be current then; this keeps one set per tenant
// database and builds it the first time that tenant needs it.
//
//   const statements = perTenant((handle) => ({ one: handle.prepare('...') }));
//   statements().one.get(id);
const db = require('./database');

function perTenant(build) {
  const built = new WeakMap();
  return () => {
    const handle = db.$handle;
    let value = built.get(handle);
    if (!value) {
      value = build(handle);
      built.set(handle, value);
    }
    return value;
  };
}

module.exports = perTenant;
