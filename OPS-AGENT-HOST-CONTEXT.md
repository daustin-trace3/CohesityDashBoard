# Ops Agent: host context for triage (incidents #690 / #693 review)

Dev box, 2026-10-21. Proposal for the builder; no code changed yet.

## What happened

| Time (PT) | Event |
|---|---|
| 10:39:56 | LM `ntm_linux_ssh_processes-dad` on x131507.cgftdev.com: Status = 0.0 (critical) |
| 10:40:52 | Agent opens #690, key `host:x131507` (grouping `component`, hold 0 min) |
| 10:40:53 | Capabilities: DNS ok, ping 0 ms, TCP 22 open (443/161 refused), TLS n/a, no SDT, no LM path/port |
| 10:41:12 | AI triage: `recurring`, medium, `human_required`; likely cause "LM collector/credential/script issue" |
| 10:49 | LM clears the alert |
| 10:50:52 | Agent resolves #690: "Every alert in this incident cleared." (auto-resolve quiet window 0) |
| 10:54 / 10:58 | `falcon-sensor`, then `postfix` drop to 0 on the same host; agent opens #693 (`recurring`, high, "Falcon sensor crashing") |

Nobody was notified (agent email off on dev; prod has it).

## Why the conclusion was wrong

The collector theory does not hold:

- Only one process check went to 0. A collector or SSH failure would zero every process check on the host at once.
- Collector `CGUSER\W078598` serves 154 hosts; no other host raised an `ssh_processes` alert in 30 days.
- On this host, process checks fail one at a time: `cdpmgr`/`postfix` (Aug 3 to Oct 19, then not_reported), `rsyslogd` (Oct 16, 6 min), `dad` (today, 10 min), `falcon-sensor`/`postfix` (today, open).

The data ICC already holds points at the host:

| Source | Last 10 days on x131507 |
|---|---|
| LM CPU/Memory alerts | CPUBusyPercent 94-100% on Oct 12, 13, 15, 17; PercentUsedMemory 93% (Oct 15); **SwapUtilization 99.4%** (Oct 16) |
| LM Filesystems | root 96%, `/users` 95% (Oct 14) |
| LM Ping / HostStatus | host unreachable on Oct 12 and Oct 15 |
| vCenter events | powered off Oct 12 (relocated ae01 -> ae09) and Oct 15; daily "Guest operation authentication failed for List Processes" ~15:35 PT |
| vCenter VM memory | **737 MB (09:46) -> 2,703 MB (10:46) -> 5,652 MB (11:01)** of 12 GB, rising as the processes dropped |

Memory climbing, swap previously full, and processes dying one by one fits memory pressure (possibly the OOM killer). That is a hypothesis to confirm on the host.

## Why the agent missed it

1. **Recurrence is by incident key only.** `recurrenceFor` reads prior `ops_incidents` for `host:x131507`. #642 (a ping-loss/CPU incident) was treated as the same thing; the host's own LM alert history (`lm_alerts`) never reaches triage, and the CPU/memory/swap alerts had cleared before #690.
2. **vCenter evidence is a liveness check only.** Power state and Tools status. No capacity trend, no boot time, no power/relocation/guest-op events. Capacity is sampled roughly hourly (gaps up to 2 h), so a 10-minute spike will not land in one sample; the trend still shows it.
3. **No datasource semantics.** The model read "port 22 open, so the check is broken". For `*_processes`, 0 means no matching process.
4. **Triage before duration is known, nothing at close.** Hold 0 means triage ran 20 s in; auto-resolve 0 means the clear closed it with no note, so the next incident had no useful history.

## Proposed changes (`backend/services/opsAgent.js`)

1. **Host alert history in evidence.** For host-keyed incidents, add the device's LM alerts for the last 14 days (cleared included), grouped by datasource: count, peak value, last start/end, still open. Include alerts that went `not_reported` while in alert.
2. **VM context in evidence.** From `vcenter_vms`, `vcenter_vm_capacity_history`, `vcenter_events`:
   - current CPU/memory vs the VM's 30-day avg and max, plus the last 24 h samples;
   - boot time (from `uptime_seconds`);
   - power-off, relocation and guest-op warnings in the last 14 days.
3. **Prompt guidance.** A `*_processes` value of 0 means no matching process, not a failed check. When process checks drop on a host with recent CPU/memory/swap/filesystem pressure or reboots, classify it as a host issue and say so.
4. **Closing note.** When a triaged, `human_required` incident clears on its own, write a short resolution: what cleared, how long it lasted, any matching resource signal. Today it is the bare "Every alert in this incident cleared."

## Settings to consider (no code)

- `ops_agent_hold_minutes` about 5, so short blips self-clear before triage and the rest are triaged with a known duration.
- `ops_agent_auto_resolve_minutes` about 30, so re-fires on the same host fold into the open incident instead of opening a new one.

## Separate follow-ups

- Host owner: check x131507 memory, swap and the kernel log (OOM kills) now; `falcon-sensor` and `postfix` are down.
- Something hits VMware guest operations "List Processes" on x131507 daily with bad credentials; find the tool and fix or disable it.
- LM: find out why `cdpmgr`/`postfix` went `not_reported` on Oct 19 after 77 days critical.
