const db = require('../db/database');
const q = (sql, ...p) => db.prepare(sql).get(...p).c;
console.log('pure net with IP:', q("SELECT COUNT(*) c FROM pure_network_interfaces WHERE array_id=2 AND address IS NOT NULL"));
console.log('pure net with gateway:', q("SELECT COUNT(*) c FROM pure_network_interfaces WHERE array_id=2 AND gateway IS NOT NULL"));
console.log('netapp nfs clients:', q('SELECT COUNT(*) c FROM netapp_nfs_clients WHERE array_id=1'));
console.log('netapp export rules:', q('SELECT COUNT(*) c FROM netapp_export_rules WHERE array_id=1'));
const c = db.prepare('SELECT client_ip, svm_name, volume_name, protocol FROM netapp_nfs_clients WHERE array_id=1 LIMIT 3').all();
for (const x of c) console.log('  client', x.client_ip, '->', x.svm_name + '/' + x.volume_name, x.protocol);
