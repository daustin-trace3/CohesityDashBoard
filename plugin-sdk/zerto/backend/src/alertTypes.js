// Zerto alert-type reference catalog, embedded verbatim from
// backend/db/reference/zertoAlertTypes.json (229 codes) — a bundled plugin
// cannot read host files at that path, so the parsed JSON is committed here
// as a JS module instead. Every code path that read the host file (the
// migrations.js v5 seed) uses this module.
module.exports = [
  {
    "code": "ZVM0001",
    "entity": "ZVM",
    "severity": "Error",
    "description": "No connection to hypervisor manager, such as VMware vCenter Server and Microsoft SCVMM, or to public cloud."
  },
  {
    "code": "ZVM0002",
    "entity": "ZVM",
    "severity": "Error",
    "description": "No connection to VRA"
  },
  {
    "code": "ZVM0003",
    "entity": "ZVM",
    "severity": "Error",
    "description": "No connection to site"
  },
  {
    "code": "ZVM0004",
    "entity": "ZVM",
    "severity": "Warning",
    "description": "Peer ZVM version out-of-date"
  },
  {
    "code": "ZVM0005",
    "entity": "ZVM",
    "severity": "Warning",
    "description": "Zerto Virtual Manager low disk space"
  },
  {
    "code": "ZVM0006",
    "entity": "ZVM",
    "severity": "Warning",
    "description": "Upgrade available"
  },
  {
    "code": "ZVM0007",
    "entity": "ZVM",
    "severity": "Warning",
    "description": "Cannot upgrade"
  },
  {
    "code": "ZVM0008",
    "entity": "ZVM",
    "severity": "Error",
    "description": "Version mismatch"
  },
  {
    "code": "ZVM0009",
    "entity": "ZVM",
    "severity": "Error",
    "description": "Internal error"
  },
  {
    "code": "ZVM0010",
    "entity": "ZVM",
    "severity": "Warning",
    "description": "Synchronization between Zerto Virtual Managers"
  },
  {
    "code": "ZVM0011",
    "entity": "ZVM",
    "severity": "Error",
    "description": "Metadata collection"
  },
  {
    "code": "ZVM0012",
    "entity": "ZVM",
    "severity": "Error",
    "description": "Metadata collection"
  },
  {
    "code": "ZVM0013",
    "entity": "ZVM",
    "severity": "Warning",
    "description": "Metadata collection"
  },
  {
    "code": "ZVM0014",
    "entity": "ZVM",
    "severity": "Error",
    "description": "VRA/Diskbox SCSI GUID mismatch"
  },
  {
    "code": "ZVM0015",
    "entity": "ZVM",
    "severity": "Warning/Error",
    "description": "Hyper-V host state"
  },
  {
    "code": "ZVM0016",
    "entity": "ZVM",
    "severity": "Error",
    "description": "Failed to load tweaks"
  },
  {
    "code": "ZVM0017",
    "entity": "ZVM",
    "severity": "Warning",
    "description": "Protected VM with unknown OS"
  },
  {
    "code": "ZVM0019",
    "entity": "ZVM",
    "severity": "Error",
    "description": "Agent disconnected / Failed to open channel"
  },
  {
    "code": "ZVM0020",
    "entity": "ZVM",
    "severity": "Error",
    "description": "Agent installation failed"
  },
  {
    "code": "ZVM0021",
    "entity": "ZVM",
    "severity": "Error",
    "description": "VRA-H powered off"
  },
  {
    "code": "ZVM0022",
    "entity": "ZVM",
    "severity": "Warning",
    "description": "A Zerto Storage Policy is still assigned to a VM which is no longer protected by Zerto ."
  },
  {
    "code": "ZVM0023",
    "entity": "ZVM",
    "severity": "Warning",
    "description": "VM tag mismatch"
  },
  {
    "code": "ZVM0024",
    "entity": "ZVM",
    "severity": "Warning",
    "description": "HostDisconnectionAlert"
  },
  {
    "code": "ZVM0025",
    "entity": "Storage Policy",
    "severity": "Warning",
    "description": "VRA deployment or uninstall issues"
  },
  {
    "code": "ZVM0026",
    "entity": "Storage Policy",
    "severity": "Error",
    "description": "Zerto Storage Policy does not contain Zerto Replication component"
  },
  {
    "code": "ZVM0027",
    "entity": "Storage Policy",
    "severity": "Error",
    "description": "Zerto Storage Policy Component authentication mismatch"
  },
  {
    "code": "ZVM0028",
    "entity": "ZVM",
    "severity": "Warning",
    "description": "AVS VAIO insufficient hosts in cluster"
  },
  {
    "code": "ZVM0030",
    "entity": "ZVM",
    "severity": "Error",
    "description": "VAIO Encryption Storage Policy Error - Recovery"
  },
  {
    "code": "ZVM0031",
    "entity": "Storage Policy",
    "severity": "Error",
    "description": "Zerto Encryption Component mismatch"
  },
  {
    "code": "ZVM0032",
    "entity": "ZVM",
    "severity": "Error",
    "description": "Secret credentials in the External Secrets Vault changed"
  },
  {
    "code": "ZVM0033",
    "entity": "ZVM",
    "severity": "Error",
    "description": "One of the secrets in the External Secrets Vault is missing the required key"
  },
  {
    "code": "ZVM0034",
    "entity": "ZVM",
    "severity": "Error",
    "description": "One of the secrets in the External Secrets Vault is missing the required permission."
  },
  {
    "code": "ZVM0035",
    "entity": "ZVM",
    "severity": "Error",
    "description": "The External Secrets Vault is disconnected."
  },
  {
    "code": "ZVM0036",
    "entity": "ZVM",
    "severity": "Error",
    "description": "One of the secrets in the External Secrets Vault is missing."
  },
  {
    "code": "ZVM0037",
    "entity": "ZVM",
    "severity": "Error",
    "description": "External Secrets Vault incoming server certificate is expired or not yet valid."
  },
  {
    "code": "ZVM0038",
    "entity": "ZVM",
    "severity": "Error",
    "description": "Failed to load External Secrets Vault root CA certificate."
  },
  {
    "code": "ZVM0039",
    "entity": "ZVM",
    "severity": "Error",
    "description": "Failed to find External Secrets Vault certificates in the file."
  },
  {
    "code": "ZVM0040",
    "entity": "ZVM",
    "severity": "Error",
    "description": "Failed to load a valid certificate from a certificate file."
  },
  {
    "code": "ZVM0041",
    "entity": "ZVM",
    "severity": "Error",
    "description": "Failed to find the External Secrets Vault client certificate in the certificate collection."
  },
  {
    "code": "ZVM0042",
    "entity": "ZVM",
    "severity": "Error",
    "description": "Failed to validate External Secrets Vault certificate chain."
  },
  {
    "code": "ZVM0045",
    "entity": "ZVM",
    "severity": "Error",
    "description": "EvacuateBestEffortCreationFailureAlert"
  },
  {
    "code": "ZVM0046",
    "entity": "ZVM",
    "severity": "Error",
    "description": "EvacuateBestEffortTagAssignmentFailureAlert"
  },
  {
    "code": "VPG0003",
    "entity": "VPG",
    "severity": "Warning",
    "description": "VPG has low journal history"
  },
  {
    "code": "VPG0004",
    "entity": "VPG",
    "severity": "Error",
    "description": "VPG has low journal history"
  },
  {
    "code": "VPG0005",
    "entity": "VPG",
    "severity": "Error",
    "description": "VPG in error state"
  },
  {
    "code": "VPG0006",
    "entity": "VPG",
    "severity": "Error",
    "description": "VPG missing configuration details"
  },
  {
    "code": "VPG0007",
    "entity": "VPG",
    "severity": "Error",
    "description": "VPG replication paused"
  },
  {
    "code": "VPG0008",
    "entity": "VPG",
    "severity": "Error",
    "description": "VPG rollback failed"
  },
  {
    "code": "VPG0009",
    "entity": "VPG",
    "severity": "Warning",
    "description": "VPG target RPO exceeded"
  },
  {
    "code": "VPG0010",
    "entity": "VPG",
    "severity": "Error",
    "description": "VPG target RPO exceeded"
  },
  {
    "code": "VPG0011",
    "entity": "VPG",
    "severity": "Warning",
    "description": "VPG test overdue"
  },
  {
    "code": "VPG0012",
    "entity": "VPG",
    "severity": "Warning",
    "description": "VPG test overdue"
  },
  {
    "code": "VPG0014",
    "entity": "VPG",
    "severity": "Warning",
    "description": "VPG waiting for commit or rollback"
  },
  {
    "code": "VPG0015",
    "entity": "VPG",
    "severity": "Error",
    "description": "Resources not enough to support VPG"
  },
  {
    "code": "VPG0016",
    "entity": "VPG",
    "severity": "Error",
    "description": "Resources pool not found"
  },
  {
    "code": "VPG0017",
    "entity": "VPG",
    "severity": "Warning",
    "description": "VPG protection paused"
  },
  {
    "code": "VPG0018",
    "entity": "VPG",
    "severity": "Error",
    "description": "VMs in VPG not configured with a storage policy"
  },
  {
    "code": "VPG0019",
    "entity": "VPG",
    "severity": "Error",
    "description": "VPG recovery storage policy disabled"
  },
  {
    "code": "VPG0020",
    "entity": "VPG",
    "severity": "Error",
    "description": "VPG recovery storage policy not found"
  },
  {
    "code": "VPG0021",
    "entity": "VPG",
    "severity": "Error",
    "description": "VPG recovery storage policy not found"
  },
  {
    "code": "VPG0022",
    "entity": "VPG",
    "severity": "Error",
    "description": "VPG recovery storage policy disabled"
  },
  {
    "code": "VPG0023",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "No connection to Extension Service"
  },
  {
    "code": "VPG0024",
    "entity": "VPG",
    "severity": "Error",
    "description": "VPG storage policy does not include active datastores"
  },
  {
    "code": "VPG0025",
    "entity": "VPG",
    "severity": "Warning",
    "description": "vCD vApp network mapping not defined"
  },
  {
    "code": "VPG0026",
    "entity": "VPG",
    "severity": "Warning",
    "description": "VPG recovery storage profile changed"
  },
  {
    "code": "VPG0027",
    "entity": "VPG",
    "severity": "Warning",
    "description": "VPG includes VMs that are no longer protected"
  },
  {
    "code": "VPG0028",
    "entity": "VPG",
    "severity": "Error",
    "description": "Corrupted Org vDC network mapping"
  },
  {
    "code": "VPG0035",
    "entity": "VPG",
    "severity": "Warning",
    "description": "VPG protected resources not in ZORG"
  },
  {
    "code": "VPG0036",
    "entity": "VPG",
    "severity": "Warning",
    "description": "VPG recovery resources not in ZORG"
  },
  {
    "code": "VPG0037",
    "entity": "VPG",
    "severity": "Warning",
    "description": "Journal history is compromised"
  },
  {
    "code": "VPG0038",
    "entity": "VPG",
    "severity": "Error",
    "description": "Journal history is compromised"
  },
  {
    "code": "VPG0039",
    "entity": "VPG",
    "severity": "Error",
    "description": "RDM has an odd number of blocks"
  },
  {
    "code": "VPG0040",
    "entity": "VPG",
    "severity": "Error",
    "description": "Virtual machine hardware mismatch with recovery site"
  },
  {
    "code": "VPG0041",
    "entity": "VPG",
    "severity": "Error",
    "description": "Virtual machine running Windows 2003"
  },
  {
    "code": "VPG0042",
    "entity": "VPG",
    "severity": "Error",
    "description": "Recovery network not found"
  },
  {
    "code": "VPG0043",
    "entity": "VPG",
    "severity": "Warning",
    "description": "Cross-replication"
  },
  {
    "code": "VPG0044",
    "entity": "VPG",
    "severity": "Error",
    "description": "Cross-replication"
  },
  {
    "code": "VPG0049",
    "entity": "VPG",
    "severity": "Error",
    "description": "Protection group missing VM"
  },
  {
    "code": "VPG0050",
    "entity": "VPG",
    "severity": "Warning",
    "description": "Protection Group Tested Alert"
  },
  {
    "code": "VPG0051",
    "entity": "VPG",
    "severity": "Error",
    "description": "Stopping Failover Test Operation Failed"
  },
  {
    "code": "VPG0052",
    "entity": "VPG",
    "severity": "Error",
    "description": "Rolling back Failover Live Operation Failed"
  },
  {
    "code": "VPG0053",
    "entity": "VPG",
    "severity": "Error",
    "description": "Rolling back Move Operation Failed"
  },
  {
    "code": "VPG0055",
    "entity": "VPG",
    "severity": "Error",
    "description": "VPG Not Correctly Configured for Protected Volume Size"
  },
  {
    "code": "VPG0057",
    "entity": "VPG",
    "severity": "Error",
    "description": "Elastic VDC - invalid PVDC configuration"
  },
  {
    "code": "VPG0058",
    "entity": "VPG",
    "severity": "Warning",
    "description": "Storage profile is not reachable."
  },
  {
    "code": "VPG0059",
    "entity": "VPG",
    "severity": "Warning",
    "description": "Corrupted Org vDC network"
  },
  {
    "code": "VPG0060",
    "entity": "VPG",
    "severity": "Warning",
    "description": "VolumeDetach"
  },
  {
    "code": "VPG0061",
    "entity": "VPG",
    "severity": "Warning",
    "description": "VpgVappBrokenReflection"
  },
  {
    "code": "VPG0062",
    "entity": "VPG",
    "severity": "Error",
    "description": "Azure shared disks are not excluded"
  },
  {
    "code": "VPG0063",
    "entity": "VPG",
    "severity": "Error",
    "description": "The ZORG of the VPG was not found in the storage"
  },
  {
    "code": "VPG0065",
    "entity": "VPG",
    "severity": "Error",
    "description": "VAIO Protected Storage Policy Error."
  },
  {
    "code": "VPG0066",
    "entity": "VPG",
    "severity": "Error",
    "description": "Inconsistent VPG"
  },
  {
    "code": "VPG0067",
    "entity": "VPG",
    "severity": "Error",
    "description": "Inconsistent VPG"
  },
  {
    "code": "VPG0068",
    "entity": "VPG",
    "severity": "Error",
    "description": "VAIO Promotion Storage Policy Error"
  },
  {
    "code": "VPG0069",
    "entity": "VPG",
    "severity": "Error",
    "description": "Disk Encryption Keys are invalid for recovery operations."
  },
  {
    "code": "VPG0070",
    "entity": "VPG",
    "severity": "Error",
    "description": "Encrypted VM state change."
  },
  {
    "code": "VPG0071",
    "entity": "VPG",
    "severity": "Error",
    "description": "DiskEncryptionKeyIsInvalidForRecoveryOperationsAlert."
  },
  {
    "code": "VRA0001",
    "entity": "VRA",
    "severity": "Warning",
    "description": "Host without VRA"
  },
  {
    "code": "VRA0002",
    "entity": "VRA",
    "severity": "Error",
    "description": "VRA without IP"
  },
  {
    "code": "VRA0003",
    "entity": "VRA",
    "severity": "Error",
    "description": "Host IP changes"
  },
  {
    "code": "VRA0004",
    "entity": "VRA",
    "severity": "Error",
    "description": "VRA lost IP"
  },
  {
    "code": "VRA0005",
    "entity": "VRA",
    "severity": "Error",
    "description": "VRAs not connected"
  },
  {
    "code": "VRA0006",
    "entity": "VRA",
    "severity": "Error",
    "description": "Datastore for journal disk is full"
  },
  {
    "code": "VRA0007",
    "entity": "VRA",
    "severity": "Error",
    "description": "I/O error to journal"
  },
  {
    "code": "VRA0008",
    "entity": "VRA",
    "severity": "Error",
    "description": "Recovery disk and VMs missing"
  },
  {
    "code": "VRA0009",
    "entity": "VRA",
    "severity": "Error",
    "description": "Recovery disk missing"
  },
  {
    "code": "VRA0010",
    "entity": "VRA",
    "severity": "Error",
    "description": "Recovery disks turned off"
  },
  {
    "code": "VRA0011",
    "entity": "VRA",
    "severity": "Error",
    "description": "Recovery disk inaccessible"
  },
  {
    "code": "VRA0012",
    "entity": "VRA",
    "severity": "Error",
    "description": "Cannot write to recovery disk"
  },
  {
    "code": "VRA0013",
    "entity": "VRA",
    "severity": "Error",
    "description": "IO error to recovery disk"
  },
  {
    "code": "VRA0014",
    "entity": "VRA",
    "severity": "Error",
    "description": "Cloned disks turned off"
  },
  {
    "code": "VRA0015",
    "entity": "VRA",
    "severity": "Error",
    "description": "Cloned disk inaccessible"
  },
  {
    "code": "VRA0016",
    "entity": "VRA",
    "severity": "Error",
    "description": "Datastore for clone disk is full"
  },
  {
    "code": "VRA0017",
    "entity": "VRA",
    "severity": "Error",
    "description": "IO error to clone"
  },
  {
    "code": "VRA0018",
    "entity": "VRA",
    "severity": "Error",
    "description": "Protected disk and VM missing"
  },
  {
    "code": "VRA0019",
    "entity": "VRA",
    "severity": "Warning",
    "description": "Protected disk missing"
  },
  {
    "code": "VRA0020",
    "entity": "VRA",
    "severity": "Error",
    "description": "VM powered off"
  },
  {
    "code": "VRA0021",
    "entity": "VRA",
    "severity": "Error",
    "description": "VM disk inaccessible"
  },
  {
    "code": "VRA0022",
    "entity": "VRA",
    "severity": "Error",
    "description": "VM disk incompatible"
  },
  {
    "code": "VRA0023",
    "entity": "VRA",
    "severity": "Error",
    "description": "VRA cannot be registered"
  },
  {
    "code": "VRA0024",
    "entity": "VRA",
    "severity": "Error",
    "description": "VRA removed"
  },
  {
    "code": "VRA0025",
    "entity": "VRA",
    "severity": "Error",
    "description": "IO synchronization"
  },
  {
    "code": "VRA0026",
    "entity": "VRA",
    "severity": "Error",
    "description": "Recovery disk removed"
  },
  {
    "code": "VRA0027",
    "entity": "VRA",
    "severity": "Error",
    "description": "Journal volume removed"
  },
  {
    "code": "VRA0028",
    "entity": "VRA",
    "severity": "Error/Warning",
    "description": "VRA powered off"
  },
  {
    "code": "VRA0029",
    "entity": "VRA",
    "severity": "Warning",
    "description": "VRA memory low"
  },
  {
    "code": "VRA0030",
    "entity": "VRA",
    "severity": "Warning",
    "description": "Journal size mismatch"
  },
  {
    "code": "VRA0032",
    "entity": "VRA",
    "severity": "Warning",
    "description": "Local VRA version out-of-date"
  },
  {
    "code": "VRA0033",
    "entity": "VRA",
    "severity": "Warning",
    "description": "Peer VRA out-of-date"
  },
  {
    "code": "VRA0035",
    "entity": "VRA",
    "severity": "Warning",
    "description": "VRA reconciliation"
  },
  {
    "code": "VRA0037",
    "entity": "VRA",
    "severity": "Error",
    "description": "Local MAC Address Conflict"
  },
  {
    "code": "VRA0038",
    "entity": "VRA",
    "severity": "Error",
    "description": "MAC Address Conflict"
  },
  {
    "code": "VRA0039",
    "entity": "VRA",
    "severity": "Error",
    "description": "Journal reached configured limit"
  },
  {
    "code": "VRA0040",
    "entity": "VRA",
    "severity": "Warning",
    "description": "Journal space low"
  },
  {
    "code": "VRA0049",
    "entity": "VRA",
    "severity": "Error",
    "description": "Host rollback failed"
  },
  {
    "code": "VRA0050",
    "entity": "VRA",
    "severity": "Warning",
    "description": "Wrong host password"
  },
  {
    "code": "VRA0052",
    "entity": "VRA",
    "severity": "Warning",
    "description": "Disk visible but not recognized"
  },
  {
    "code": "VRA0053",
    "entity": "VRA",
    "severity": "Error",
    "description": "System disk removed"
  },
  {
    "code": "VRA0054",
    "entity": "VRA",
    "severity": "Error",
    "description": "VRA journal alert in public cloud"
  },
  {
    "code": "VRA0055",
    "entity": "VRA",
    "severity": "Error",
    "description": "VRA target volume alert in public cloud"
  },
  {
    "code": "VRA0056",
    "entity": "VRA",
    "severity": "Warning",
    "description": "VRA is shutting down"
  },
  {
    "code": "VRA0058",
    "entity": "VRA",
    "severity": "Warning",
    "description": "Host ESXi /tmp folder is out of space"
  },
  {
    "code": "VRA0059",
    "entity": "VRA",
    "severity": "Warning",
    "description": "High Storage Latency"
  },
  {
    "code": "VRA0060",
    "entity": "VRA",
    "severity": "Warning",
    "description": "Malformed Packet"
  },
  {
    "code": "VRA0061",
    "entity": "VRA",
    "severity": "Warning",
    "description": "Maximum Transmission Unit (MTU) mismatch"
  },
  {
    "code": "VRA0062",
    "entity": "VRA",
    "severity": "Error",
    "description": "VRA disconnected from host due to Maximum Transmission Unit (MTU) mismatch"
  },
  {
    "code": "VRA0063",
    "entity": "VRA",
    "severity": "Error/Warning",
    "description": "VRA Service is down"
  },
  {
    "code": "VRA0064",
    "entity": "Public Cloud",
    "severity": "Error",
    "description": "PublicCloudVraVmDeleted"
  },
  {
    "code": "VRA0065",
    "entity": "VRA",
    "severity": "Error",
    "description": "Azure VRA Upgrade failed on ZCA upgrade"
  },
  {
    "code": "VRA0066",
    "entity": "VRA",
    "severity": "Error",
    "description": "CMK associated with the storage account is invalid."
  },
  {
    "code": "VRA0067",
    "entity": "VRA",
    "severity": "Warning",
    "description": "CMK is invalid."
  },
  {
    "code": "VRA0068",
    "entity": "VRA",
    "severity": "Warning",
    "description": "Managed identity is invalid."
  },
  {
    "code": "VRA0069",
    "entity": "Public Cloud",
    "severity": "Error",
    "description": "Disk Encryption Keys are invalid for recovery operations."
  },
  {
    "code": "ZCA0001",
    "entity": "Public Cloud",
    "severity": "Error",
    "description": "Storage removed"
  },
  {
    "code": "ZCA0002",
    "entity": "Public Cloud",
    "severity": "Warning",
    "description": "Quota of instances number exceeded"
  },
  {
    "code": "ZCA0003",
    "entity": "VPG",
    "severity": "Error",
    "description": "Zerto AWS Snapshot Manager not reachable"
  },
  {
    "code": "ZCA0004",
    "entity": "Public Cloud",
    "severity": "Warning",
    "description": "Orchestrator in Reset state"
  },
  {
    "code": "ZCA0005",
    "entity": "Public Cloud",
    "severity": "Warning",
    "description": "Failed to create Azure Scaleset"
  },
  {
    "code": "ZCA0006",
    "entity": "Public Cloud",
    "severity": "Warning",
    "description": "Failed to create Azure Queues"
  },
  {
    "code": "ZCA0007",
    "entity": "Public Cloud",
    "severity": "Warning",
    "description": "Scaleout workers not meeting the scaling policy"
  },
  {
    "code": "ZCA0008",
    "entity": "Public Cloud",
    "severity": "Error",
    "description": "Azure VRA VM bucket (Storage Account) removed"
  },
  {
    "code": "ZCA0009",
    "entity": "Public Cloud",
    "severity": "Warning",
    "description": "Public Cloud Orchestrator Subnet Too Small For Workers Creation"
  },
  {
    "code": "ZCA0010",
    "entity": "Public Cloud",
    "severity": "Error",
    "description": "An S3 bucket associated with a VRA was deleted"
  },
  {
    "code": "ZCA0011",
    "entity": "Public Cloud",
    "severity": "Warning",
    "description": "Scaleout workers are experiencing storage connection issues."
  },
  {
    "code": "ZCA0012",
    "entity": "Public Cloud",
    "severity": "Error",
    "description": "Azure missing managed identity permissions."
  },
  {
    "code": "ZCA0013",
    "entity": "Public Cloud",
    "severity": "Error",
    "description": "Failed to reset Azure Virtual Machine Scale set."
  },
  {
    "code": "ZCA0014",
    "entity": "Public Cloud",
    "severity": "Error",
    "description": "All worker instances in Azure Virtual Machine Scale Set have been deallocated."
  },
  {
    "code": "ZCC0001",
    "entity": "Cloud Connector",
    "severity": "Error",
    "description": "Zerto Cloud Connector removed"
  },
  {
    "code": "ZCC0002",
    "entity": "Cloud Connector",
    "severity": "Error",
    "description": "Zerto Cloud Connector powered off"
  },
  {
    "code": "ZCC0003",
    "entity": "Cloud Connector",
    "severity": "Warning",
    "description": "Orphaned Zerto Cloud Connector"
  },
  {
    "code": "ZCM0001",
    "entity": "ZCM",
    "severity": "Error",
    "description": "No connection to Zerto Virtual Manager"
  },
  {
    "code": "ZCM0002",
    "entity": "Licensing",
    "severity": "Error",
    "description": "Zerto Cloud Manager not supported"
  },
  {
    "code": "ZCM0004",
    "entity": "ZCM",
    "severity": "Error",
    "description": "ZVM is already connected to another ZCM"
  },
  {
    "code": "VCD0001",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "The underlying vCenter Server for the Org vDC is not found."
  },
  {
    "code": "VCD0002",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "The Org vDC is defined in more than one underlying vCenter Server."
  },
  {
    "code": "VCD0003",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "The Org vDC storage profile specified exists in vCD but cannot be found in the underlying vCenter Server."
  },
  {
    "code": "VCD0004",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "The provider vDC storage profile specified exists in vCD but cannot be found in the underlying vCenter Server."
  },
  {
    "code": "VCD0005",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "The network information required by Zerto cannot be retrieved."
  },
  {
    "code": "VCD0006",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "A problem occurred with Zerto accessing the provider vDC metadata it has in the recovery site."
  },
  {
    "code": "VCD0007",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "The connection to vCD was dropped, so the required resource pools for the Org vDC could not be retrieved."
  },
  {
    "code": "VCD0010",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "The network information required by Zerto cannot be retrieved."
  },
  {
    "code": "VCD0014",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "vCD disconnection"
  },
  {
    "code": "VCD0015",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "MQTT server disconnection"
  },
  {
    "code": "VCD0016",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "Provider vDC datastore not found"
  },
  {
    "code": "VCD0017",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "The metadata for the Org vDC in vCD could not be extracted."
  },
  {
    "code": "VCD0018",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "Duplicated MAC addresses"
  },
  {
    "code": "VCD0020",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "VM inconsistency in vApp"
  },
  {
    "code": "VCD0021",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "VM inconsistency in vApp"
  },
  {
    "code": "VCD0022",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "vCD Protection group missing VM"
  },
  {
    "code": "VCD0024",
    "entity": "vCloud Director",
    "severity": "Warning",
    "description": "vCD VMs missing MoRef ID"
  },
  {
    "code": "VCD0025",
    "entity": "vCloud Director",
    "severity": "Error",
    "description": "vCD VMs have VC identifiers duplicates"
  },
  {
    "code": "LIC0001",
    "entity": "Licensing",
    "severity": "Warning",
    "description": "License exceeded"
  },
  {
    "code": "LIC0002",
    "entity": "Licensing",
    "severity": "Warning",
    "description": "License package {LicensePackage Name} reached 80%"
  },
  {
    "code": "LIC0003",
    "entity": "Licensing",
    "severity": "Warning",
    "description": "License {License key} is about to expire"
  },
  {
    "code": "LIC0004",
    "entity": "Licensing",
    "severity": "Warning",
    "description": "License expired and exceeded"
  },
  {
    "code": "LIC0005",
    "entity": "Licensing",
    "severity": "Error",
    "description": "License package {LicensePackage name} reached 100%"
  },
  {
    "code": "LIC0006",
    "entity": "Licensing",
    "severity": "Warning",
    "description": "License {License key} expired"
  },
  {
    "code": "LIC0007",
    "entity": "Licensing",
    "severity": "Warning",
    "description": "License exceeded"
  },
  {
    "code": "LIC0009",
    "entity": "Licensing",
    "severity": "Error",
    "description": "Public cloud replication not supported"
  },
  {
    "code": "LIC0012",
    "entity": "Licensing",
    "severity": "Warning",
    "description": "Billing usage warning"
  },
  {
    "code": "LIC0013",
    "entity": "Licensing",
    "severity": "Error",
    "description": "Critical billing usage warning"
  },
  {
    "code": "LIC0014",
    "entity": "Licensing",
    "severity": "Warning",
    "description": "License about to be exceed"
  },
  {
    "code": "LIC0017",
    "entity": "Licensing",
    "severity": "Error",
    "description": "License exceeded"
  },
  {
    "code": "LIC0021",
    "entity": "Licensing",
    "severity": "Warning",
    "description": "Unauthorized disconnection from CallHome warning"
  },
  {
    "code": "LIC0022",
    "entity": "Licensing",
    "severity": "Error",
    "description": "Unauthorized disconnection from CallHome error"
  },
  {
    "code": "LTR0001",
    "entity": "Journal Copy",
    "severity": "Warning",
    "description": "Extended Journal Copy fails"
  },
  {
    "code": "LTR0002",
    "entity": "Journal Copy",
    "severity": "Error",
    "description": "Extended Journal Copy fails"
  },
  {
    "code": "LTR0003",
    "entity": "Journal Copy",
    "severity": "Error",
    "description": "Failed or missing Extended Journal Copy process"
  },
  {
    "code": "LTR0005",
    "entity": "Journal Copy",
    "severity": "Error/Warning",
    "description": "Extended Journal Copy repository disconnected."
  },
  {
    "code": "LTR0006",
    "entity": "Journal Copy",
    "severity": "Error",
    "description": "Extended Journal Copy repository disconnected."
  },
  {
    "code": "LTR0007",
    "entity": "Journal Copy",
    "severity": "Warning",
    "description": "Extended Journal Copy repository not defined."
  },
  {
    "code": "LTR0008",
    "entity": "Journal Copy",
    "severity": "Error",
    "description": "Extended Journal Copy repository is full."
  },
  {
    "code": "LTR0009",
    "entity": "Journal Copy",
    "severity": "Warning",
    "description": "The Repository used for Extended Journal Copy is nearly full."
  },
  {
    "code": "LTR0011",
    "entity": "Journal Copy",
    "severity": "Major",
    "description": "The Extended Journal Copy for a VPG is as risk due to volume(s) tracking changes error."
  },
  {
    "code": "STR0001",
    "entity": "Storage",
    "severity": "Error",
    "description": "Datastore not accessible"
  },
  {
    "code": "STR0002",
    "entity": "Storage",
    "severity": "Error",
    "description": "Datastore full"
  },
  {
    "code": "STR0004",
    "entity": "Storage",
    "severity": "Warning",
    "description": "Datastore low in space"
  },
  {
    "code": "AWS0001",
    "entity": "Public Cloud",
    "severity": "Error",
    "description": "Storage removed"
  },
  {
    "code": "FLR0001",
    "entity": "File Restore",
    "severity": "Error",
    "description": "Files cannot be restored"
  },
  {
    "code": "DRV0001",
    "entity": "Driver",
    "severity": "Warning",
    "description": "I/O cache memory is full"
  },
  {
    "code": "DRV0002",
    "entity": "Driver",
    "severity": "Warning",
    "description": "Bitmap memory is full"
  },
  {
    "code": "DRV0003",
    "entity": "Driver",
    "severity": "Warning",
    "description": "Hung I/O operation"
  },
  {
    "code": "DRV0004",
    "entity": "Driver",
    "severity": "Error",
    "description": "VAIO IOFilter mismatch"
  },
  {
    "code": "DRV0005",
    "entity": "Driver",
    "severity": "Error",
    "description": "Vaio IOFilter Cluster Host Mismatch"
  },
  {
    "code": "ENC0001",
    "entity": "Encryption",
    "severity": "Warning",
    "description": "Encryption Detection"
  },
  {
    "code": "RPM0001",
    "entity": "Recovery Plans",
    "severity": "Warning",
    "description": "VPG in the Recovery Plan does not exist"
  },
  {
    "code": "RPM0002",
    "entity": "Recovery Plans",
    "severity": "Warning",
    "description": "VPG in the Recovery Plan does not replicate to the recovery site."
  },
  {
    "code": "RPM0003",
    "entity": "Recovery Plans",
    "severity": "Warning",
    "description": "VPG in the Recovery Plan is misconfigured."
  },
  {
    "code": "RPM0004",
    "entity": "Recovery Plans",
    "severity": "Warning",
    "description": "At least one VPG in the Recovery Plan is of a type that is not allowed."
  }
];
