# Changelog

## [1.2.0] - 2026-08-10
### Added
- Nutanix platform: Prism Central and standalone Prism Element connections, clusters, hosts, VMs, storage, and Prism alerts
- Nutanix data resiliency, data-reduction ratios, capacity runway, and NCC health surfaced alongside vSphere-parity metrics
- Nutanix protection: protection domains, in-flight replications, Leap policies, recovery points, and derived RPO compliance
- Nutanix Move migration tracking and Mine backup-cluster monitoring with optional Veeam integration (pages appear when configured)
- Nutanix AI Advisor with capacity, replication, hotspots, and resiliency reports
- Ops Monitor compact card density toggle to fit many platforms on one screen
### Fixed
- Repeated failed logins now lock the attempted username for 15 minutes

## [1.1.0] - 2026-08-03
### Added
- Proxmox VE platform: nodes, VMs/containers, storage, backups, and Guest 360 with live trends
- AWS platform with cost tracking, FinOps AI Advisor, and an Optimizer for right-sizing recommendations
- Aria Automation platform for VMware deployments and approvals
- Guests-on-storage correlation popup for Proxmox
- Object 360 drill-in pages for Cohesity and NetBackup
- Installable plugin support, with a Rubrik demo plugin as the first example
### Fixed
- Failed polls no longer wipe stored inventory for NetBackup, Proxmox, Pure1, or Zerto
- Demo instances ignore manual refresh requests so seeded data can't be overwritten
- Global search no longer triggers browser autofill prompts
### Changed
- Proxmox overview trends split into separate CPU, memory, and IO-wait charts

## [1.0.0] - 2026-07-30
### Added
- Initial 8-platform release: Cohesity, Pure Storage, NetApp, Zerto, vCenter, Dell, Aria Operations, and NetBackup
