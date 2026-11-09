# Contract: LogicMonitor-derived analytics for the Cisco and F5 platforms

Status: DRAFT, for review by the builder agent. Nothing in this contract has been built yet.
Author context: read-only investigation of the codebase on 2026-11-09. File references are relative to the repo root.

---

## 0. Purpose

Cisco and F5 are **derived platforms**. They have no poller and no tables of their own. Every read goes through the LogicMonitor connector feeds (`core/feeds.js`, `coreApi.feeds.query('logicmonitor', <feed>, params)`). The manifests are:

- `backend/platforms/cisco/index.js`
- `backend/platforms/f5/index.js`
- feed implementations in `backend/connectors/logicmonitor.js`

The LM connector already collects much more Cisco and F5 data than these platform pages show. This contract covers two things:

1. Surfacing datapoints we already collect but don't show.
2. Adding derived analytics (trends, forecasts, change detection, posture scores) built from history we already keep.

No new LM API calls are needed for any work package here, except the optional coverage work in WP-X3.

---

## 1. Ground rules (apply to every work package)

| # | Rule |
|---|------|
| G1 | **Derived-platform boundary.** Platform code (`backend/platforms/{cisco,f5}`) must not query `lm_*` tables directly. Add or extend a feed in `backend/connectors/logicmonitor.js` and call it through `feed(coreApi, ...)`. The one existing exception is search-category SQL. |
| G2 | **Never call `computeIssues()` on a request path.** It loads every `lm_ds_metrics` row (about 300 MB RSS). Read `lm_issue_history` (`status='open'`) or pre-aggregated tables. |
| G3 | **Heavy analytics are precomputed in the poller process** (`pollerProcess.js`, LM poller tick or a new cron tier) and written to a table. Routes only read that table. Target: any new route answers in under 200 ms on the live DB. |
| G4 | **Migrations only run at process start.** After adding a migration, restart both pm2 apps (`cohesity-dashboard`, `cohesity-poller`). |
| G5 | **Verify datapoints before building on them.** Many catalog entries are loose regexes marked UNVERIFIED (see section 2.4). Every WP that depends on one starts with the verification query in section 6 and records the result in `backend/services/logicmonitorCatalog.js` comments. If an entry is changed to `exact(...)`, bump `CATALOG_VERSION`. A catalog key change triggers a relearn of the cached `lm_sources.features_json.dsColumns`. |
| G6 | **Uneven sampling.** The metrics tier is capped at 300 data calls per run (`lm_metrics_data_calls_per_tick`), with about 2,250 candidates on the live portal. A given device can be hours stale. Trend and forecast code must weight by sample count and timestamp, never by row index. It must show "insufficient data" instead of extrapolating from fewer than N points (default N = 7 daily points for a forecast). |
| G7 | **Demo and test parity.** Every new table or feed gets demo data in `backend/demo/generators/logicmonitor.js`, is added to the `seedDemo` table lists (`backend/demo/seedDemo.js` and the `TABLES` arrays in the LM tests), and has a vitest suite under `backend/tests/`. Known pre-existing unrelated failures: seedDemo (zerto, vcenter, LM r3/r8 time-dependent), agentCapabilities tls, aws/platform plugin suites. |
| G8 | **Frontend reuse.** Cisco already reuses LM pages through `apiBase="/cisco"` (`frontend/src/pages/cisco/CiscoReusedPages.jsx`). Prefer the same pattern: extend an LM page and make it apiBase-aware rather than forking it. Reuse `TrendLine`, `AutoTable`, `pointsOf` from `frontend/src/pages/logicmonitor/LmFirewall360.jsx`, plus `StatCard`, `SectionPanel`, `SortTh`. |
| G9 | **Wording.** A forecast is labelled as an estimate and shows its basis, e.g. "linear fit over 28 days, R2 0.82". No fabricated precision. |
| G10 | **Security.** Bind all SQL parameters and compute epochs in JS, as the existing code does. Validate every route param with `express-validator`. Routes inherit the existing auth and permission middleware. Do not add unauthenticated endpoints. |

