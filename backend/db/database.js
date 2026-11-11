// The data connection (admin tables resolve through the attached admin file).
// See db/openDbs.js and db/adminSplit.js.
module.exports = require('./openDbs').db;
