import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { expandIncludes, loadCode } from '../../n8n/build-workflows.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const shopifyWebhookCase = JSON.parse(readFileSync(join(ROOT, 'shared', 'shopify_webhook_case.json'), 'utf8'));

// Loads lib files into an isolated context; top-level `function` declarations become properties.
// Include directives are expanded exactly as the workflow build does.
export function loadLib(...files) {
  const ctx = vm.createContext({});
  for (const f of files) vm.runInContext(expandIncludes(readFileSync(join(ROOT, 'n8n', 'src', 'lib', f), 'utf8')), ctx);
  return ctx;
}

// Cross-realm objects fail deepStrictEqual on prototype checks; normalize via JSON.
export const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function codeNodeContext({ json = {}, items = [], refs = {}, refsAll = {}, env = {} }) {
  return vm.createContext({
    $json: json,
    // items may be plain json, or { json, binary } when a test needs binary data
    $input: { all: () => items.map((j) => (j && j.json ? j : { json: j })) },
    // refs: { 'Node': json } for $('Node').item; refsAll: { 'Node': [json, ...] } for .all()/.first()
    $: (name) => {
      if (name in refsAll) {
        const items = refsAll[name].map((j) => ({ json: j }));
        return { all: () => items, first: () => items[0], item: items[0] };
      }
      if (!(name in refs)) throw new Error(`Code node referenced unmocked node "${name}"`);
      return { item: { json: refs[name] } };
    },
    $env: env,
    $execution: { id: 42 },
    $workflow: { name: 'test-workflow' },
    require: (mod) => {
      if (mod !== 'crypto') throw new Error(`Code node required "${mod}", which is not allowlisted`);
      return crypto;
    },
  });
}

// Executes an n8n Code node body with mocked n8n globals.
export function runCodeNode(file, opts = {}) {
  return plain(vm.runInContext(`(function () {\n${loadCode(file)}\n})()`, codeNodeContext(opts)));
}

// Same, for Code nodes that use `await` / `this.helpers` (binary data).
export async function runCodeNodeAsync(file, { binaries = [], ...opts } = {}) {
  const ctx = codeNodeContext(opts);
  ctx.__helpers = { getBinaryDataBuffer: async (i) => Buffer.from(binaries[i] ?? '', 'utf8') };
  const fn = vm.runInContext(`(async function () {\n${loadCode(file)}\n})`, ctx);
  return plain(await fn.call({ helpers: ctx.__helpers }));
}
