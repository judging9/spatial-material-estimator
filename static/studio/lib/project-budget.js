import { calculateProject, formatMoney, multiplyDecimal, normalizeDecimal } from './pricing.js';
import { calculateCivilProject } from './civil-pricing.js';
import { calculateMunicipalProject } from './municipal-pricing.js';
const sectionLabels = { decoration: '装修', civil: '土建', municipal: '市政' };
const sectionIds = Object.keys(sectionLabels);
// Components from each quote are already rounded to cents. Never convert a
// monetary string to Number while adding disciplines or calculating global tax.
const cents = (value) => BigInt(formatMoney(value).replace('.', ''));
const money = (value) => {
    const negative = value < 0n, digits = (negative ? -value : value).toString().padStart(3, '0');
    return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
};
const sumMoney = (values) => money(values.reduce((sum, value) => sum + cents(value), 0n));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export function validateProjectBudgetOptions(value) {
    if (value === undefined)
        return;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new RangeError('工程总预算设置格式不正确。');
    const options = value;
    if (Object.keys(options).some(key => !['included', 'client', 'reference', 'note'].includes(key)))
        throw new RangeError('工程总预算包含不支持的设置。');
    if (options.included !== undefined) {
        if (!options.included || typeof options.included !== 'object' || Array.isArray(options.included))
            throw new RangeError('总预算专业范围格式不正确。');
        for (const [key, enabled] of Object.entries(options.included)) {
            if (!sectionIds.includes(key) || typeof enabled !== 'boolean')
                throw new RangeError('总预算专业范围只能使用装修、土建和市政的开关。');
        }
    }
    for (const [key, label, limit] of [['client', '委托单位', 120], ['reference', '项目编号', 120], ['note', '报价说明', 2000]]) {
        if (options[key] === undefined)
            continue;
        if (typeof options[key] !== 'string' || options[key].length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(options[key])) {
            throw new RangeError(`${label}应为不超过 ${limit} 字的有效文字。`);
        }
    }
}
/** The same object scope as existing discipline reports. Empty wall finishes
 * and disabled opening quotations are deliberately absent from the budget. */
export function projectBudgetEntries(section, quote) {
    if (section === 'civil')
        return (quote.civilElements ?? []).map(row => ({ row, targetType: 'civil', targetId: row.id }));
    if (section === 'municipal')
        return (quote.municipalElements ?? []).map(row => ({ row, targetType: 'municipal', targetId: row.id }));
    const entries = [];
    for (const [field, targetType] of [['regions', 'region'], ['walls', 'wall'], ['ceilings', 'ceiling'], ['furniture', 'furniture'], ['serviceRoutes', 'service'], ['openings', 'opening']]) {
        for (const row of quote[field] ?? []) {
            if ((field === 'walls' || field === 'ceilings') && !row.items?.length && cents(row.additionalCost ?? '0') === 0n)
                continue;
            entries.push({ row, targetType, targetId: field === 'ceilings' ? row.regionId ?? row.sourceRegionId ?? String(row.id).replace(/^ceiling:/, '') : row.id });
        }
    }
    return entries;
}
function quoteIssues(section, quote, entries) {
    const issues = [];
    const handled = new Set();
    for (const entry of entries) {
        const row = entry.row;
        const title = row.levelName ? `${row.levelName} / ${row.name}` : row.name || sectionLabels[section];
        const reasons = [...new Set((row.pendingReasons?.length ? row.pendingReasons : row.pendingReason ? [row.pendingReason] : []))];
        const warnings = [...new Set((row.warnings ?? []))];
        for (const [severity, messages] of [['pending', reasons], ['info', warnings]]) {
            for (let index = 0; index < messages.length; index++) {
                const message = messages[index];
                if (!message)
                    continue;
                issues.push({ id: `${section}:${row.levelId ?? ''}:${entry.targetType}:${entry.targetId}:${severity}:${index}`, section,
                    levelId: row.levelId, targetType: entry.targetType, targetId: entry.targetId, title, message, severity });
                if (severity === 'pending') {
                    handled.add(message);
                    handled.add(`${row.name}：${message}`);
                    handled.add(`${row.levelName}：${message}`);
                    handled.add(`${row.levelName} / ${row.name}：${message}`);
                }
            }
        }
    }
    // Some genuine blockers concern a project rather than one quoted object,
    // such as incomplete room generation or a road-transfer network boundary.
    for (const message of quote.pendingReasons ?? []) {
        if (!message || handled.has(message))
            continue;
        issues.push({ id: `${section}:project:pending:${issues.length}`, section, targetType: 'project', title: sectionLabels[section], message, severity: 'pending' });
    }
    return issues;
}
/** Recalculate tax-free discipline quotes instead of adding their independently
 * taxed totals. Fixed fees and tax belong to the whole project exactly once. */
