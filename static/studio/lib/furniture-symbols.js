/** Small plan symbols complement the local three-dimensional preview assets. */
export function extraFurnitureSymbol(kind) {
    if (['socketFive', 'socketWaterproof', 'socketUsb', 'socketAirConditioner', 'socketFloor'].includes(kind)) {
        const frame = kind === 'socketFloor' ? '<rect x="5" y="5" width="38" height="38" rx="2"/>' : '<rect x="7" y="5" width="34" height="38" rx="3"/>';
        const holes = kind === 'socketAirConditioner' ? '<path d="M24 13v7m-9 7 4 5m14-5-4 5"/>' : '<path d="M17 12v6m14-6v6m-7 5v6m-10 4 4-4m16 4-4-4"/>';
        const extra = kind === 'socketWaterproof' ? '<path d="M7 10h34M11 39h26"/>' : kind === 'socketUsb' ? '<path d="M12 36h8m8 0h7"/>' : '';
        return frame + holes + extra;
    }
    if (kind === 'powerPlug')
        return '<path d="M13 13h22v17a7 7 0 0 1-7 7h-8a7 7 0 0 1-7-7zM17 13V5m14 8V5m-7 32v7M18 20h12"/>';
    if (['switchSingle', 'switchDouble', 'switchTriple', 'switchTwoWay'].includes(kind)) {
        const count = kind === 'switchDouble' ? 2 : kind === 'switchTriple' ? 3 : 1;
        return '<rect x="6" y="5" width="36" height="38" rx="3"/>' + Array.from({ length: count }, (_, i) => `<rect x="${10 + i * 28 / count}" y="10" width="${28 / count - 2}" height="28" rx="1"/>`).join('') + (kind === 'switchTwoWay' ? '<path d="m17 19 4-4 4 4m-2 10 4 4 4-4"/>' : '');
    }
    if (kind === 'switchDimmer')
        return '<rect x="6" y="5" width="36" height="38" rx="3"/><circle cx="24" cy="24" r="11"/><path d="M24 14v6m-9 18h18"/>';
    if (kind === 'distributionBox')
        return '<rect x="7" y="5" width="34" height="38" rx="2"/><path d="M11 13h26v22H11zm6 0v22m7-22v22m7-22v22M11 23h26M19 8h10"/>';
    if (kind === 'lowVoltageBox')
        return '<rect x="5" y="9" width="38" height="30" rx="2"/><path d="M10 14h12v13H10zm16 0h12v13H26zM11 32h26m-26 3h26M16 20h1m15 0h1"/>';
    if (kind === 'networkPanel')
        return '<rect x="6" y="5" width="36" height="38" rx="3"/><path d="M10 16h12v11h-3v3h-6v-3h-3zm16 0h12v11h-3v3h-6v-3h-3zM13 20h6m10 0h6"/>';
    if (kind === 'tvPanel')
        return '<rect x="6" y="5" width="36" height="38" rx="3"/><circle cx="24" cy="23" r="9"/><circle cx="24" cy="23" r="3"/><path d="M18 36h12"/>';
    if (kind === 'waterOutletCold' || kind === 'waterOutletHot')
        return `<circle cx="24" cy="24" r="18"/><circle cx="24" cy="24" r="10"/><circle cx="24" cy="24" r="4"/>${kind === 'waterOutletHot' ? '<path d="M14 8l4 4m12 24 4 4"/>' : '<path d="M9 24h5m20 0h5"/>'}`;
    if (kind === 'floorDrain')
        return '<rect x="6" y="6" width="36" height="36" rx="1"/><path d="M12 12v24m6-24v24m6-24v24m6-24v24m6-24v24M12 12h24m-24 24h24"/>';
    if (kind === 'waterValve')
        return '<path d="M4 19h40v10H4zM21 8h6v11M13 8h22m-27 8v16m32-16v16"/><circle cx="24" cy="24" r="5"/>';
    if (kind === 'manifold')
        return '<path d="M5 13h38v7H5zm0 14h38v7H5zM11 7v33m9-33v33m9-33v33m9-33v33M8 8h6m3 0h6m3 0h6m3 0h6"/>';
    if (kind === 'router')
        return '<rect x="5" y="20" width="38" height="21" rx="3"/><path d="M10 20V7m28 13V7M11 33h2m4 0h2m4 0h2m4 0h2M19 15a7 7 0 0 1 10 0m-13-4a11 11 0 0 1 16 0"/>';
    if (kind === 'wirelessAP')
        return '<circle cx="24" cy="24" r="18"/><path d="M12 20a17 17 0 0 1 24 0m-20 5a11 11 0 0 1 16 0m-12 5a6 6 0 0 1 8 0"/><circle cx="24" cy="35" r="1"/>';
    if (kind === 'downlight')
        return '<circle cx="24" cy="24" r="18"/><circle cx="24" cy="24" r="13"/><circle cx="24" cy="24" r="8"/>';
    if (kind === 'spotlight')
        return '<path d="M10 6h28v7H10zM24 13v8m-12 0h24v15H12zm2 15-5 7m15-7v7m10-7 5 7"/>';
    if (kind === 'ledStripController')
        return '<rect x="4" y="12" width="40" height="24" rx="2"/><path d="M13 17h22v14H13zm-9 2h6m-6 10h6m28-10h6m-6 10h6M18 20v8m6-8v8m6-8v8"/>';
    if (kind === 'wallLight')
        return '<path d="M9 14h5v22H9zm5 10h7m-3-10h22l3 19H15zm11 19v7M21 40h10"/>';
    if (kind === 'pendantLight')
        return '<path d="M18 5h12m-6 0v15M10 34l6-14h16l6 14zM10 34h28m-25 5h22"/>';
    if (kind === 'linearLight')
        return '<rect x="4" y="16" width="40" height="16" rx="2"/><path d="M8 21h32m-32 6h32M13 16V8m22 8V8"/>';
    if (kind === 'radiator')
        return '<rect x="5" y="8" width="38" height="33" rx="2"/><path d="M10 8v33m7-33v33m7-33v33m7-33v33m7-33v33M5 15h38M5 34h38"/>';
    if (kind === 'freshAirVent')
        return '<rect x="4" y="12" width="40" height="25" rx="1"/><path d="M9 17h30m-30 5h30m-30 5h30m-30 5h30"/>';
    if (kind === 'exhaustFan')
        return '<rect x="5" y="5" width="38" height="38" rx="2"/><circle cx="24" cy="24" r="15"/><circle cx="24" cy="24" r="4"/><path d="M24 20c-12-14 10-15 6 1M28 24c14-12 15 10-1 6M24 28c12 14-10 15-6-1M20 24c-14 12-15-10 1-6"/>';
    if (kind === 'thermostat')
        return '<rect x="6" y="5" width="36" height="38" rx="3"/><path d="M11 11h26v17H11zm3 25h4m12 0h4M20 14v8a4 4 0 1 0 4 0v-8z"/>';
    if (kind === 'smokeDetector')
        return '<circle cx="24" cy="24" r="18"/><circle cx="24" cy="24" r="10"/><path d="M24 6v5m0 26v5M6 24h5m26 0h5M11 11l4 4m18 18 4 4m0-26-4 4M15 33l-4 4"/><circle cx="24" cy="24" r="3"/>';
    if (kind === 'smartPanel')
        return '<rect x="4" y="8" width="40" height="32" rx="3"/><path d="M9 13h30v22H9zm5 5h6v5h-6zm14 0h6v5h-6zM14 29h6m8 0h6"/>';
    if (kind === 'doorbell')
        return '<rect x="14" y="4" width="20" height="40" rx="4"/><circle cx="24" cy="14" r="5"/><circle cx="24" cy="33" r="5"/><path d="M20 23h8m-8 3h8"/>';
    if (['tv', 'monitor', 'computer'].includes(kind))
        return '<rect x="6" y="7" width="36" height="25" rx="2"/><path d="M24 32v8m-9 0h18M10 11h28v17H10z"/>';
    if (kind === 'laptop')
        return '<path d="M9 8h30v24H9zM6 32h36l-4 8H10zM13 12h22v16H13z"/>';
    if (['washingMachine', 'dryer'].includes(kind))
        return '<rect x="10" y="5" width="28" height="38" rx="2"/><circle cx="24" cy="27" r="10"/><path d="M10 13h28m-23-4h5m10 0h3"/>';
    if (kind === 'cooktop')
        return '<rect x="6" y="9" width="36" height="30" rx="2"/><circle cx="16" cy="19" r="5"/><circle cx="32" cy="19" r="5"/><circle cx="16" cy="31" r="5"/><circle cx="32" cy="31" r="5"/>';
    if (['sink', 'basin', 'vanity'].includes(kind))
        return '<rect x="7" y="9" width="34" height="29" rx="4"/><ellipse cx="24" cy="26" rx="12" ry="8"/><path d="M24 7v14m-4-9h8"/>';
    if (kind === 'toilet')
        return '<rect x="13" y="6" width="22" height="10" rx="2"/><path d="M13 16v12a11 12 0 0 0 22 0V16z"/><ellipse cx="24" cy="28" rx="7" ry="8"/>';
    if (kind === 'bathtub')
        return '<rect x="5" y="12" width="38" height="24" rx="7"/><rect x="10" y="17" width="28" height="14" rx="6"/><path d="M35 12v8"/>';
    if (kind === 'shower')
        return '<rect x="7" y="7" width="34" height="34"/><path d="M7 41l34-34M7 16h9v-9m20 29v-9"/>';
    if (kind === 'stairs')
        return '<path d="M10 5h28v38H10zM10 10h28m-28 5h28m-28 5h28m-28 5h28m-28 5h28m-28 5h28m-28 5h28M24 36V12m-4 5 4-5 4 5"/>';
    if (kind === 'stairsLanding')
        return '<path d="M10 5h28v38H10zM10 11h28m-28 5h28m-28 15h28m-28 5h28M10 19h28m-28 10h28M24 39V9m-4 5 4-5 4 5"/>';
    if (kind === 'stairsLLeft' || kind === 'stairsLRight')
        return `<g${kind === 'stairsLLeft' ? ' transform="translate(48 0) scale(-1 1)"' : ''}><path d="M6 43h13V19h24V6H6zM6 38h13m-13-5h13m-13-5h13m-13-5h13M24 6v13m5-13v13m5-13v13m5-13v13M12 38V13h24m-5-4 5 4-5 4"/></g>`;
    if (kind === 'stairsU')
        return '<path d="M5 43h13V18h12v25h13V5H5zM5 38h13m-13-5h13m-13-5h13m-13-5h13m12 0h13m-13 5h13m-13 5h13m-13 5h13M11 37V11h25v26m-4-5 4 5 4-5"/>';
    if (kind === 'stairsSpiralLeft' || kind === 'stairsSpiralRight')
        return `<g${kind === 'stairsSpiralLeft' ? ' transform="translate(48 0) scale(-1 1)"' : ''}><circle cx="24" cy="24" r="19"/><circle cx="24" cy="24" r="5"/><path d="M24 5v14m19 5H29M24 43V29M5 24h14M11 11l9 9m17-9-9 9m9 17-9-9m-17 9 9-9M24 37a13 13 0 1 1 11-6m-1-6 1 6-6-1"/></g>`;
    if (kind === 'stairsArcLeft' || kind === 'stairsArcRight')
        return `<g${kind === 'stairsArcLeft' ? ' transform="translate(48 0) scale(-1 1)"' : ''}><path d="M11 5a19 19 0 0 1 0 38V30a6 6 0 0 0 0-12zM15 6l-2 12m13-5-9 8m13 3H17m9 11-9-8m-2 15-2-12M12 36a12 12 0 0 0 12-12m-4 5 4-5 3 5"/></g>`;
    if (['floorLamp', 'bedsideLamp', 'ceilingLight'].includes(kind))
        return '<circle cx="24" cy="24" r="14"/><circle cx="24" cy="24" r="5"/><path d="M24 10v9m0 10v9m-14-14h9m10 0h9"/>';
    if (['airConditioner', 'rangeHood', 'waterHeater'].includes(kind))
        return '<rect x="5" y="14" width="38" height="20" rx="4"/><path d="M11 22h26m-26 5h26m-17 7v6m8-6v6"/>';
    if (['refrigerator', 'dishwasher', 'oven', 'microwave', 'printer'].includes(kind))
        return '<rect x="9" y="5" width="30" height="38" rx="2"/><path d="M9 15h30M14 21h20v15H14zm17-12h3"/>';
    if (['singleBed', 'bunkBed'].includes(kind))
        return '<rect x="10" y="6" width="28" height="36"/><path d="M10 17h28m-22-7h16v4H16zm-6 25h28"/>';
    if (['armchair', 'officeChair', 'barStool'].includes(kind))
        return '<path d="M14 7h20v11H14zM11 20h26v15H11zM6 17v17m36-17v17M16 35v7m16-7v7"/>';
    if (['coffeeTable', 'desk', 'countertop', 'kitchenIsland', 'bench', 'dresser'].includes(kind))
        return '<rect x="6" y="12" width="36" height="23" rx="2"/><path d="M11 35v6m26-6v6M11 8h26"/>';
    return '<rect x="8" y="6" width="32" height="36" rx="2"/><path d="M24 6v36M8 18h32m-32 12h32m-13-7v3m6-3v3"/>';
}
//# sourceMappingURL=furniture-symbols.js.map