@'
const db = require('better-sqlite3')('data/cohesity.db', { readonly: true });
for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
  try {
    const c = db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c;
    if (c > 5000) console.log(t.name.padEnd(30), c);
  } catch {}
}
'@ | Set-Content dbstats.tmp.js

node dbstats.tmp.js
Remove-Item dbstats.tmp.js
Get-ChildItem data\cohesity.db* | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