export function calculateProjectBudget(project) {
    if (!project || !Array.isArray(project.regions))
        throw new RangeError('工程总预算项目格式不正确。');
    validateProjectBudgetOptions(project.budget);
    const options = project.budget;
    const input = { ...project, additionalCost: '0', taxRate: '0' };
    const quotes = { decoration: calculateProject(input), civil: calculateCivilProject(input), municipal: calculateMunicipalProject(input) };
    const sections = sectionIds.map(id => {
        const quote = quotes[id], entries = projectBudgetEntries(id, quote);
        const available = entries.length > 0;
        const included = options?.included && own(options.included, id) ? options.included[id] : available;
        return { id, label: sectionLabels[id], included, available, itemCount: entries.length, pending: Boolean(quote.pending),
            knownSubtotal: formatMoney(quote.knownSubtotal), total: quote.pending ? null : formatMoney(quote.knownSubtotal),
            quote, issues: quoteIssues(id, quote, entries) };
    });
    const included = sections.filter(section => section.included);
    const itemCount = included.reduce((count, section) => count + section.itemCount, 0);
    const additionalCost = formatMoney(normalizeDecimal(project.additionalCost ?? '0', '项目固定费用'));
    const taxRate = normalizeDecimal(project.taxRate ?? '0', '工程总预算税率');
    const knownSubtotal = sumMoney([...included.map(section => section.knownSubtotal), additionalCost]);
    const knownTax = formatMoney(multiplyDecimal(knownSubtotal, multiplyDecimal(taxRate, '.01')));
    const knownTotal = sumMoney([knownSubtotal, knownTax]);
    const pending = included.some(section => section.pending);
    const status = !itemCount ? 'empty' : pending ? 'pending' : 'ready';
    const issues = included.flatMap(section => section.issues);
    const pendingReasons = [...new Set(issues.filter(issue => issue.severity === 'pending').map(issue => `${sectionLabels[issue.section]} / ${issue.title}：${issue.message}`))];
    return { kind: 'project-budget', projectId: project.id, name: project.name, currency: 'CNY', sections,
        includedSections: included.map(section => section.id), additionalCost, taxRate, knownSubtotal, knownTax, knownTotal,
        beforeTax: status === 'ready' ? knownSubtotal : null, tax: status === 'ready' ? knownTax : null, total: status === 'ready' ? knownTotal : null,
        pending, status, pendingReasons, issues, itemCount,
        metadata: { client: options?.client ?? '', reference: options?.reference ?? '', note: options?.note ?? '' } };
}
/** A receipt of derived totals, never a replacement for saved source geometry.
 * Importers must recompute it from the original project instead of trusting it. */
export function projectBudgetSnapshot(project) {
    const budget = calculateProjectBudget(project);
    const { kind, projectId, name, currency, includedSections, additionalCost, taxRate, knownSubtotal, knownTax, knownTotal, beforeTax, tax, total, pending, status, pendingReasons, itemCount, metadata } = budget;
    return { kind, projectId, name, currency, includedSections, additionalCost, taxRate, knownSubtotal, knownTax, knownTotal,
        beforeTax, tax, total, pending, status, pendingReasons, itemCount, metadata,
        sections: budget.sections.map(({ id, label, included, available, itemCount, pending, knownSubtotal, total }) => ({ id, label, included, available, itemCount, pending, knownSubtotal, total })) };
}
//# sourceMappingURL=project-budget.js.map