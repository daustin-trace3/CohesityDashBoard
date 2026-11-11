// Admin scope: every future change to an admin table (users, groups,
// user_groups, role_grants, auth_sessions, service_accounts, app_settings,
// plugins, user_dashboards, directory_sync_log, idp_*, tenant_audit) goes HERE
// and runs on the admin connection (db/adminSplit.js). core.js must never touch
// an admin table again; tests/adminSplit.test.js enforces it.
module.exports = [];
