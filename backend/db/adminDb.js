// The admin connection: users, sessions, groups, grants, settings, plugins,
// directory and identity providers. See db/adminSplit.js.
module.exports = require('./openDbs').adminDb;
