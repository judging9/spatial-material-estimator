import { levelProjects } from './levels.js';
import { detectPlanRooms } from './wall-plan.js';
import { calculateProjectBudget } from './project-budget.js';
const drawingMode = (project, included) => {
    if (project.workspaceMode === 'civil' || project.workspaceMode === 'municipal')
        return project.workspaceMode;
    if (included.length === 1 && included[0] !== 'decoration')
        return included[0];
    return 'plan';
};
const preferredSection = (project, included) => included[0] ?? (project.workspaceMode === 'civil' || project.workspaceMode === 'municipal' ? project.workspaceMode : 'decoration');
/** Readiness describes the chosen delivery scope. It never prices an omitted
 * professional, assigns materials, completes missing geometry or changes the
 * project. Informational source/measurement notes do not block a valid quote. */
export function calculateProjectReadiness(project, suppliedBudget) {
    const budget = suppliedBudget ?? calculateProjectBudget(project);
    const included = budget.includedSections;
    const issues = structuredClone(budget.issues);
    const keys = new Set(issues.map(issue => [issue.section, issue.levelId ?? '', issue.targetType, issue.targetId ?? '', issue.message].join('\u0000')));
    const append = (issue) => {
        const key = [issue.section, issue.levelId ?? '', issue.targetType, issue.targetId ?? '', issue.message].join('\u0000');
        if (!keys.has(key)) {
            keys.add(key);
            issues.push(issue);
        }
    };
    const layers = levelProjects(project);
    const nativeDrawing = project.drawing?.type === 'plan';
    // A file may claim type "plan" while omitting its calibration. Area pricing
    // still uses the stored scale, so native type alone is not proof of units.
    const calibrated = Number.isFinite(project.calibration?.metersPerPixel) && project.calibration.metersPerPixel > 0;
    const hasGeometry = layers.some(({ project: layer }) => layer.regions.some(region => region.points?.length >= 3) ||
        Boolean(layer.walls?.length || layer.wallShapes?.length || layer.furniture?.length || layer.serviceRoutes?.length || layer.civilElements?.length)) ||
        Boolean(project.municipalElements?.length);
    const section = preferredSection(project, included);
    if (!calibrated)
        append({
            id: 'readiness-scale', section, targetType: 'project', title: '确定真实尺寸', severity: 'pending',
            message: project.drawing ? '图纸尚未校准，请用已知距离确定比例；按件单价也不能代替几何尺寸校准。' : '先按真实尺寸新建平面或场地，也可上传图纸后校准比例。',
        });
    if (!hasGeometry)
        append({
            id: 'readiness-design', section, targetType: 'project', title: '开始布置工程', severity: 'pending',
            message: project.drawing ? '图纸已准备，尚未创建可计量的区域、构件或设施。' : '选择绘图、土建或市政，用预设开始并添加实际工程对象。',
        });
    let designErrors = 0;
    const selectedScope = project.budget;
    const inspectDecoration = included.includes('decoration') ||
        (!included.length && selectedScope?.included?.decoration !== false &&
            (project.workspaceMode === undefined || project.workspaceMode === 'plan' || project.workspaceMode === 'decoration'));
    if (inspectDecoration) {
        for (const layer of layers) {
            const content = layer.project;
            let message = typeof content.planError === 'string' ? content.planError.trim() : content.planError ? '墙线房间尚未完成，请检查墙线。' : '';
            // Imported projects may omit the cached planError. Inspect the actual
            // wall graph instead of trusting that cache or inventing a room.
            if (!message && content.walls?.length) {
                try {
                    if (!detectPlanRooms(content.walls, content.wallJoinStyle ?? 'square').length)
                        message = '墙线尚未闭合，请连接端点形成房间后再计算报价';
                }
                catch (error) {
                    message = error instanceof Error ? error.message : '墙线房间几何无效，请检查墙线。';
                }
            }
            if (message) {
                designErrors++;
                const localizedIssue = { id: `readiness-plan-${layer.id}`, section: 'decoration', levelId: layer.id,
                    targetType: 'project', title: `${layer.name} · 完成墙线房间`, message, severity: 'pending' };
                const existing = issues.findIndex(issue => issue.section === 'decoration' && issue.targetType === 'project' &&
                    issue.severity === 'pending' && (issue.message === message || issue.message === `${layer.name}：${message}`));
                // Preserve the engine's genuine blocker but add its missing floor
                // target, instead of listing the same repair twice in the overview.
                if (existing >= 0)
                    issues[existing] = localizedIssue;
                else
                    append(localizedIssue);
            }
            const addDemoNote = (owner, targetType, items) => {
                if (!items?.some(item => item.demo === true))
                    return;
                append({ id: `readiness-demo-${targetType}-${owner.id}`, section: 'decoration', levelId: layer.id, targetType, targetId: owner.id,
                    title: owner.name || '材料价格来源', severity: 'info',
                    message: '包含 Demo 示例材料，当前价格用于演示；交付前请按实际材料、当地报价和施工做法确认。' });
            };
            for (const region of content.regions) {
                addDemoNote(region, 'region', region.items);
                if (region.ceiling?.enabled)
                    addDemoNote(region, 'ceiling', region.ceiling.items);
            }
            for (const wall of content.walls ?? [])
                addDemoNote(wall, 'wall', wall.items);
            for (const wall of content.wallShapes ?? [])
                addDemoNote(wall, 'wall', wall.items);
        }
    }
    if (included.includes('civil')) {
        for (const layer of layers)
            for (const element of layer.project.civilElements ?? []) {
                if (element.rebarMode !== 'ratio')
                    continue;
                append({ id: `readiness-rebar-${element.id}`, section: 'civil', levelId: layer.id, targetType: 'civil', targetId: element.id,
                    title: element.name, severity: 'info', message: '钢筋使用用户 kg/m³ 指标估算，尚未按施工图逐根算量；请确认该计量依据。' });
            }
    }
    if (included.includes('municipal')) {
        const terrain = project.municipalTerrain;
        if (terrain && /自建概念地形|人工塑形|非实测/.test(terrain.sourceName ?? ''))
            append({
                id: 'readiness-terrain', section: 'municipal', targetType: 'project', title: terrain.name, severity: 'info',
                message: '场地包含自建或人工塑形地形，高程属于设计方案；由此计算的挖填方需与现场实测复核。',
            });
        for (const element of project.municipalElements ?? []) {
            let message = '';
            if (element.kind === 'river')
                message = '河槽体积按净平面面积 × 槽深估算，未包含河岸放坡土方、地质分层和水流模拟。';
            if (element.kind === 'bridge')
                message = '桥面、中间墩和栏杆按当前几何及用户单价计量，未包含桥台、基础详算和结构受力验算。';
            if (['road', 'intersection', 'roundabout'].includes(element.kind))
                message = '道路与路口按方案几何计量，请核对道路等级、转弯半径和交通组织；当前不进行交通规范验算。';
            if (message)
                append({ id: `readiness-municipal-${element.id}`, section: 'municipal', targetType: 'municipal', targetId: element.id,
                    title: element.name, message, severity: 'info' });
        }
    }
    const designReady = hasGeometry && designErrors === 0;
    const pricingReady = budget.status === 'ready' && budget.itemCount > 0 && designErrors === 0;
    const ready = calibrated && designReady && pricingReady;
    const steps = [
        { id: 'scale', label: '确定真实尺寸', complete: calibrated, action: 'calibrate',
            description: calibrated ? nativeDrawing ? '平面比例已确定，区域按保存比例计算实际面积。' : '图纸比例已校准，面积与长度使用实际比例。' : '按尺寸新建，或用图纸上的已知距离校准。' },
        { id: 'design', label: '绘制与布置', complete: designReady, action: drawingMode(project, included),
            description: designErrors ? `${designErrors} 个楼层的墙线房间需要修正。` : hasGeometry ? '工程对象已建立，可继续修改形状和尺寸。' : '从房间、构件或场地预设开始，再调整尺寸。' },
        { id: 'pricing', label: '填写材料与价格', complete: pricingReady, action: 'review',
            description: pricingReady ? '所选专业的报价参数已完整，明确零价按确认价格计入。' : !included.length ? '至少选择一个已有专业汇入总预算。' : '检查待处理项目，填写材料、单价及实际用量。' },
        { id: 'delivery', label: '检查与导出', complete: ready, action: ready ? 'export' : 'review',
            description: ready ? '可导出完整总预算；交付前请复核计量说明和价格来源。' : '未完成项目保留为待处理，导出仅能列示已确认部分。' },
    ];
    return { steps, nextStep: steps.find(step => !step.complete) ?? steps[3], ready, issues };
}
//# sourceMappingURL=project-readiness.js.map