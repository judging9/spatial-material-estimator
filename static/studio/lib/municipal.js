import { createCostItem, applyModulePrices } from './cost.js';
import { formatQuantity } from './pricing.js';
export function defaultMunicipalConfig() {
    return {
        road: { length: 0, grade: 'branch', width: 12, carriageway: 8, sidewalk: 2, layers: [
                { name: 'AC-13 沥青面层', thickness: 4, unit: 't', scope: 'carriageway', density: 2.4 },
                { name: 'AC-20 沥青面层', thickness: 6, unit: 't', scope: 'carriageway', density: 2.4 },
                { name: '水泥稳定碎石基层', thickness: 20, unit: 'm³', scope: 'full' },
                { name: '级配碎石垫层', thickness: 20, unit: 'm³', scope: 'full' },
            ] },
        drainage: { rain: true, sewer: true, diameterRain: 600, diameterSewer: 400, depth: 2.5, manholeSpacing: 50, manholeSize: 1.2 },
        lighting: { enabled: true, spacing: 30, side: 'both', height: 8 },
        greening: { enabled: true, beltWidth: 3, treeSpacing: 6 },
        bridge: { enabled: false, span: 20, width: 12 },
        allowances: { clearanceDepth: .3, roadFillRatio: .8, trenchFactor: 1.15, traffic: true, temporaryDrainage: true },
    };
}
function object(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new RangeError(`${name}参数格式不正确`);
    return value;
}
function bounded(value, name, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
        throw new RangeError(`${name}应为 ${min}–${max} 的有限数字`);
    return value;
}
function toggle(value, name) {
    if (typeof value !== 'boolean')
        throw new RangeError(`${name}启用状态不正确`);
    return value;
}
/** Units: route/width/depth metres, layer thickness centimetres, pipe DN millimetres. */
export function normalizeMunicipalConfig(value = {}) {
    const input = object(value, '市政'), base = defaultMunicipalConfig();
    const road = { ...base.road, ...object(input.road ?? {}, '道路') };
    const drainage = { ...base.drainage, ...object(input.drainage ?? {}, '排水') };
    const lighting = { ...base.lighting, ...object(input.lighting ?? {}, '路灯') };
    const greening = { ...base.greening, ...object(input.greening ?? {}, '绿化') };
    const bridge = { ...base.bridge, ...object(input.bridge ?? {}, '桥梁') };
    const allowances = { ...base.allowances, ...object(input.allowances ?? {}, '措施') };
    bounded(road.length, '道路长度（m）', 0, 1000000);
    bounded(road.width, '红线宽度（m）', .1, 1000);
    bounded(road.carriageway, '车行道宽（m）', 0, 1000);
    bounded(road.sidewalk, '单侧人行道宽（m）', 0, 1000);
    if (!['arterial', 'secondary', 'branch'].includes(road.grade))
        throw new RangeError('道路等级不正确');
    if (road.carriageway + 2 * road.sidewalk > road.width + 1e-8)
        throw new RangeError('车行道与两侧人行道总宽不能超过红线宽度');
    if (road.length > 0 && road.carriageway + 2 * road.sidewalk <= 0)
        throw new RangeError('请填写大于零的道路有效宽度');
    if (!Array.isArray(road.layers) || road.layers.length > 16)
        throw new RangeError('道路结构层应为不超过 16 层的数组');
    road.layers = road.layers.map((raw) => {
        const layer = object(raw, '结构层');
        if (typeof layer.name !== 'string' || !layer.name.trim() || layer.name.length > 120)
            throw new RangeError('结构层名称不能为空或过长');
        bounded(layer.thickness, '结构层厚度（cm）', .1, 200);
        if (!['m²', 'm³', 't'].includes(layer.unit))
            throw new RangeError('结构层计量单位应为 m²、m³ 或 t');
        const scope = layer.scope ?? 'full';
        if (!['full', 'carriageway'].includes(scope))
            throw new RangeError('结构层铺设范围不正确');
        const density = layer.density ?? 2.4;
        bounded(density, '材料密度（t/m³）', .1, 20);
        return { name: layer.name.trim(), thickness: layer.thickness, unit: layer.unit, scope, density };
    });
    if (road.points !== undefined) {
        if (!Array.isArray(road.points) || road.points.length < 2 || road.points.length > 10000)
            throw new RangeError('中心线应包含 2–10000 个点');
        road.points = road.points.map((point) => ({ x: bounded(point?.x, '中心线 X 坐标', -1000000, 1000000), y: bounded(point?.y, '中心线 Y 坐标', -1000000, 1000000) }));
    }
    toggle(drainage.rain, '雨水');
    toggle(drainage.sewer, '污水');
    bounded(drainage.diameterRain, '雨水管径（mm）', 50, 5000);
    bounded(drainage.diameterSewer, '污水管径（mm）', 50, 5000);
    bounded(drainage.depth, '沟槽埋深（m）', .1, 30);
    bounded(drainage.manholeSpacing, '检查井间距（m）', 1, 10000);
    bounded(drainage.manholeSize, '检查井外宽（m）', .3, 10);
    for (const key of ['outerDiameterRain', 'outerDiameterSewer'])
        if (drainage[key] !== undefined)
            bounded(drainage[key], '管道外径（mm）', 50, 6000);
    toggle(lighting.enabled, '路灯');
    bounded(lighting.spacing, '路灯间距（m）', 1, 10000);
    bounded(lighting.height, '灯杆高度（m）', 1, 40);
    if (!['left', 'right', 'both'].includes(lighting.side))
        throw new RangeError('路灯布置侧别不正确');
    toggle(greening.enabled, '绿化');
    bounded(greening.beltWidth, '绿化带总宽（m）', 0, 1000);
    bounded(greening.treeSpacing, '乔木网格株距（m）', .1, 1000);
    toggle(bridge.enabled, '桥梁');
    bounded(bridge.span, '桥梁跨度（m）', 0, 1000);
    bounded(bridge.width, '桥宽（m）', .1, 200);
    if (bridge.enabled && bridge.span <= 0)
        throw new RangeError('启用桥梁时跨度应大于零');
    bounded(allowances.clearanceDepth, '平均清表深度（m）', 0, 10);
    bounded(allowances.roadFillRatio, '路基回填比例', 0, 1);
    bounded(allowances.trenchFactor, '沟槽放坡超挖系数', 1, 3);
    if (allowances.fenceLength !== undefined)
        bounded(allowances.fenceLength, '实际围挡长度（m）', 0, 2000000);
    toggle(allowances.traffic, '交通导行');
    toggle(allowances.temporaryDrainage, '临时排水');
    return { road, drainage, lighting, greening, bridge, allowances };
}
export function municipalRouteLength(points) {
    if (!Array.isArray(points) || points.length < 2)
        throw new RangeError('中心线至少需要两个点');
    let length = 0;
    points.forEach((point, index) => {
        bounded(point?.x, '中心线 X 坐标', -1000000, 1000000);
        bounded(point?.y, '中心线 Y 坐标', -1000000, 1000000);
        if (index)
            length += Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y);
    });
    return bounded(length, '中心线长度（m）', 0, 1000000);
}
export function calculateMunicipal(input) {
    if (!input)
        throw new RangeError('请先填写市政参数');
    const config = normalizeMunicipalConfig(input), { road, drainage, lighting, greening, bridge, allowances } = config;
    const length = road.length, effectiveWidth = road.carriageway + 2 * road.sidewalk;
    const formation = length * effectiveWidth, excavation = formation * allowances.clearanceDepth;
    const roadBackfill = excavation * allowances.roadFillRatio;
    const layers = road.layers.map(layer => {
        const area = length * (layer.scope === 'carriageway' ? road.carriageway : effectiveWidth);
        const volume = area * layer.thickness / 100;
        return { ...layer, scope: layer.scope ?? 'full', area, volume, density: layer.density ?? 2.4,
            quantity: layer.unit === 'm²' ? area : layer.unit === 't' ? volume * (layer.density ?? 2.4) : volume };
    });
    const pipes = [];
    for (const kind of ['rain', 'sewer'])
        if (drainage[kind]) {
            const nominal = kind === 'rain' ? drainage.diameterRain : drainage.diameterSewer;
            const diameter = (kind === 'rain' ? drainage.outerDiameterRain : drainage.outerDiameterSewer) ?? nominal;
            const d = diameter / 1000, count = length > 0 ? Math.ceil(length / drainage.manholeSpacing) + 1 : 0;
            const width = d + .6, depth = drainage.depth + .2;
            const occupiedLength = Math.min(length, Math.max(0, count - 1) * drainage.manholeSize);
            const pipeVolume = (length - occupiedLength) * Math.PI * d * d / 4;
            const wellVolume = occupiedLength * Math.min(width, drainage.manholeSize) * drainage.depth;
            const foundation = length * (d + .4) * .1;
            const excavation = length * width * depth * allowances.trenchFactor;
            const backfill = Math.max(0, excavation - pipeVolume - wellVolume - foundation);
            pipes.push({ kind, name: kind === 'rain' ? '雨水' : '污水', nominalDiameter: nominal, diameter,
                pipeLength: length, manholes: count, foundation, excavation, pipeVolume, wellVolume,
                backfill, surplus: excavation - backfill });
        }
    const poles = length > 0 && lighting.enabled ? (Math.ceil(length / lighting.spacing) + 1) * (lighting.side === 'both' ? 2 : 1) : 0;
    const greenArea = greening.enabled ? length * greening.beltWidth : 0;
    const stations = [];
    for (let from = 0; from < length; from += 100) {
        const to = Math.min(length, from + 100);
        stations.push({ from, to, length: to - from, formationArea: (to - from) * effectiveWidth });
    }
    return {
        config, road: { formation, carriagewayArea: length * road.carriageway, sidewalkArea: length * 2 * road.sidewalk,
            excavation, backfill: roadBackfill, surplus: excavation - roadBackfill, kerb: length * 2, layers },
        drainage: pipes,
        lighting: { poles, cable: lighting.enabled ? length * 1.1 * (lighting.side === 'both' ? 2 : 1) : 0, handholes: poles },
        greening: { area: greenArea, trees: greenArea > 0 ? Math.ceil(greenArea / greening.treeSpacing ** 2) : 0,
            shrubs: greenArea * .3, lawn: greenArea * .7, soil: greenArea * .3 },
        bridge: bridge.enabled && length > 0 ? { area: bridge.span * bridge.width, referenceUnitPrice: '4500' } : null,
        stations, estimateFlags: ['路基土方', '沟槽与井占位', '路灯电缆余量', '绿化密度', ...(bridge.enabled ? ['桥梁指标'] : [])],
    };
}
export function getMunicipalConfig(project) {
    return normalizeMunicipalConfig(project.cost?.modules?.municipal?.config ?? {});
}
export function generateMunicipalItems(project) {
    const state = project.cost?.modules?.municipal;
    if (!state?.enabled)
        return [];
    const model = calculateMunicipal(getMunicipalConfig(project));
    if (!model.config.road.length)
        return [];
    const { road, lighting, greening, bridge, config } = model;
    const items = [];
    const add = (id, prefix, sequence, name, unit, quantity, group, basis, estimate = false, feature = '', category = '分部分项', price = '0') => {
        if (quantity <= 0)
            return;
        items.push(createCostItem({ id: `municipal:${id}`, section: '市政', category, code: prefix + String(sequence).padStart(3, '0'),
            name, feature, unit, quantity: formatQuantity(quantity, 6), unitPrice: price, estimate, group,
            groupId: group, basis, priceStatus: price === '0' ? 'missing' : 'reference',
            note: `${basis}；${price === '0' ? '待填写当地综合单价，未取当地信息价' : '参考值，未取当地信息价'}；编码为示意，实际以当地清单规范为准` }));
    };
    add('formation', '040202001', 1, '路床（槽）整形', 'm²', road.formation, '道路', '道路长度 ×（车行道宽＋两侧人行道宽）');
    road.layers.forEach((layer, index) => add(`layer-${index}`, layer.unit === 't' ? '040203003' : '040202007', index + 1, layer.name, layer.unit, layer.quantity, '道路', `${layer.scope === 'carriageway' ? '车行道' : '全路幅'}面积 × 厚度${layer.unit === 't' ? ` × 密度 ${layer.density} t/m³（密度参数初估）` : layer.unit === 'm²' ? '，按面积计量，厚度为特征参数' : ''}`, layer.unit === 't', `${layer.thickness} cm；${layer.scope === 'carriageway' ? '仅车行道' : '车行道与人行道共用结构层'}；${layer.unit === 't' ? '按吨计价' : '单位按所选口径计价'}`));
    add('sidewalk', '040204001', 1, '人行道块料铺设', 'm²', road.sidewalkArea, '道路', '道路长度 × 单侧人行道宽 × 2', false, '不含共用基层与垫层，面层单列');
    add('kerb', '040204004', 1, '安砌路缘石', 'm', road.kerb, '道路', '两侧道路长度合计', false, '规格与安装做法待核对');
    add('road-excavation', '040101001', 1, '路基清表挖方', 'm³', road.excavation, '道路', `有效路幅面积 × 平均清表深度 ${config.allowances.clearanceDepth} m`, true);
    add('road-backfill', '040103001', 1, '路基回填方', 'm³', road.backfill, '道路', `清表挖方 × 回填比例 ${config.allowances.roadFillRatio}`, true);
    add('road-surplus', '040103002', 1, '路基余方弃置', 'm³', road.surplus, '道路', '清表挖方－路基回填量；运距待核对', true);
    for (const pipe of model.drainage) {
        const seq = pipe.kind === 'rain' ? 2 : 3, group = `${pipe.name}排水`, feature = `${pipe.name} DN${pipe.nominalDiameter}；外径按 ${pipe.diameter} mm 暂估；槽底埋深 ${config.drainage.depth} m`;
        add(`${pipe.kind}-pipe`, '040501001', seq, `${pipe.name}管道铺设`, 'm', pipe.pipeLength, group, '按路线中心线长度计，需以施工管线图核对', true, feature);
        add(`${pipe.kind}-wells`, '040504001', seq, `${pipe.name}检查井`, '座', pipe.manholes, group, `ceil（长度 / ${config.drainage.manholeSpacing} m）＋1，两端各设井`, true, `${feature}；井外宽 ${config.drainage.manholeSize} m；综合单价应包含井体施工`);
        add(`${pipe.kind}-foundation`, '040501002', seq, `${pipe.name}管道基础`, 'm³', pipe.foundation, group, '长度 ×（外径＋0.4m）× 0.1m', true, feature);
        add(`${pipe.kind}-excavation`, '040101001', seq, `${pipe.name}沟槽开挖`, 'm³', pipe.excavation, group, `长度 ×（外径＋0.6m）×（槽底埋深＋0.2m）× ${config.allowances.trenchFactor}`, true, feature);
        add(`${pipe.kind}-backfill`, '040103001', seq, `${pipe.name}沟槽回填`, 'm³', pipe.backfill, group, '开挖－管道圆柱占位－沟槽内井占位－基础；两端按半井，管道与井占位不重复扣除', true, feature);
        add(`${pipe.kind}-surplus`, '040103002', seq, `${pipe.name}余方弃置`, 'm³', pipe.surplus, group, '开挖－回填；井外扩挖未另计，运距与土质需核对', true, feature);
    }
    add('lighting', '040805001', 1, '灯杆安装（含灯具）', '套', lighting.poles, '电气', `ceil（长度 / ${config.lighting.spacing} m）＋1${config.lighting.side === 'both' ? '，双侧 ×2' : '，单侧'}`, true, `${config.lighting.height} m 灯杆；规格和基础做法待核对`);
    add('cable', '040803001', 1, '路灯电缆敷设', 'm', lighting.cable, '电气', '长度 × 1.1 余量系数 × 布置侧数', true, '线缆型号、截面与回路待核对');
    add('handholes', '040804001', 1, '路灯手孔井', '座', lighting.handholes, '电气', '每套灯杆配一座手孔井', true);
    add('trees', '050102001', 1, '栽植乔木', '株', greening.trees, '绿化', `ceil（绿化面积 / ${config.greening.treeSpacing}²），按网格密度初估`, true, '苗木种类、胸径与冠幅待核对');
    add('shrubs', '050102006', 1, '栽植灌木色带', 'm²', greening.shrubs, '绿化', '绿化带总面积 × 30%', true);
    add('lawn', '050102007', 1, '铺种草坪', 'm²', greening.lawn, '绿化', '绿化带总面积 × 70%', true);
    add('soil', '050101001', 1, '种植土回填', 'm³', greening.soil, '绿化', '绿化带总面积 × 0.3m 厚度', true);
    if (bridge)
        add('bridge', '040301001', 1, '桥梁综合指标估算', 'm²', bridge.area, '桥梁', '桥面面积 × 指标单价；参考区间 3000–6000 元/m²，默认取中值；不含征地拆迁、管线迁改、交通导改，误差可达 ±40%，仅用于投资匡算', true, `跨度 ${config.bridge.span} m × 桥宽 ${config.bridge.width} m；非结构设计`, '分部分项', bridge.referenceUnitPrice);
    add('fence', '041101001', 1, '施工围挡', 'm', config.allowances.fenceLength ?? config.road.length * 2, '措施', '实际封闭长度优先；未填写时按道路两侧 2L 初估', config.allowances.fenceLength === undefined, '', '措施项目');
    if (config.allowances.traffic)
        add('traffic', '041101002', 1, '交通导行', 'm', config.road.length, '措施', '按道路长度暂估；实际交通组织另行核对', true, '', '措施项目');
    if (config.allowances.temporaryDrainage)
        add('temporary-drainage', '041101003', 1, '临时排水', 'm', config.road.length, '措施', '按道路长度暂估；临时设施方案另行核对', true, '', '措施项目');
    return applyModulePrices(items, state);
}
export function validateMunicipalState(state) {
    if (state.config !== undefined)
        normalizeMunicipalConfig(state.config);
}
//# sourceMappingURL=municipal.js.map