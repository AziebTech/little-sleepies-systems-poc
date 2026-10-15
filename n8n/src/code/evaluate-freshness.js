// Mode: Run Once for Each Item
// Thresholds for the sync pipeline health check. Tune per business SLA.
// Alert if: no success in 24 hours, more than 10% of syncs failed, or fewer than 1 sync ran.
const THRESHOLDS = { maxHoursSinceSuccess: 24, maxErrorRate24h: 0.10, minEvents24h: 1 };

// Hours since the last successful sync. If there has never been one (null), use NaN ("not a number").
const h = $json.hours_since_last_success === null ? NaN : Number($json.hours_since_last_success);
// How many syncs ran in the last 24 hours (0 if missing).
const events = Number($json.events_24h) || 0;
// How many of those failed (0 if missing).
const failures = Number($json.failures_24h) || 0;
// Share of syncs that failed, e.g. 0.25 = 25%. If nothing ran, call it 0 (avoids dividing by zero).
const errorRate = events ? failures / events : 0;

// A list of every rule that was broken. Empty list = all healthy.
const breaches = [];
// Rule 1: no successful sync ever, or the last one was too long ago.
if (!Number.isFinite(h) || h > THRESHOLDS.maxHoursSinceSuccess) {
  // Show the hours with 1 decimal, or "recorded history" if there's never been a success.
  breaches.push(`No successful sync in ${Number.isFinite(h) ? h.toFixed(1) + 'h' : 'recorded history'} (max ${THRESHOLDS.maxHoursSinceSuccess}h)`);
}
// Rule 2: too many failures.
if (errorRate > THRESHOLDS.maxErrorRate24h) {
  // Show the rate as a percentage, e.g. "25.0%".
  breaches.push(`24h error rate ${(errorRate * 100).toFixed(1)}% (max ${THRESHOLDS.maxErrorRate24h * 100}%)`);
}
// Rule 3: too few syncs ran at all, which usually means the pipeline is stopped.
if (events < THRESHOLDS.minEvents24h) breaches.push(`Only ${events} sync events in 24h. Is the pipeline running?`);

// Send one result item on to the next node.
return { json: {
  // Hours rounded to 2 decimals, or null if there's never been a success.
  hours_since_last_success: Number.isFinite(h) ? Math.round(h * 100) / 100 : null,
  events_24h: events,
  failures_24h: failures,
  // Error rate rounded to 4 decimals (e.g. 0.1234).
  error_rate_24h: Math.round(errorRate * 10000) / 10000,
  // "breach" if any rule was broken, otherwise "ok".
  status: breaches.length ? 'breach' : 'ok',
  breaches,
  // The Slack message: a bulleted list of problems, or null (no message) if all is fine.
  slack_text: breaches.length ? `:warning: *Sync pipeline health check*\n• ${breaches.join('\n• ')}` : null,
} };
