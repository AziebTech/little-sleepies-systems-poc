/**
 * Airtable Automation → "Run a script" action
 * --------------------------------------------
 * Trigger:  "When a record matches conditions" on Colorways where
 *             Production Status is "Approved for Production"  AND  Compliance Status is "Passed"
 *           (Compliance Status is computed by n8n LS-06 from the Compliance Tests table.)
 * Input variables (left panel of the script editor):
 *           recordId  →  "Airtable record ID" from the trigger step
 *
 * What it does:
 *  1. Sets Sync Status = Pending, so people can see the colorway is queued for the ERP.
 *  2. POSTs only the record ID to n8n (LS-01). n8n re-fetches the colorway, its style, print
 *     and size run through the API, so a stale or tampered payload can never be what gets
 *     written to the ERP.
 *  3. If n8n is unreachable, the run is marked failed in Airtable's run history. The LS-01
 *     safety-net poll still picks the colorway up because it stays "Pending".
 *
 * Note: automation scripts have no secret store, so anyone with editor access to this
 * automation can read the token. Use a token that ONLY authorizes this webhook, and rotate it
 * if base access changes. (In production: n8n behind an allowlist or a signed-payload check.)
 */
const N8N_WEBHOOK_URL = 'https://YOUR-TUNNEL.trycloudflare.com/webhook/airtable-approved';
const WEBHOOK_TOKEN = 'paste LS_WEBHOOK_TOKEN here';

const { recordId } = input.config();
const table = base.getTable('Colorways');

await table.updateRecordAsync(recordId, { 'Sync Status': { name: 'Pending' } });

const res = await fetch(N8N_WEBHOOK_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-LS-Webhook-Token': WEBHOOK_TOKEN },
  body: JSON.stringify({ recordId, source: 'airtable-automation', sentAt: new Date().toISOString() }),
});

output.set('httpStatus', res.status);
if (!res.ok) {
  // Throwing marks this automation run as failed so it is visible in run history.
  throw new Error(`n8n webhook returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