---

## 2. What exists today (baseline)

### 2.1 Storage and retention

| Table | Content | Default retention | Setting |
|---|---|---|---|
| `lm_ds_metrics` | Latest value per device / DataSource / instance / metric | latest only | n/a |
| `lm_ds_metrics_history` | Raw samples (~30 min) **only for catalog entries with `{ history: true }`** | **14 days** | `lm_ds_history_days` (3 to 90) |
| `lm_ds_daily` | Per-UTC-day samples/min/sum/max/last for catalog metrics (`kind`) and enabled raw rules | **365 days** | `lm_daily_history_days` (30 to 1095) |
| `lm_device_daily` | Per-device daily state (normal / dead / in SDT) | 365 days | `lm_daily_history_days` |
| `lm_interface_history` | 15-min interface samples: status, in/out Mbps, util %, errors, discards | **30 days** | `lm_interface_history_days` (7 to 90) |
| `lm_interface_daily` | Per-interface daily: samples, down_samples, flaps, max/avg util, errors_sum | 365 days | `lm_daily_history_days` |
| `lm_interface_baseline` | Per-interface per-UTC-hour median and MAD (util, errors) | rebuilt | `lm_if_baseline_days` |
| `lm_alerts` | Alert lifecycle | cleared alerts: 30 days | `lm_alert_retention_days` |
| `lm_issue_history` | ICC issues with first_seen / last_seen / resolved_at | - | - |
| `lm_devices` | Inventory incl. vendor_key, vendor_kind, model, version, site | snapshot | - |

Existing readers to reuse: `backend/services/logicmonitorHistory.js` (`metricDaySeries`, `deviceDailyRows`, `deviceBaseline`, `cpuMemBaseline`, `topCpuBaselines`, `metricsHistoryByDay`) and `backend/services/logicmonitorMetricBaselines.js`. The latter computes hour-of-day median/MAD for families listed in `BASELINE_METRICS`; today that is IP SLA only, and it is designed to opt in other families.

**Key implication.** Long-horizon trends (30 to 365 days) must come from `lm_ds_daily`, `lm_interface_daily` and `lm_device_daily`. Intraday shape (hour of day) comes from `lm_ds_metrics_history`, which has a 14-day window and covers `history: true` metrics only.

### 2.2 Cisco: what the UI shows

Nav: `frontend/src/platforms/cisco/index.jsx`. Pages: Overview, Alerts, Issues, AI Advisor, Devices, Firewalls (ASA / Meraki MX), Wireless (Overview, Controllers, APs, RF, SSIDs), Voice, ISE, Privacy, Settings.

Coverage is strong for wireless, ASA, voice and ISE. **There is no view for campus or DC switching and routing hardware, optics, PoE, routing peers, IP SLA, NTP or interfaces.**

### 2.3 F5: what the UI shows

Nav: `frontend/src/platforms/f5/index.jsx`. Pages: Overview (`F5OverviewPage.jsx`), Alerts, Issues, Advisor, Devices, Load Balancers (wraps `LmLoadBalancersPage`), Privacy, Settings. The device drill-down is `LmLoadBalancer360.jsx`.

- **List columns:** failover, sync, CPU, memory, client connections, pools degraded, members down, wide IPs down, VIPs down, daemons, certificates expiring, state.
- **360 view:** facts, open issues, **24 h CPU trend**, **24 h client/server connection trend**, pools, wide IPs, GTM servers/DCs, virtual servers, hardware, interfaces, daemons, certificates.
- **Overview:** device counts by kind (bigip / gtm / f5os), failed / degraded / ok, pools degraded, certificates expiring in 30 and 90 days, failover active / standby / degraded, daemons down.

**There are no trends beyond 24 h, no forecasts and no HA-pair analysis.**

