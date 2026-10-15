// Mode: Run Once for Each Item
// Input: Error Trigger payload { execution: {...}, workflow: {...} }
// Details of the failed run (empty object if missing, so the lines below never crash).
const exec = $json.execution || {};
// Details of the workflow that failed.
const wf = $json.workflow || {};
// The error itself.
const err = exec.error || {};
// Build the Slack message, one line per piece of information.
const text = [
  // Headline with the workflow name.
  `:rotating_light: *n8n workflow failed*: ${wf.name || 'unknown'}`,
  // Which node was running when it failed.
  `*Node:* ${exec.lastNodeExecuted || 'n/a'}`,
  // The error message, cut to 500 characters so Slack stays readable.
  `*Error:* ${(err.message || 'n/a').slice(0, 500)}`,
  // A link to the failed run, if there is one (otherwise null, removed below).
  exec.url ? `*Execution:* ${exec.url}` : null,
  // Where to look for how to fix it.
  '*Runbook:* docs/RUNBOOK.md#5-incident-response',
// Drop the empty (null) lines, then join the rest with line breaks.
].filter(Boolean).join('\n');

// Send one item on: the fields for the error log table plus the Slack text.
return { json: {
  // The run ID as text, or null if missing.
  execution_id: exec.id != null ? String(exec.id) : null,
  workflow_id: wf.id || null,
  workflow_name: wf.name || null,
  last_node: exec.lastNodeExecuted || null,
  // Full error message, cut to 2000 characters to fit the database.
  error_message: (err.message || '').slice(0, 2000),
  execution_url: exec.url || null,
  slack_text: text,
} };
