import { normalizeDecimal } from './pricing.js';
/** Editing the draft must not attribute a new hand-entered rate to an old
 * supplier's quotation. Keep the association for a future source refresh. */
export function prepareTunnelPriceEdit(initial, draft) {
    const next = structuredClone(draft);
    const before = initial.unitPrice === '' ? '' : normalizeDecimal(initial.unitPrice), after = next.unitPrice === '' ? '' : normalizeDecimal(next.unitPrice);
    if (before !== after && next.provenance) {
        const previous = next.provenance;
        next.provenance = { source: '用户调整单价', ...(previous.spec ? { spec: previous.spec } : {}), ...(previous.region ? { region: previous.region } : {}) };
    }
    return next;
}
//# sourceMappingURL=tunnel-edit.js.map