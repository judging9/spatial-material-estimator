import { normalizeDecimal } from './pricing.js';
export const MAX_EARTHWORK_TRANSFER_ROADS = 12;
export const MAX_EARTHWORK_TRANSFER_ROUTES = 132;
/** No implicit soil compatibility, route, price or distance. Enabling a route
 * means the user has confirmed its source soil is usable at its destination. */
export function createEarthworkTransfer() { return { enabled: false, roadIds: [], routes: [] }; }
function identifier(value, label) {
    if (typeof value !== 'string' || !value.trim() || value.length > 200)
        throw new RangeError(`${label}无效。`);
}
function optionalDecimal(value, label) {
    if (typeof value !== 'string')
        throw new RangeError(`${label}须为十进制字符串，待填写时留空。`);
    if (value !== '')
        normalizeDecimal(value, label);
}
export function validateEarthworkTransferConfig(config) {
    if (config === undefined)
        return;
    if (!config || typeof config !== 'object' || typeof config.enabled !== 'boolean' || !Array.isArray(config.roadIds) || !Array.isArray(config.routes))
        throw new RangeError('跨道路土方调配配置无效。');
    if (config.roadIds.length > MAX_EARTHWORK_TRANSFER_ROADS)
        throw new RangeError(`跨道路调配最多选择 ${MAX_EARTHWORK_TRANSFER_ROADS} 条道路。`);
    if (config.routes.length > MAX_EARTHWORK_TRANSFER_ROUTES)
        throw new RangeError(`跨道路调配最多设置 ${MAX_EARTHWORK_TRANSFER_ROUTES} 条方向路线。`);
    const roads = new Set();
    for (const id of config.roadIds) {
        identifier(id, '道路编号');
        if (roads.has(id))
            throw new RangeError('参与调配的道路不能重复。');
        roads.add(id);
    }
    const routeIds = new Set(), pairs = new Set();
    for (const route of config.routes) {
        if (!route || typeof route !== 'object' || typeof route.enabled !== 'boolean')
            throw new RangeError('跨道路运输路线开关无效。');
        identifier(route.id, '运输路线编号');
        identifier(route.fromRoadId, '土方来源道路');
        identifier(route.toRoadId, '土方目标道路');
        if (route.fromRoadId === route.toRoadId)
            throw new RangeError('跨道路运输不能选择相同来源与目标道路。');
        const pair = JSON.stringify([route.fromRoadId, route.toRoadId]);
        if (routeIds.has(route.id) || pairs.has(pair))
            throw new RangeError('运输路线编号或相同方向路线不能重复。');
        routeIds.add(route.id);
        pairs.add(pair);
        optionalDecimal(route.distanceKm, '跨道路运距');
        optionalDecimal(route.unitPrice, '跨道路松方运输单价');
    }
}
const power = (scale) => 10n ** BigInt(scale);
/** Inputs use the established decimal parser. All intermediate products and
 * comparisons remain BigInt, without converting a quantity or a cost to Number. */