### 2.4 Catalog entries that matter here (`backend/services/logicmonitorCatalog.js`)

**Cisco (health / optics / routing / ipsla families)**

| DataSource | Metrics | history | Verified? |
|---|---|---|---|
| `Cisco_CPU_SNMP` | cpu_pct | yes | regex |
| `Cisco_MemoryPools_SNMP` | mem_pct | yes | regex |
| `Cisco_FRU_Power` | psu_state (`OperatingStatus`) | no | exact |
| `Cisco_Nexus_FRU_Power`, `Cisco_System_PowerSupplies` | psu_state | no | regex |
| `CiscoFan-` | fan_state | no | regex |
| `Cisco_TemperatureSensors` | temp_c, temp_state | no | regex |
| `Cisco_Entity_Sensors` | sensor_value, sensor_state | no | exact |
| `Cisco_Nexus_Line_Card_Status` | linecard_state, sup1_state, sup2_state | no | exact |
| `Cisco_Nexus_Supervisor_Status` | sup_state | no | exact |
| `Cisco Switch Stack-` / `Cisco Switch Stack Ports-` | stack_member_state, stack_role / stack_port_state | no | exact / regex |
| `Ping` | ping_loss_pct, ping_rtt_ms, ping_rtt_max_ms | no | exact (verified) |
| `Cisco_NTP` | ntp_synced, ntp_stratum, ntp_offset_ms | no | exact (verified) |
| `Cisco_PowerOverEthernet`, `Cisco_Catalyst_PowerOverEthernet` | poe_used_pct, poe_used_watts | no | **regex, UNVERIFIED** |
| `SNMP_Filesystem_Usage` | fs_used_pct, fs_used/total/free_bytes | yes | **bytes UNVERIFIED** |
| `SNMP_Host_Uptime` | uptime_s | no | exact |
| `Cisco_Transceiver_Sensors` | optic_value, optic_low/high_warn, optic_low_alarm, optic_state, optic_if_state (+ rx/tx dBm, bias, voltage fallbacks) | no | exact for the generic sensor-table form; per-metric names are regex |
| `BGP-` | bgp_peer_state, bgp_established_s, bgp_prefixes_in | no | prefixes **regex** |
| `OSPF_Neighbors` | ospf_nbr_state | no | exact |
| `Cisco_EIGRP_Peers` | eigrp_uptime_s | no | regex |
| `CiscoSLA_jitter-`, `Cisco_IPSLA_Statistics`, etc. | rtt_ms, loss_pct, sla_state, mos, icpif, jitter | yes | mixed |

**F5 (loadbalancer family)**

| DataSource | Metrics | history | Verified? |
|---|---|---|---|
| `F5_BigIP_System` | cpu_pct, mem_pct (`MemoryUsage`), mem_used/total_bytes, client_connections, server_connections (LM typo `ServerCurrentConncections`), throughput_bps | yes | exact, except throughput_bps (**regex**) |
| `F5_BigIP_FailoverStatus` | failover_state (enum **UNVERIFIED**: 0 unknown, 1 offline, 2 forced offline, 3 standby, 4 active), sync_state (regex) | no | partial |
| `F5_BigIP_PoolMemberStats` | member_connections, member_bits_in/out (exact); member_avail / member_enabled (**no live datapoint, stays unmatched**) | no | partial |
| `F5_GTM_WideIP-` | wideip_avail, wideip_requests (counter) | no | exact |
| `F5_GTM_VIPs-`, `F5_GTM_Servers-`, `F5_GTM_Datacenters-` | *_avail | no | exact |
| `F5_GTM_Global` | gtm_requests, gtm_resolutions (counters) | no | exact |
| `f5_*_service_status` (big3d, mcpd, tmm, tmrouted, gtmd, gslb) | daemon_exit (0 = running) | no | exact (verified) |
| `F5_BigIP_SSL_VIP_Certs` | cert_days_left | no | regex |
| `F5_BigIP_Memory` | mem_total/avail/free_bytes, swap_total/avail_bytes | yes | exact (verified) |
| `F5_BigIP_Filesystem` | fs_used_pct, fs_inode_pct | no | exact |
| `F5_BigIP_Interfaces` | if_in/out_bytes (B/s), if_errors_in/out, if_drops_in/out (no status datapoint) | no | exact (verified) |
| `F5_BigIP_Fans` / `_Power` / `_Temperature` | fan_state / psu_state / temp_c | no | exact |
| `f5os_*` | disk, fan, memory, temperature, CPU | CPU only | **all regex, UNVERIFIED** |

