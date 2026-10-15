// Prints the four credentials the workflows reference (with their fixed IDs) as JSON on
// stdout, built from .env. `npm run n8n:import` pipes it straight into the n8n container,
// imports it and deletes the temp copy there, so no plain-text secrets file is ever
// written on the host (n8n encrypts credentials at rest once imported).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIALS } from './build-workflows.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const envPath = join(ROOT, '..', '.env');
if (!existsSync(envPath)) {
  console.error('No .env found. Copy .env.example to .env and fill it in first.');
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const missing = ['ERPNEXT_API_KEY', 'ERPNEXT_API_SECRET', 'AIRTABLE_PAT', 'LS_WEBHOOK_TOKEN'].filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}

const creds = [
  { ...CREDENTIALS.erp, data: { name: 'Authorization', value: `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}` } },
  { ...CREDENTIALS.airtable, data: { name: 'Authorization', value: `Bearer ${env.AIRTABLE_PAT}` } },
  { ...CREDENTIALS.webhook, data: { name: 'X-LS-Webhook-Token', value: env.LS_WEBHOOK_TOKEN } },
  {
    ...CREDENTIALS.warehouse,
    data: {
      host: 'warehouse', // docker network hostname, not localhost
      port: 5432,
      database: env.WAREHOUSE_DB || 'ls_warehouse',
      user: env.WAREHOUSE_USER || 'ls_admin',
      password: env.WAREHOUSE_PASSWORD || 'ls_admin_pw',
      ssl: 'disable',
    },
  },
];

process.stdout.write(JSON.stringify(creds));
