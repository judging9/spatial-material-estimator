import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistory, createMemoryProjectStore, exportProjectJSON, importProjectJSON } from '../static/studio/lib/persistence.js';
import { calculateProjectBudget, projectBudgetSnapshot } from '../static/studio/lib/project-budget.js';
import { budgetFixture } from './project-budget-fixture.mjs';

test('mixed professional choices and metadata survive real storage without reusing mutable snapshots', async () => {
  const p = budgetFixture(), store = createMemoryProjectStore();
  assert.equal(calculateProjectBudget(p).total, '3775.76');
  p.budgetSummary = projectBudgetSnapshot(p);
  await store.saveProject(p);
  p.budget.client = 'changed'; p.budget.included.civil = false;
  const read = await store.loadProject(p.id);
  assert.equal(read.budget.client, '验收甲方');
  assert.equal(calculateProjectBudget(read).total, '3775.76');
  assert.equal(read.budgetSummary.total, '3775.76');
  read.budget.included.decoration = false;
  assert.equal((await store.loadProject(p.id)).budget.included.decoration, true);
});

test('project JSON recomputes the compact combined budget and preserves pending second-floor geometry', async () => {
  const p = budgetFixture({ pending: true });
  p.budgetSummary = { total: '999999.99', sections: [] };
  const json = await exportProjectJSON(p), exported = JSON.parse(json), restored = await importProjectJSON(json);
  assert.equal(exported.budgetSummary.status, 'pending');
  assert.equal(exported.budgetSummary.total, null);
  assert.equal(exported.budgetSummary.knownSubtotal, '3314.00');
  assert.equal(exported.budgetSummary.sections.length, 3);
  assert.ok(exported.budgetSummary.sections.every(section => !('quote' in section)));
  assert.equal(calculateProjectBudget(restored).knownSubtotal, '3314.00');
  assert.equal(restored.levels[1].content.furniture[0].unitPrice, '');
  assert.deepEqual(restored.budget, p.budget);
  assert.equal(p.budgetSummary.total, '999999.99');
});

test('invalid combined budget controls cannot overwrite an existing saved engineering project', async () => {
  const p = budgetFixture(), store = createMemoryProjectStore();
  await store.saveProject(p);
  for (const patch of [{ included: { civil: 'false' } }, { client: 12 }, { note: 'x'.repeat(10001) }]) {
    const bad = structuredClone(p); bad.budget = patch;
    await assert.rejects(async () => store.saveProject(bad));
    await assert.rejects(async () => importProjectJSON(JSON.stringify(bad)));
    assert.equal(calculateProjectBudget(await store.loadProject(p.id)).total, '3775.76');
  }
});

test('undo restores professional scope, exact global tax and delivery metadata together', () => {
  const p = budgetFixture(), history = createHistory(p), next = structuredClone(p);
  next.budget.included.civil = false; next.budget.client = '新版甲方'; next.taxRate = '6';
  history.push(next);
  assert.equal(calculateProjectBudget(history.current()).total, '3438.64');
  const previous = history.undo();
  assert.equal(calculateProjectBudget(previous).total, '3775.76');
  assert.equal(previous.budget.client, '验收甲方');
  assert.equal(calculateProjectBudget(history.redo()).total, '3438.64');
});