Known open F5 data-quality items (from repo notes): failover state "unknown" on some units; wide IPs showing 3 of 6 down. Both are unverified. **WP-F0 must resolve them before any F5 analytics ship.**

---

## 3. Cross-cutting work packages

### WP-X1: Trend and forecast service (backend, shared)
- New module `backend/services/logicmonitorTrends.js`. It must be pure (takes `dbh`), like `logicmonitorHistory.js`.
- Functions:
  - `dailySeries(dbh, {sourceId, deviceId, hdsId?, instanceKey?, metric, days, agg: 'max'|'avg'|'min'|'last'})`. `avg` = sum_value / samples.
  - `linearFit(points)` returns `{ slopePerDay, intercept, r2, n }`.
  - `daysUntil(points, threshold, {minPoints=7, minR2=0.5})` returns `{ days | null, basis }`. It returns null when there are too few points, the fit is weak, or the slope points the wrong way.
  - `resetEvents(points)`: detects drops in a monotonic counter (uptime, BGP established time, EIGRP uptime). Returns `[{ at, from, to }]`.
  - `stateChanges(dailyRows)`: a day where `min_value != max_value` on a state metric means a transition that day. This works without raw history.
- New table `lm_trend_findings` (migration in `backend/db/migrations/logicmonitor.js`):
  - Columns: `source_id, lm_device_id, vendor_key, kind, subject, metric, value, threshold, days_to_threshold, slope_per_day, r2, basis_json, computed_at`
  - Primary key: `(source_id, lm_device_id, kind, subject, metric)`
- Computed by a poller job once per hour (or once per day after the daily rollups). Prune rows whose device is stale.
- Feed: `trends` in `connectors/logicmonitor.js`, params `{ vendorKey, kind?, deviceId?, sourceId? }`.
- **Acceptance:**
  - Unit tests for `linearFit`, `daysUntil` (including the insufficient-data and flat cases), `resetEvents` and `stateChanges`.
  - The job runs on the live DB in under 30 s.
  - The feed answers in under 200 ms.

### WP-X2: Retention review
- Optics, PoE, temperature and the F5 connection metrics are not `history: true`, so their only long history is `lm_ds_daily`. That is enough for daily trends.
- Do **not** raise `lm_ds_history_days` globally. Mark specific catalog entries `{ history: true }` only where hour-of-day shape is needed: F5 `client_connections` / `server_connections` (already history) and Cisco `poe_used_watts` (optional).
- **Acceptance:** DB size delta measured and reported before and after.

### WP-X3: Coverage of the metrics tier (optional, measure first)
- Report the number of Cisco and F5 candidates per run, plus the median and p95 age of `lm_ds_metrics.sampled_at_epoch` per family.
- If F5 or Cisco health data is older than 2 h at p50, propose a priority for the families in this contract inside the 300-call cap. Do not raise the cap without approval.

### WP-X4: Fleet hygiene (shared by both platforms)
- **Software version spread.** Group `lm_devices` by vendor_kind, model and version. Show the count per version, the dominant version per model, and outliers.
- **Availability %.** Per device and per site over 30 and 90 days from `lm_device_daily`, excluding SDT days.
- **Alert noise and MTTR.** From `lm_alerts` and `lm_issue_history`: top datasources and devices by alert count, median time to clear, and repeat offenders (more than 3 occurrences in 7 days).
- **Reboots.** Detected through `resetEvents(uptime_s)`. Cisco uses `SNMP_Host_Uptime`. For F5, check whether an uptime datapoint exists in the raw store; if not, mark it N/A.
- Feeds: `fleetVersions`, `availability`, `alertNoise`, each filtered by `vendorKey`.

