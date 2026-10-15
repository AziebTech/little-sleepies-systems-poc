// Structural checks on the generated workflows: the kind of mistakes that only
// show up at runtime in n8n (dangling connections, renamed nodes, stale exports).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import {
  CREDENTIALS, criticalPath, errorHandler, freshness, poDelivery, shopifyOrders, shopifyProduct, skuProvision,
} from '../../n8n/build-workflows.mjs';
import { ROOT } from './helpers.mjs';

const workflows = {
  'LS-00_global_error_handler.json': errorHandler(),
  'LS-01_airtable_to_erpnext_sku.json': skuProvision(),
  'LS-02_erpnext_po_to_airtable.json': poDelivery(),
  'LS-03_pipeline_health_check.json': freshness(),
  'LS-04_erpnext_item_to_shopify.json': shopifyProduct(),
  'LS-05_shopify_order_to_erpnext.json': shopifyOrders(),
  'LS-06_launch_critical_path.json': criticalPath(),
};
const credIds = new Set(Object.values(CREDENTIALS).map((c) => c.id));

for (const [file, wf] of Object.entries(workflows)) {
  describe(wf.name, () => {
    const names = new Set(wf.nodes.map((n) => n.name));

    it('has unique node names', () => assert.equal(names.size, wf.nodes.length));

    it('only connects nodes that exist', () => {
      for (const [from, { main }] of Object.entries(wf.connections)) {
        assert.ok(names.has(from), `unknown source ${from}`);
        for (const out of main) for (const { node } of out) assert.ok(names.has(node), `unknown target ${node}`);
      }
    });

    it("only references nodes that exist via $('Node')", () => {
      const refs = [...JSON.stringify(wf.nodes).matchAll(/\$\(\\?['"]([^'"\\]+)\\?['"]\)/g)].map((m) => m[1]);
      for (const r of refs) assert.ok(names.has(r), `$('${r}') does not exist`);
    });

    it('has Code nodes that parse', () => {
      for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
        // n8n runs Code nodes as async functions (top-level await is allowed).
        assert.doesNotThrow(() => new vm.Script(`(async function () {\n${n.parameters.jsCode}\n})`), n.name);
      }
    });

    it('never sets Retry On Fail on nodes with an error output (n8n ignores it there)', () => {
      for (const n of wf.nodes.filter((x) => x.onError === 'continueErrorOutput')) {
        assert.ok(!n.retryOnFail, `${n.name} has retryOnFail, which will silently not retry`);
      }
    });

    it('uses only known credential IDs', () => {
      for (const n of wf.nodes) {
        for (const c of Object.values(n.credentials || {})) assert.ok(credIds.has(c.id), `${n.name}: ${c.id}`);
      }
    });

    it('committed JSON matches the source (run `npm run build` if this fails)', () => {
      const onDisk = JSON.parse(readFileSync(join(ROOT, 'n8n', 'workflows', file), 'utf8'));
      assert.deepEqual(onDisk, JSON.parse(JSON.stringify(wf)));
    });
  });
}

it('every workflow except the handler routes crashes to LS-00', () => {
  for (const wf of Object.values(workflows)) {
    if (wf.id === 'lsWf00ErrorHndlr') continue;
    assert.equal(wf.settings.errorWorkflow, 'lsWf00ErrorHndlr', wf.name);
  }
});