function exact(value) {
    const normalized = normalizeDecimal(value), parts = normalized.split('.');
    return { coefficient: BigInt(parts.join('')), scale: parts[1]?.length ?? 0 };
}
function plain(coefficient, scale) {
    if (coefficient === 0n)
        return '0';
    while (scale > 0 && coefficient % 10n === 0n) {
        coefficient /= 10n;
        scale--;
    }
    const negative = coefficient < 0n, digits = (negative ? -coefficient : coefficient).toString();
    if (!scale)
        return (negative ? '-' : '') + digits;
    const padded = digits.padStart(scale + 1, '0');
    return `${negative ? '-' : ''}${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}
const product = (a, b) => ({ coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale });
const units = (value, scale) => value.coefficient * power(scale - value.scale);
const minimum = (a, b) => a < b ? a : b;
function money(value) {
    const numerator = value.coefficient * (value.scale <= 2 ? power(2 - value.scale) : 1n), denominator = value.scale > 2 ? power(value.scale - 2) : 1n;
    const rounded = numerator / denominator + (numerator % denominator * 2n >= denominator ? 1n : 0n), digits = rounded.toString().padStart(3, '0');
    return digits.slice(0, -2) + '.' + digits.slice(-2);
}
const moneyFromCents = (value) => { const digits = value.toString().padStart(3, '0'); return digits.slice(0, -2) + '.' + digits.slice(-2); };
const cents = (value) => BigInt(value.replace('.', ''));
function nullable(value, label, positive = false) {
    if (value === null || value === '')
        return null;
    if (typeof value !== 'string')
        throw new RangeError(`${label}须为十进制字符串或待确认。`);
    const normalized = normalizeDecimal(value, label);
    if (positive && normalized === '0')
        throw new RangeError(`${label}必须大于零。`);
    return normalized;
}
function less(a, b) { const x = exact(a), y = exact(b), scale = Math.max(x.scale, y.scale); return units(x, scale) < units(y, scale); }
function connect(graph, from, to, capacity, cost) {
    const edge = { to, reverse: graph[to].length, capacity, cost }, reverse = { to: from, reverse: graph[from].length, capacity: 0n, cost: -cost };
    graph[from].push(edge);
    graph[to].push(reverse);
    return edge;
}
/** Successive shortest augmenting paths on the residual network. Reverse
 * transport edges allow earlier assignments to be rerouted; nearest-route
 * greedy allocation cannot guarantee maximum reuse or minimum haulage. */
function maximumMinimumCostFlow(graph, source, sink) {
    for (;;) {
        const distances = Array(graph.length).fill(null), previousNode = Array(graph.length).fill(-1), previousEdge = Array(graph.length).fill(-1);
        distances[source] = 0n;
        for (let iteration = 0; iteration < graph.length - 1; iteration++) {
            let changed = false;
            for (let from = 0; from < graph.length; from++)
                if (distances[from] !== null)
                    for (let index = 0; index < graph[from].length; index++) {
                        const edge = graph[from][index];
                        if (edge.capacity === 0n || edge.to === source)
                            continue;
                        const distance = distances[from] + edge.cost;
                        if (distances[edge.to] === null || distance < distances[edge.to]) {
                            distances[edge.to] = distance;
                            previousNode[edge.to] = from;
                            previousEdge[edge.to] = index;
                            changed = true;
                        }
                    }
            if (!changed)
                break;
        }
        if (distances[sink] === null)
            return;
        let flow = null, current = sink, hops = 0;
        while (current !== source) {
            if (previousNode[current] < 0 || hops++ >= graph.length)
                throw new RangeError('土方调配残余路径无效。');
            const edge = graph[previousNode[current]][previousEdge[current]];
            flow = flow === null ? edge.capacity : minimum(flow, edge.capacity);
            current = previousNode[current];
        }
        current = sink;
        while (current !== source) {
            const from = previousNode[current], edge = graph[from][previousEdge[current]];
            edge.capacity -= flow;
            graph[current][edge.reverse].capacity += flow;
            current = from;
        }
    }
}
/** Maximise compatible natural-volume reuse first. Among plans with that same
 * reuse, minimise exact haulage cost. This is not minimum total project cost:
 * external borrowing/disposal rates do not change the stated reuse priority. */
export function calculateEarthworkTransfer(input, config) {
    validateEarthworkTransferConfig(config);
    if (!input || !Array.isArray(input.roads) || input.roads.length > 500)
        throw new RangeError('跨道路土方测量数据无效。');
    const result = { enabled: Boolean(config?.enabled), complete: true, pending: false, pendingReasons: [], pendingReason: null, roads: [], routes: [], transferredNatural: '0', knownHaulCost: '0.00', totalHaulCost: '0.00' };
    if (!config?.enabled)
        return result;
    const sourceMap = new Map();
    for (const road of input.roads) {
        if (!road || typeof road !== 'object')
            throw new RangeError('土方道路测量记录无效。');
        identifier(road.id, '道路编号');
        if (sourceMap.has(road.id))
            throw new RangeError('道路测量记录编号不能重复。');
        sourceMap.set(road.id, road);
    }
    const reasons = [];
    for (const id of config.roadIds) {
        const road = sourceMap.get(id);
        if (!road) {
            reasons.push(`参与调配的道路 ${id} 已不存在，请重新选择。`);
            result.roads.push({ id, name: id, availableNatural: null, borrowNatural: null, spoilNatural: null, loosePerNatural: null, incomingNatural: null, outgoingNatural: null, residualBorrowNatural: null, residualSpoilNatural: null });
            continue;
        }
        if (typeof road.name !== 'string' || typeof road.complete !== 'boolean' || road.pendingReasons !== undefined && (!Array.isArray(road.pendingReasons) || road.pendingReasons.some(reason => typeof reason !== 'string')))
            throw new RangeError('道路测量名称或完整性状态无效。');
        const row = { id, name: road.name, availableNatural: nullable(road.availableNatural, '可调出天然方'), borrowNatural: nullable(road.borrowNatural, '剩余借方天然体积'), spoilNatural: nullable(road.spoilNatural, '剩余弃方天然体积'), loosePerNatural: nullable(road.loosePerNatural, '来源天然方转松方系数', true), incomingNatural: null, outgoingNatural: null, residualBorrowNatural: null, residualSpoilNatural: null };
        if (row.availableNatural !== null && row.spoilNatural !== null && less(row.spoilNatural, row.availableNatural))
            throw new RangeError(`${row.name}可调出天然方不能大于剩余弃方，不能调运不存在的土方。`);
        if (!road.complete || [row.availableNatural, row.borrowNatural, row.spoilNatural, row.loosePerNatural].some(value => value === null))
            reasons.push(...(road.pendingReasons?.filter(Boolean).length ? road.pendingReasons.filter(Boolean).map(reason => `${road.name}：${reason}`) : [`${road.name}土方测量或换算参数尚未完整确认。`]));
        result.roads.push(row);
    }
    const rows = new Map(result.roads.map(row => [row.id, row]));
    for (const route of config.routes.filter(route => route.enabled)) {
        const from = rows.get(route.fromRoadId), to = rows.get(route.toRoadId), name = `${from?.name ?? route.fromRoadId} → ${to?.name ?? route.toRoadId}`;
        const row = { id: route.id, fromRoadId: route.fromRoadId, toRoadId: route.toRoadId, name, distanceKm: route.distanceKm === '' ? '' : normalizeDecimal(route.distanceKm), unitPrice: route.unitPrice === '' ? '' : normalizeDecimal(route.unitPrice), naturalQuantity: null, looseQuantity: null, haulQuantity: null, amount: null, pending: false, pendingReasons: [], pendingReason: null };
        if (!from || !to)
            reasons.push(`${name}路线端点未选入调配，请重新选择道路或删除路线。`);
        const potential = from?.availableNatural !== null && from?.availableNatural !== undefined && to?.borrowNatural !== null && to?.borrowNatural !== undefined && from.availableNatural !== '0' && to.borrowNatural !== '0';
        if (potential) {
            if (row.distanceKm === '')
                reasons.push(`${name}跨道路运距待填写（km）。`);
            if (row.distanceKm !== '0' && row.unitPrice === '')
                reasons.push(`${name}松方运输单价待填写。`);
        }
        result.routes.push(row);
    }
    if (reasons.length) {
        result.pendingReasons = [...new Set(reasons)];
        result.pendingReason = result.pendingReasons.join('；');
        result.pending = true;
        result.complete = false;
        result.transferredNatural = null;
        result.totalHaulCost = null;
        for (const route of result.routes) {
            route.pending = true;
            route.pendingReasons = [...result.pendingReasons];
            route.pendingReason = result.pendingReason;
        }
        return result;
    }
    const volumeScale = Math.max(0, ...result.roads.flatMap(row => [row.availableNatural, row.borrowNatural, row.spoilNatural].map(value => exact(value).scale))), count = result.roads.length, source = count * 2, sink = source + 1;
    const graph = Array.from({ length: sink + 1 }, () => []), indexes = new Map(result.roads.map((row, index) => [row.id, index]));
    const available = result.roads.map(row => units(exact(row.availableNatural), volumeScale)), borrow = result.roads.map(row => units(exact(row.borrowNatural), volumeScale));
    const rateCosts = result.routes.map(route => {
        const from = rows.get(route.fromRoadId), to = rows.get(route.toRoadId);
        if (from.availableNatural === '0' || to.borrowNatural === '0')
            return { coefficient: 0n, scale: 0 };
        return product(product(exact(from.loosePerNatural), exact(route.distanceKm)), exact(route.unitPrice || '0'));
    });
    const costScale = Math.max(0, ...rateCosts.map(value => value.scale));
    result.roads.forEach((row, index) => { connect(graph, source, index, available[index], 0n); connect(graph, count + index, sink, borrow[index], 0n); });
    const routeEdges = result.routes.map((route, index) => { const from = indexes.get(route.fromRoadId), to = indexes.get(route.toRoadId), capacity = minimum(available[from], borrow[to]); return { capacity, edge: connect(graph, from, count + to, capacity, units(rateCosts[index], costScale)) }; });
    maximumMinimumCostFlow(graph, source, sink);
    const incoming = Array(count).fill(0n), outgoing = Array(count).fill(0n);
    let totalFlow = 0n, totalCents = 0n;
    result.routes.forEach((route, index) => {
        const flow = routeEdges[index].capacity - routeEdges[index].edge.capacity, from = indexes.get(route.fromRoadId), to = indexes.get(route.toRoadId), natural = { coefficient: flow, scale: volumeScale };
        incoming[to] += flow;
        outgoing[from] += flow;
        totalFlow += flow;
        const loose = product(natural, exact(result.roads[from].loosePerNatural)), haul = product(loose, exact(route.distanceKm || '0')), amount = product(haul, exact(route.unitPrice || '0'));
        route.naturalQuantity = plain(flow, volumeScale);
        route.looseQuantity = plain(loose.coefficient, loose.scale);
        route.haulQuantity = plain(haul.coefficient, haul.scale);
        route.amount = money(amount);
        totalCents += cents(route.amount);
    });
    result.roads.forEach((road, index) => { road.incomingNatural = plain(incoming[index], volumeScale); road.outgoingNatural = plain(outgoing[index], volumeScale); road.residualBorrowNatural = plain(borrow[index] - incoming[index], volumeScale); road.residualSpoilNatural = plain(units(exact(road.spoilNatural), volumeScale) - outgoing[index], volumeScale); });
    result.transferredNatural = plain(totalFlow, volumeScale);
    result.knownHaulCost = moneyFromCents(totalCents);
    result.totalHaulCost = result.knownHaulCost;
    return result;
}
//# sourceMappingURL=earthwork-transfer.js.map