---

## 4. Cisco work packages

New nav group **"Switching & Routing"** in `frontend/src/platforms/cisco/index.jsx`. Add `requiresFamily` gating like the existing groups, and add new `navSections` keys in `backend/platforms/cisco/index.js`.

### WP-C0: Verify Cisco datapoints (blocking for C3, C4, C6)
Run the queries in section 6 for PoE, optics, BGP prefixes, filesystem bytes and EIGRP. Fix the catalog (switch to `exact`, bump `CATALOG_VERSION`) and record the live device and instance counts per DataSource in catalog comments.

### WP-C1: Hardware Health page (`/cisco/hardware`)
- **Rows:** PSU, fan, temperature, entity sensors, Nexus line card and supervisor, stack member and stack port. One row per component, worst first.
- **Derived:**
  - **Redundancy lost.** The device is up but has only one PSU OK, one supervisor, a stack ring open (any stack_port_state down), or a stack member missing.
  - **Thermal outliers.** temp_c > fleet median for the same `model` + 2xMAD, or above the site median + 2xMAD. When several devices at one site are hot, label it "site HVAC suspected", not "device fault".
  - **Thermal trend.** 30-day `max` slope per sensor from `lm_ds_daily` (WP-X1).
  - **Switchover history.** `stateChanges` on stack_role, sup_state and sup1/sup2_state over 90 days.
- **Tiles:** components failed, devices with lost redundancy, hot sensors, switchovers (30 d).
- **Acceptance:** demo data includes at least one lost-redundancy device and one hot site.

### WP-C2: Interfaces analytics (`/cisco/interfaces`)
- Reuse `LmInterfacesPage.jsx` with `apiBase="/cisco"`, filtered to Cisco devices. Add tabs:
  - **Hot.** Top N by p95/max util over 7 days. Forecast days to 80% from `lm_interface_daily.max_in_util_pct` / out (WP-X1).
  - **Flapping.** Top N by `flaps` and `down_samples` over 7 and 30 days.
  - **Errors.** errors_sum and discards, plus deviation from `lm_interface_baseline` (current error rate > median + 3xMAD for that hour).
- Drill-down reuses `LmInterfaceHistoryModal.jsx` and `LmInterfaceCompareModal.jsx`.

### WP-C3: Optics (`/cisco/optics`), depends on C0
- **Rows:** per transceiver, with value, warn/alarm thresholds, `margin = value - low_warn` (dB) for Rx power, and state.
- **Derived:**
  - Margin trend over 30 to 90 days from `lm_ds_daily` (`min`).
  - `daysUntil(margin, 0)`, i.e. "estimated days until the Rx low warning".
  - Flag a margin under 2 dB, or a margin dropping faster than 0.1 dB per day. This is the predictive "dirty or failing fibre" signal.
- The sensor kind is in the instance name for the generic sensor-table form. Parse "Rx Power", "Tx Power", "Temperature", "Bias" and "Voltage" from the instance name, and document the parser with live examples.

### WP-C4: PoE budget (`/cisco/poe` or a section on Hardware), depends on C0
- **Rows:** per switch or stack member, with poe_used_watts, poe_used_pct, budget (= watts / pct x 100 when both are present) and headroom in watts.
- **Derived:**
  - 30-day trend.
  - Days until 90% of budget.
  - Site roll-up of headroom (useful before AP or phone refreshes).

### WP-C5: Routing peers (`/cisco/routing`)
- **Rows:** BGP, OSPF and EIGRP peers per device, with state, established time / uptime and prefixes in.
- **Derived:**
  - Peer flaps over 7 and 30 days, via `resetEvents` on bgp_established_s / eigrp_uptime_s, plus `stateChanges` on the state metrics.
  - Prefix-count drift: today vs the 7-day median, flagged when +-20%.
  - Peers not established.
