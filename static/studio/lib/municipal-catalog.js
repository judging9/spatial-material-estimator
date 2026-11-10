import { createMunicipalElement, municipalScale } from './municipal-design.js';
export const MUNICIPAL_CATALOG_GROUPS = [
    { id: 'transport', name: '交通与停车' }, { id: 'landscape', name: '街景与绿化' },
    { id: 'utilities', name: '市政配套' }, { id: 'public', name: '公共空间' },
];
const asset = (id, name, group, symbol, width, depth, height, description, color = '#85968b', kind = 'facility', unit = '件') => ({ id, name, group, symbol, width, depth, height, elevation: 0, unit, kind, color, description });
/** Suggested physical dimensions only. Prices come from the project owner. */
export const MUNICIPAL_CATALOG = [
    asset('street-bench', '街边长椅', 'landscape', 'bench', 180, 65, 85, '设置长宽、高度和朝向，按实际布置数量填写供货与安装价格。', '#9c947f'),
    asset('litter-bin', '街边垃圾桶', 'landscape', 'bin', 55, 50, 100, '放置垃圾桶，按件填写设备价格与人工。'),
    asset('recycling-station', '分类垃圾收集站', 'utilities', 'recycling', 240, 90, 150, '一组分类收集站按一件报价，可编辑整体尺寸。'),
    asset('bus-stop-sign', '公交站牌', 'transport', 'bus-stop', 70, 35, 280, '沿道路放置站牌并设置朝向，按件自填价格。'),
    asset('bus-shelter', '公交候车亭', 'transport', 'shelter', 500, 180, 280, '整体候车亭预设含顶棚、立柱与座椅；预算作为一套计取。'),
    asset('traffic-sign', '交通标志牌', 'transport', 'sign', 90, 25, 300, '设置位置、朝向和整体尺寸，标志内容由实际项目确认。'),
    asset('wayfinding-sign', '公共导向牌', 'public', 'sign', 100, 35, 240, '放置导向牌，按件填写供货、安装费用。'),
    asset('bollard', '防撞柱 / 车挡', 'transport', 'bollard', 20, 20, 80, '按每根车挡计价；预算份数不会复制场地图示。'),
    asset('road-guardrail', '道路护栏', 'transport', 'fence', 12, 600, 110, '沿真实路径拖画护栏，按米填写综合价；设置高度。', '#7c8f87', 'fence', 'm'),
    asset('site-fence', '场地围栏', 'public', 'fence', 10, 600, 180, '画围栏实际走向，长度按路径计算，不按外包矩形推算。', '#84998c', 'fence', 'm'),
    asset('fire-hydrant', '室外消火栓', 'utilities', 'hydrant', 50, 40, 95, '放置消火栓，按件填写设备和安装价格；管道单独画线计量。', '#ad7164'),
    asset('ev-charger', '汽车充电桩', 'transport', 'charger', 70, 50, 170, '充电桩按套报价，电缆与配电设施按实际工程另行配置。'),
    asset('parking-space', '标准停车位', 'transport', 'parking', 250, 500, 0.1, '按实际长宽及朝向布置一个车位；按位填写划线或综合施工价。', '#bac1b2'),
    asset('accessible-parking', '无障碍停车位', 'transport', 'parking', 360, 500, 0.1, '提供较宽的布置尺寸，按位自填施工价并核对当地设计要求。', '#9fbaaf'),
    asset('bicycle-rack', '自行车停放架', 'transport', 'bicycle', 180, 60, 90, '一组停放架按一件计价，整体尺寸与朝向可修改。'),
    asset('street-tree', '行道树', 'landscape', 'tree', 300, 300, 550, '树冠直径与树高可设置，按株报价，树池和养护费用自行配置。', '#8ba27e'),
    asset('planter', '街边花箱', 'landscape', 'planter', 150, 55, 65, '花箱连同示意绿植按组计价，可修改真实尺寸。', '#9eab8f'),
    asset('tree-pit', '树池 / 树篦', 'landscape', 'grate', 150, 150, 8, '树池构件按套计价，不改变树木数量或道路面积。', '#a3af9b'),
    asset('public-toilet', '公共卫生间', 'public', 'building', 600, 350, 320, '公共卫生间概念布置按一座计价，可编辑尺寸；内部装修另行设计。', '#b6b7a7'),
    asset('security-booth', '门卫岗亭', 'public', 'building', 300, 250, 300, '岗亭按套填写供货或施工综合价。', '#a9b7aa'),
    asset('electrical-cabinet', '室外配电箱', 'utilities', 'cabinet', 90, 60, 180, '配电箱按件报价，容量和线路按实际设计确认。'),
    asset('transformer', '箱式变压器', 'utilities', 'transformer', 300, 220, 240, '放置箱变概念占地并填写设备、安装价格。', '#8eaba0'),
    asset('drainage-grate', '雨水口 / 排水篦子', 'utilities', 'grate', 60, 40, 8, '按件计价并调整长宽，连接管道另行绘制。', '#899d93'),
    asset('speed-bump', '减速带', 'transport', 'speedbump', 350, 45, 8, '横跨道路摆放，按条填写价格，宽度与朝向可修改。', '#b8aa74'),
    asset('pedestrian-crossing', '人行横道划线', 'transport', 'crosswalk', 400, 700, 0.1, '按组摆放人行横道标线，设置实际长宽与朝向，填写施工报价。', '#c4cbbd'),
    asset('sidewalk', '人行道铺装', 'transport', 'paving', 300, 1000, 6, '可直接生成一块铺装范围，再编辑边界；按真实净面积报价。', '#b8b2a1', 'paving', 'm²'),
    asset('bicycle-lane', '自行车道铺装', 'transport', 'paving', 250, 1000, 5, '绘制车道实际边界，按净面积和结构层计量。', '#88a698', 'paving', 'm²'),
    asset('parking-lot', '停车场铺装', 'transport', 'paving', 1800, 1200, 8, '按实际铺装范围计算净面积，可添加基层；车位单独布置报价。', '#a1aaa0', 'paving', 'm²'),
    asset('accessible-ramp', '无障碍坡道', 'public', 'ramp', 150, 600, 30, '坡道示意布置按件综合报价；请按实际高差与坡度核对设计。', '#a9b4a6'),
    asset('playground-set', '儿童活动设施', 'public', 'playground', 450, 350, 300, '概念设施按套放置与报价，活动铺装面积另行圈定。', '#91aa97'),
    asset('fountain', '景观喷泉', 'landscape', 'fountain', 400, 400, 120, '放置喷泉整体范围并自填综合价，供水和泵设备可另外配置。', '#9eb3ae'),
    asset('public-sculpture', '景观雕塑', 'landscape', 'art', 180, 180, 300, '设置雕塑整体占地与高度，按座自行填写采购安装价格。', '#a4ad9a'),
];
export function findMunicipalCatalogPreset(id) { return MUNICIPAL_CATALOG.find(item => item.id === id); }
export function municipalCatalogPreset(id) {
    const preset = findMunicipalCatalogPreset(id);
    if (!preset)
        throw new RangeError('城市设施预设不存在，请重新选择。');
    return preset;
}
export function searchMunicipalCatalog(query = '', group = 'all') {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return MUNICIPAL_CATALOG.filter(item => (group === 'all' || item.group === group) && terms.every(term => `${item.name} ${item.description}`.toLocaleLowerCase().includes(term)));
}
export function createMunicipalCatalogElement(id, points, project, overrides = {}) {
    const preset = municipalCatalogPreset(id);
    let source = points.map(point => ({ ...point }));
    // One click can create editable physical extents; multiple points preserve
    // the exact path or polygon supplied by the authoring tool.
    if (source.length === 1 && (preset.kind === 'paving' || preset.kind === 'fence')) {
        const scale = municipalScale(project);
        if (!scale)
            throw new RangeError('先确定图纸比例，再布置按面积或长度计量的设施。');
        const center = source[0], width = (overrides.width ?? preset.width) * .01 / scale, depth = (overrides.depth ?? preset.depth) * .01 / scale;
        source = preset.kind === 'fence' ? [center, { x: center.x + depth, y: center.y }] : [
            { x: center.x - width / 2, y: center.y - depth / 2 }, { x: center.x + width / 2, y: center.y - depth / 2 },
            { x: center.x + width / 2, y: center.y + depth / 2 }, { x: center.x - width / 2, y: center.y + depth / 2 },
        ];
    }
    return createMunicipalElement(preset.kind, source, project, {
        name: preset.name, width: preset.width, depth: preset.depth, height: preset.height, elevation: preset.elevation, unit: preset.unit,
        ...overrides, catalogId: preset.id, ...(preset.kind === 'facility' ? { rotation: overrides.rotation ?? 0 } : {}),
    });
}
/** Local normalized shapes allow Canvas and WebGL to share asset semantics. */
export function municipalFacilityPlanSymbol(element) {
    return findMunicipalCatalogPreset(element.catalogId)?.symbol ?? 'building';
}
//# sourceMappingURL=municipal-catalog.js.map