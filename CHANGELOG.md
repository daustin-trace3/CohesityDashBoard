# Changelog

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