- **Rule:** a peer that is down while its device is dead is shadowed (follow the existing `isShadowedIssue` convention), not double-counted.

### WP-C6: Device resources (section on the device drill-down, plus a fleet table)
- cpu_pct and mem_pct trends over 30 to 90 days (daily max and avg).
- **Memory creep:** positive mem_pct slope with R2 > 0.7 over at least 14 days and no reboot in the window. Label it "possible leak, review IOS-XE version". Cross-reference WP-X4 version spread.
- **Flash:** fs_used_pct slope plus `daysUntil(95)`.
- Reuse `cpuMemBaseline` / `topCpuBaselines`.

### WP-C7: Reachability and time (`/cisco/reachability`, or reuse `LmReachabilityPage.jsx` with apiBase)
- **Ping:** loss % and RTT trends from `lm_ds_daily`, worst N devices, per-site RTT distribution.
- **IP SLA:** extend `BASELINE_METRICS` usage to show MOS / jitter / loss per probe with hour-of-day drift (already computed). Reuse it, don't rebuild it.
- **NTP hygiene:** unsynced count, stratum distribution, |offset| > 100 ms outliers.

### WP-C8: Wireless additions (extend existing pages, low priority)
- **AP load imbalance per controller and site.** Coefficient of variation of AP client counts. Also list APs with 0 clients for 7 days ("possible dead zone or misplacement").
- **Channel utilization trend** per band over 30 days from `lm_ds_daily` (today the page shows 24 h only).
- **RADIUS auth failure ratio** trend: failures / requests per server.

### WP-C9: Cisco Overview tiles and Advisor
- **Overview tiles:** lost redundancy, optics at risk, interfaces forecast to 80% within 30 d, peers flapping, reboots (7 d).
- **Advisor:** add the new findings to the `cisco_switching_hardware` and `cisco_health` gathers in `backend/services/advisors/ciscoAdvisor.js`. Keep the existing anonymisation.

---

## 5. F5 work packages

New nav items in `frontend/src/platforms/f5/index.jsx` under Inventory / a new **"Analytics"** group, and matching `navSections` in `backend/platforms/f5/index.js`.

### WP-F0: Verify F5 datapoints (blocking for every F5 WP)
- **Failover enum.** Dump the distinct `FailoverStatus` values per device on the live portal. Confirm 3 = standby and 4 = active, and explain the "unknown" units.
- **Wide IPs.** Confirm the `AvailStatus` enum (the F5 MIB uses 1 green, 2 yellow, 3 red, 4 blue/unknown, 5 grey). Explain why 3 of 6 show down.
- **throughput_bps.** Find the exact datapoint name on `F5_BigIP_System`, or drop the metric.
- **sync_state.** Exact datapoint name and enum.
- **cert_days_left.** Exact datapoint name on `F5_BigIP_SSL_VIP_Certs`.
- **F5OS.** Check whether any devices exist. If they do, verify the names; if none do, leave the entries as they are.
- **Uptime.** Check whether any F5 DataSource carries uptime (needed for WP-X4 reboots).
- Record the findings in catalog comments and bump `CATALOG_VERSION` when picks change.

### WP-F1: HA pair analysis (`/f5/ha`)
- **Pairing.** Pair units by device group, or by the same site plus a name stem (e.g. `-01` / `-02`). Make the pairing rule a pure function with tests. Allow a manual override later (out of scope).
- **Per pair:**
  - Active / standby roles.
  - **Both active** (critical, split brain).
  - **Neither active** (critical).
  - Sync state.
  - **Days since last failover** (`stateChanges` on failover_state from `lm_ds_daily`).
  - **Failover count** over 90 days.
