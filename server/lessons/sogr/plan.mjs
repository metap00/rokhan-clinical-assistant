// Vendored from bin/plan.mjs (SPEC §8): the pure plan functions. The CLI part and the state-file helpers are not copied.
import { unitGuideline } from './state.mjs';

/** Plan after adding new units and dropping unsent units that no longer exist. */
export function refreshPlan(state, ids) {
  const sent = new Set(state.sent.filter((s) => s.tip === 'lectura').map((s) => s.unit));
  const skipped = new Set((state.sarite || []).map((s) => (typeof s === 'string' ? s : s.unit))); // skipped on request: never come back
  const have = new Set(ids);
  const plan = state.plan.filter((u) => have.has(u) || sent.has(u));
  const inPlan = new Set(plan);
  for (const id of ids) if (!inPlan.has(id) && !skipped.has(id)) plan.push(id);
  return plan;
}

/** Reorder the not-yet-sent part of the plan by guideline number. */
export function reorderPlan(plan, cursor, order) {
  const done = plan.slice(0, cursor);
  const rest = plan.slice(cursor);
  const nrs = order.map((n) => String(n).padStart(2, '0'));
  const out = [];
  for (const nr of nrs) out.push(...rest.filter((u) => unitGuideline(u) === nr));
  out.push(...rest.filter((u) => !nrs.includes(unitGuideline(u))));
  return [...done, ...out];
}
