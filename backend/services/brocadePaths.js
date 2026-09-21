// SANnav keeps a device port it once saw and flags it missing when the login
// goes away. That flag means a lost path only while nothing else is logged in
// on the same switch port. After an HBA swap, a WWN change or an NPIV logout
// the old record stays missing forever while the host is healthy on the new
// WWN, so a missing record whose switch port carries another live login is a
// leftover, not a path.
//
// SQL condition, true for a leftover record. `alias` is the
// brocade_device_ports alias in the outer query.
function supersededMissingSql(alias) {
  return `(${alias}.is_missing = 1 AND EXISTS (
    SELECT 1 FROM brocade_device_ports live
    WHERE live.source_id = ${alias}.source_id AND live.switch_wwn = ${alias}.switch_wwn
      AND live.port_number = ${alias}.port_number
      AND COALESCE(live.slot_number, 0) = COALESCE(${alias}.slot_number, 0)
      AND live.stale = 0 AND live.is_missing = 0 AND live.wwn != ${alias}.wwn
  ))`;
}

module.exports = { supersededMissingSql };