- **Failover headroom.** Active-unit CPU p95 (7 d) + standby CPU baseline, against an 80% limit, i.e. "can the standby absorb the load?" Do the same for connections against the platform maximum when known. If the maximum is unknown, show the absolute numbers only.
- **Asymmetry flag.** The standby carries more than 20% of the active's client connections, which suggests traffic going to the wrong unit or an active/active design. Show it as info, not an error.

### WP-F2: Capacity and trends (`/f5/trends`, plus longer trends on `LmLoadBalancer360`)
- On the 360, extend the existing 24 h CPU / connections charts with a 7 / 30 / 90 day selector. Use `lm_ds_metrics_history` for 7 d or less and `lm_ds_daily` beyond that.
- **Fleet table:** per unit, CPU p95, memory p95, peak client connections, 30-day slope, and days until 80% CPU (WP-X1).
- **Peak-hour profile.** Hour-of-day x day-of-week heatmap of client connections from `lm_ds_metrics_history` (14 d window). Opt in `loadbalancer` metrics in `logicmonitorMetricBaselines.js` (`client_connections`, `cpu_pct`) to get median / MAD per hour and **drift** against the 7-day-ago reference, like the IP SLA reference rows.
- **Connection anomaly.** Client connections more than 3xMAD away from the hour baseline. Flag a sudden drop (an app outage upstream) as well as a spike.
- **Client:server connection ratio** per unit, trended. A sudden change suggests a OneConnect / profile change or a backend problem. Show it as info.
- **Memory pressure.** swap used = swap_total - swap_avail. Any sustained swap use on BIG-IP is a warning. Trend mem_avail_bytes.
- **Filesystem.** fs_used_pct and fs_inode_pct, with slope and `daysUntil(90)` (typically /var/log or /shared).

### WP-F3: Pool and member analytics (section on 360, plus `/f5/pools` fleet view)
- **Single point of failure.** Pools with exactly one member carrying connections, or one member left up. Note that member availability has no datapoint, so infer "carrying traffic" from member_connections / bits.
- **Load imbalance.** Per pool, the coefficient of variation of member_connections and member_bits_in. Flag members at 0 connections while their siblings are above 0 (a silent failure, or a disabled member nobody noticed).
- **Top talkers.** Members and pools by bits in/out.
- The pool name is derived from the instance name before the first `/` or `:`. This is an **assumption** (see the comment in `LmLoadBalancer360.jsx`). WP-F0 must confirm it against live instance names.

### WP-F4: Certificate timeline (`/f5/certificates`)
- Every VIP certificate across the fleet, with device, VIP / profile (from the instance name) and days left.
- Buckets: expired, <7, <30, <60, <90, >90 days. Add a calendar-style list grouped by week of expiry.
- **Dedupe.** The same certificate on both HA units, or on several VIPs, is counted once in the headline. The key is the instance name stem plus days_left +-1.
- Remove the `CERT_DETAIL_CAP = 40` per-device detail loop in `buildOverview` (`backend/platforms/f5/index.js`) by adding a `certificates` feed that answers from `lm_ds_metrics` in one query. This also speeds up the overview.

### WP-F5: GTM / DNS analytics (section, gated on vendor_kind `gtm`)
- Request rate and resolution rate from the `gtm_requests` / `gtm_resolutions` counters: per-day delta from `lm_ds_daily` (max - min of the counter per day, handling counter resets).
- **Resolution ratio:** resolutions / requests, trended.
- **Wide IP availability timeline:** `stateChanges` on wideip_avail over 30 days. Correlate with datacenter / server availability on the same day, i.e. "wide IP down because DC X was down".
- Requests per wide IP: top N, trend.

### WP-F6: Daemon and hardware stability
- **Daemon flaps.** `stateChanges` on daemon_exit per daemon over 30 days. Any non-zero day is shown as an event.
- **Hardware:** fan / PSU / temperature, as in Cisco WP-C1 (redundancy lost, thermal outliers by model). Reuse the C1 code and parametrise it by vendor.
- **Interfaces:** errors and drops per second, trended from `lm_ds_daily`. Top N interfaces by drops. Throughput (if_in/out_bytes x 8) daily max trend.

