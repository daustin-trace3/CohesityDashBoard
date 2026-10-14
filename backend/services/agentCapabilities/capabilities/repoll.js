// The agent's self-heal: when an incident holds a poll:/stale: alert, ask the
// platform poller for one re-poll before triage. It changes state (a poll
// runs, data moves), so it is the one action-class capability, listed here
// so a customer who does not want the agent touching pollers can switch it
// off. It is not a playbook probe: opsAgent.runOnce consults isEnabled('repoll')
// and does the work through its own triggerPoll path.
module.exports = {
  id: 'repoll',
  label: 'Re-poll an unreachable or stale source',
  description: 'When ICC could not reach a source, or its data has gone stale, the agent triggers one re-poll of that source before triage and reports whether it answered. On by default because it only asks the poller to do what it does on schedule anyway.',
  risk: 'action',
  defaultEnabled: true,
  playbook: false,
};
