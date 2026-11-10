# Changelog

User-facing release notes for the in-app What's New popup. Keep entries in plain
language: what you can now do, or what stopped being broken.

## [1.1.0] - 2026-11-09

First What's New entry on this branch. It covers the work since August.

### Added
- LogicMonitor platform: portals, devices, interfaces, sites and reachability, circuits, collectors, groups and services, firewalls, load balancers, wireless, voice, Zscaler, ISE and application sections, trends, coverage and correlation, with a 19-report AI Advisor
- F5 and Cisco platforms fed by LogicMonitor data: their own pages, alerts, Ops cards and analytics (HA pairs, pools, certificates, GTM, stability; hardware, interfaces, optics, PoE, routing, resources, reachability); they appear once matched devices exist
- BlueCat Address Manager platform: views, zones, DNS record search, IP spaces, DHCP ranges and deployments
- Brocade SAN platform: SANnav sources, fabrics, switches, ports, devices, zoning and drift, a visual port map, events and governance with FOS lifecycle dates
- Operations Agent: watches alerts around the clock, groups them into incidents, triages each one with AI and emails or posts the analysis to Microsoft Teams
- Operations Agent correlation: alerts caused by a down host, switch or datastore attach to that incident, shared components fold together, and repeats become sticky incidents that wait for a person
- Operations Agent observations: hot VMs and hosts are watched quietly and become incidents only when the condition holds or repeats, with a grace period for newly deployed VMs
- Operations Agent live checks: ping, port, DNS and certificate probes plus direct platform reads, run from a playbook or chosen by the agent itself, with a deeper second pass on hard incidents
- Estate Advisor: ten cross-platform AI reports (daily brief, certificate audit, access review, recovery readiness, change ledger, network dependency, lifecycle and support, capacity outlook, agent review)
- AI Advisor on every platform, including Brocade, Aria Operations, BlueCat, Dell and NetBackup, with a report rail, readable tables and an email button
- AI provider choice: OpenAI, GitHub Models or any OpenAI-compatible endpoint, with model pick and a connection test
- Platform Status board: availability of every platform as ICC sees it, with 30, 60 and 90 day history and per-day detail
- Service Status page: LogicMonitor service groups day by day
- App Services page: applications rolled up from vCenter tags with their servers, hosts, storage, backup, DR replication and network state, plus catalog import
- Cross-platform topology map
- Configuration change ledger with drift detection across NetApp shares, Active Directory groups, LogicMonitor configs and more
- Alert email per platform: recipients, minimum severity and a mute per alert type
- Data retention: global windows for trending data and for events, with a per-platform override on every platform Settings page
- Global Settings as tabbed pages: Features, Platforms, Product License, Alert Notifications, Users & Access and one Intelligence page for AI, agent and privacy settings
- Sign-in with Active Directory or Okta (OpenID Connect or SAML 2.0) with group sync and group-to-role mapping
- Cohesity: rebuilt Replication page with status order, flows and per-target rollup, Helios cluster removal, alert window, criticals tile, polling backoff and a watchdog email
- vCenter: Guest Storage, Guest OS governance, vCenter groups, site capacity with failover pairs, vSphere tags page, long-term history and VM and host utilization thresholds
- NetApp: Governance page with ONTAP support dates
- Pure: Governance page with Pure1 hardware end of life, support contracts, subscriptions and Purity code support dates
- Dell: governance variances, hardware logs, event trends, filtered exports and a per-device AI analysis
- AWS: assume role, session keys and named profiles; full Lightsail inventory; cost drill-down by service, usage type and object; FinOps pages for amortized cost, forecast, commitments, anomalies, budgets, allocation, optimizer and unit economics
- Aria Automation: deployment ledger that keeps deployments longer than Aria does, Owned By column and project filters
- Zerto: Events page, per-alert-type email toggles and a Disconnect button for the Analytics account
- Backup History: 7, 14, 30, 90 day and custom ranges with CSV export and history depth settings
- Poller status chip opens a per-source panel with last result, error text and Poll now
- Global search covers Operations Agent incidents
- This What's New popup
### Changed
- Platform Status reports reachability only; platform alerts stay on each platform's Alerts page
- Every platform Settings page uses the same side rail and full-width panels
- Platform switcher is the icon rail with brand marks; inside LogicMonitor the header carries a row of the picked services
- Operations Agent emails list one issue per line, show Pacific wall-clock times, cap long alert lists and flag human-required incidents in the subject
- LogicMonitor Collectors moved under Settings > Connections; LogicMonitor pages open in well under a second on large estates
- AWS sidebar: Estate, FinOps, AI Advisor and Alerts up top, all services in one group
- Cohesity alert window setting moved to Cohesity Settings > Alert Notifications
- Polling runs several requests per platform in flight, serializes Cohesity polls and recovers scheduler ticks missed under load
### Fixed
- Two ICC processes starting together no longer fail a database migration against each other
- Pure polls where every fetch failed reported success and left stale data for days; they now show an error with the reason
- Pure1 fleets with no direct arrays showed No data on Platform Status
- NetApp alert and history times were read in the wrong time zone; direct clusters showed no ONTAP version
- Cohesity Overview kept showing clusters that had been removed
- Removed Dell warranty alerts for service tags that hold an active contract
- AWS: a service the account cannot use is skipped instead of failing the whole poll; cost data past 5,000 rows is no longer truncated
- LogicMonitor false CPU, memory and hardware issues from wrong datapoint picks after the first live portal
- Operations Agent re-triaged flapping Zerto alerts every minute; time windows were off by up to a day
- Brocade events failed on SANnav 3.x with HTTP 400
- Database lock waits and a write-ahead log that grew to hundreds of megabytes
- Background poller restarts under a 512 MB memory limit; poll memory is now logged
- Disabling a pack left its tab in the platform switcher until a refresh
- Unknown API paths answer 404 instead of the app shell
### Removed
- Custom dashboards