### WP-F7: F5 Overview tiles and Advisor
- **Overview tiles:** HA pairs at risk (both active / neither active / no headroom), certificates expiring in 30 d (deduped), units forecast to 80% CPU within 30 d, pools with a single point of failure, daemon flaps (7 d).
- **Advisor:** feed the new findings into `backend/services/advisors/f5Advisor.js` gathers, with the existing anonymisation.

---

## 6. Verification queries (run read-only against the live DB before WP-C0 / WP-F0)

Scripts must call `require('dotenv').config({ path: '<repo>/.env' })` before requiring any service (ENCRYPTION_KEY). Put them under `backend/scripts/` and keep them read-only.

```sql
-- Which catalog metrics actually have data, per DataSource, for a vendor
SELECT m.datasource_name, m.metric, COUNT(DISTINCT m.lm_device_id) AS devices, COUNT(*) AS instances,
       MIN(m.value) AS min_v, MAX(m.value) AS max_v,
       MAX(m.sampled_at_epoch) AS newest, MIN(m.sampled_at_epoch) AS oldest
FROM lm_ds_metrics m
JOIN lm_devices d ON d.source_id = m.source_id AND d.lm_device_id = m.lm_device_id
WHERE d.vendor_key = ? AND d.stale = 0
GROUP BY m.datasource_name, m.metric
ORDER BY m.datasource_name, m.metric;

-- Raw datapoint names on a DataSource (to pick exact names)
SELECT datasource_name, datapoint, COUNT(*) AS n
FROM lm_ds_values WHERE datasource_name = ? GROUP BY datapoint ORDER BY n DESC;

-- Depth of daily history available per metric for a vendor
SELECT x.metric, COUNT(DISTINCT x.day) AS days, MIN(x.day) AS first_day
FROM lm_ds_daily x
JOIN lm_devices d ON d.source_id = x.source_id AND d.lm_device_id = x.lm_device_id
WHERE d.vendor_key = ?
GROUP BY x.metric ORDER BY days DESC;

-- Distinct state values (failover, wide IP, sync)
SELECT metric, value, COUNT(*) FROM lm_ds_metrics
WHERE metric IN ('failover_state', 'sync_state', 'wideip_avail') GROUP BY metric, value;
```

Report back in the PR description: the per-DataSource device counts, the history depth, and which WPs are **viable now** vs **blocked on data**.

---

## 7. Suggested order

1. WP-C0, WP-F0 (verification; small)
2. WP-X1 (trend service), WP-F4 (certificates, quick win, also speeds up the F5 overview)
3. WP-F1 (HA), WP-C1 (hardware), WP-C2 (interfaces)
4. WP-F2, WP-F3, WP-C3, WP-C5, WP-C6
5. WP-X4, WP-C4, WP-C7, WP-F5, WP-F6
6. WP-C8, overview tiles and Advisor (WP-C9, WP-F7)

## 8. Out of scope
- New LM API calls or DataSources not already in the catalog.
- Raising `lm_metrics_data_calls_per_tick`.
- Manual HA-pair override UI.
- EoL / PSIRT lookups (WP-X4 only prepares the version data for them).
- Changes to the LogicMonitor platform pages beyond making them apiBase-aware for reuse.

## 9. Definition of done (per WP)
- The feed, the route and the page exist, with demo data and a vitest suite. `npm test` shows no new failures beyond the known list in G7.
- No request path calls `computeIssues()` or scans all of `lm_ds_metrics`. Route timing has been checked on the live DB.
- Any catalog changes carry verified-name comments and a `CATALOG_VERSION` bump.
- Both pm2 apps have been restarted after a migration, and the new table is visible.
- Forecasts show their basis and return "insufficient data" when the G6 thresholds aren't met.
