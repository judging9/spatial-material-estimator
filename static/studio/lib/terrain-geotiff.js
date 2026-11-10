import { knownMetreProjectedCrs, MAX_TERRAIN_RASTER_CELLS, validateRaster, validateTerrainGeoTIFFSource } from './terrain.js';
import { decodeTIFFLZW, undoTIFFFloatingPredictor } from './terrain-tiff-codecs.js';
export const MAX_GEOTIFF_BYTES = 8_000_000;
const MAX_BLOCK_BYTES = 2_000_000;
export class GeoTIFFUnitConfirmationRequired extends RangeError {
    code = 'confirm-local-metres';
}
const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
/** Restricted, deterministic GeoTIFF reader. Unsupported codecs, axes and
 * coordinate units fail explicitly rather than becoming invented DEM values. */
export async function parseTerrainGeoTIFF(buffer, options = {}) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8 || buffer.byteLength > MAX_GEOTIFF_BYTES)
        throw new RangeError('GeoTIFF 文件无效或超过 8 MB。');
    if (options.placement !== undefined && !['local', 'source'].includes(options.placement) || options.confirmLocalMeters !== undefined && typeof options.confirmLocalMeters !== 'boolean')
        throw new RangeError('GeoTIFF 导入位置或米制确认选项无效。');
    const view = new DataView(buffer), bytes = new Uint8Array(buffer), little = bytes[0] === 73 && bytes[1] === 73;
    if (!little && !(bytes[0] === 77 && bytes[1] === 77))
        throw new RangeError('文件不是 TIFF。');
    const inside = (offset, length) => { if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.byteLength)
        throw new RangeError('GeoTIFF 文件截断或数据偏移越界。'); };
    const u16 = (offset) => { inside(offset, 2); return view.getUint16(offset, little); }, u32 = (offset) => { inside(offset, 4); return view.getUint32(offset, little); };
    if (u16(2) === 43)
        throw new RangeError('BigTIFF 暂未支持，请转换为经典单波段 GeoTIFF 或 ASC。');
    if (u16(2) !== 42)
        throw new RangeError('TIFF 文件版本无效。');
    const ifd = u32(4);
    if (ifd < 8)
        throw new RangeError('GeoTIFF 缺少有效图像目录。');
    const count = u16(ifd);
    if (count > 512)
        throw new RangeError('GeoTIFF 图像目录标签过多。');
    inside(ifd, 2 + count * 12 + 4);
    const tags = new Map();
    for (let i = 0; i < count; i++) {
        const at = ifd + 2 + i * 12, id = u16(at), type = u16(at + 2), n = u32(at + 4), size = sizes[type];
        if (!size || n > 1_000_000 || tags.has(id))
            throw new RangeError('GeoTIFF 标签类型、数量或重复标签不受支持。');
        const length = n * size, offset = length <= 4 ? at + 8 : u32(at + 8);
        inside(offset, length);
        tags.set(id, { type, count: n, offset });
    }
    if (u32(ifd + 2 + count * 12) !== 0)
        throw new RangeError('多页 TIFF 暂未支持，请导出单页 DEM。');
    const numbers = (id) => {
        const tag = tags.get(id);
        if (!tag)
            return [];
        if (tag.count > MAX_TERRAIN_RASTER_CELLS || tag.type === 2)
            throw new RangeError(`GeoTIFF 数值标签 ${id} 格式无效。`);
        const values = [];
        for (let i = 0; i < tag.count; i++) {
            const p = tag.offset + i * sizes[tag.type];
            let value;
            switch (tag.type) {
                case 1:
                case 7:
                    value = view.getUint8(p);
                    break;
                case 6:
                    value = view.getInt8(p);
                    break;
                case 3:
                    value = u16(p);
                    break;
                case 8:
                    value = view.getInt16(p, little);
                    break;
                case 4:
                    value = u32(p);
                    break;
                case 9:
                    value = view.getInt32(p, little);
                    break;
                case 11:
                    value = view.getFloat32(p, little);
                    break;
                case 12:
                    value = view.getFloat64(p, little);
                    break;
                case 5:
                    value = u32(p) / u32(p + 4);
                    break;
                case 10:
                    value = view.getInt32(p, little) / view.getInt32(p + 4, little);
                    break;
                default: throw new RangeError('GeoTIFF 数值标签不受支持。');
            }
            if (!finite(value))
                throw new RangeError(`GeoTIFF 标签 ${id} 含有无效数字。`);
            values.push(value);
        }
        return values;
    };
    const scalar = (id, fallback) => { const values = numbers(id); if (!values.length && fallback !== undefined)
        return fallback; if (values.length !== 1)
        throw new RangeError(`GeoTIFF 缺少或包含无效标签 ${id}。`); return values[0]; };
    const text = (id) => { const tag = tags.get(id); if (!tag)
        return ''; if (tag.type !== 2 || tag.count > 65536)
        throw new RangeError('GeoTIFF 文本元数据过长或格式无效。'); return new TextDecoder().decode(bytes.subarray(tag.offset, tag.offset + tag.count)).replace(/\0+$/, ''); };
    const width = scalar(256), height = scalar(257), bits = scalar(258), sampleFormat = scalar(339, 1), compression = scalar(259, 1), predictor = scalar(317, 1);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width * height > MAX_TERRAIN_RASTER_CELLS)
        throw new RangeError(`GeoTIFF 至少需要 2×2，最多 ${MAX_TERRAIN_RASTER_CELLS} 像元；不降采样计算。`);
    if (scalar(277, 1) !== 1 || scalar(284, 1) !== 1 || !([0, 1].includes(scalar(262, 1))))
        throw new RangeError('仅支持单波段灰度高程 GeoTIFF，多波段或调色板图像暂未支持。');
    if (scalar(274, 1) !== 1)
        throw new RangeError('GeoTIFF 像素方向暂仅支持左上原点、从北到南排列。');
    if (![1, 2, 3].includes(sampleFormat) || sampleFormat === 3 && ![32, 64].includes(bits) || sampleFormat !== 3 && ![8, 16, 32].includes(bits))
        throw new RangeError('GeoTIFF 支持整数 8/16/32 位或 IEEE 浮点 32/64 位高程。');
    if (![1, 5, 8, 32946].includes(compression))
        throw new RangeError(`GeoTIFF 压缩 ${compression} 暂未支持；请导出无压缩、LZW 或 Deflate 单波段文件。`);
    if (![1, 2, 3].includes(predictor) || predictor === 2 && sampleFormat === 3 || predictor === 3 && (sampleFormat !== 3 || compression === 1))
        throw new RangeError('GeoTIFF 预测编码组合暂未支持；整数支持 Predictor=1/2，LZW/Deflate 浮点支持 Predictor=1/3。');
    if (tags.has(34264))
        throw new RangeError('GeoTIFF 矩阵变换与旋转格网暂未支持，请导出北向等距像元。');
    const pixelScale = numbers(33550), tiepoints = numbers(33922), geoKeyDirectory = numbers(34735), geoDoubleParams = numbers(34736), geoAsciiParams = text(34737);
    if (pixelScale.length !== 3 || pixelScale[0] <= 0 || pixelScale[1] <= 0 || Math.abs(pixelScale[0] - pixelScale[1]) > Math.max(pixelScale[0], pixelScale[1]) * 1e-10 || !tiepoints.length || tiepoints.length % 6 !== 0)
        throw new RangeError('GeoTIFF 需要真实 PixelScale/Tiepoint，且 X/Y 像元尺寸相同、北向排列。');
    if (![0, 1].includes(pixelScale[2]) || tiepoints.some((value, index) => (index % 6 === 2 || index % 6 === 5) && value !== 0))
        throw new RangeError('GeoTIFF 三维 Z 定位变换暂未支持；请将高程写入单波段实际米值或波段 SCALE/OFFSET。');
    const keys = new Map();
    if (geoKeyDirectory.length) {
        if (geoKeyDirectory.length < 4 || geoKeyDirectory[0] !== 1 || geoKeyDirectory[1] !== 1 || ![0, 1].includes(geoKeyDirectory[2]) || geoKeyDirectory.length !== 4 + geoKeyDirectory[3] * 4 || geoKeyDirectory.some(value => !Number.isInteger(value) || value < 0 || value > 65535))
            throw new RangeError('GeoTIFF GeoKey 目录无效。');
        for (let i = 4; i < geoKeyDirectory.length; i += 4) {
            const [key, location, n, offset] = geoKeyDirectory.slice(i, i + 4);
            if (keys.has(key) || n < 1)
                throw new RangeError('GeoTIFF GeoKey 重复或长度无效。');
            let value;
            if (location === 0) {
                if (n !== 1)
                    throw new RangeError('GeoTIFF 内联 GeoKey 长度无效。');
                value = offset;
            }
            else if (location === 34737) {
                if (offset + n > geoAsciiParams.length + 1)
                    throw new RangeError('GeoTIFF GeoKey 文本偏移越界。');
                value = geoAsciiParams.slice(offset, offset + n).replace(/[|\0]+$/, '');
            }
            else {
                const source = location === 34736 ? geoDoubleParams : location === 34735 ? geoKeyDirectory : null;
                if (!source || offset + n > source.length)
                    throw new RangeError('GeoTIFF GeoKey 数值偏移越界。');
                value = source.slice(offset, offset + n);
                if (n === 1)
                    value = value[0];
            }
            keys.set(key, value);
        }
    }
    const keyNumber = (key) => { const value = keys.get(key); if (value === undefined)
        return null; if (!finite(value))
        throw new RangeError('GeoTIFF 坐标单位 GeoKey 必须是单个数字。'); return value; };
    const modelType = keyNumber(1024), projectedCrs = keyNumber(3072), linearUnit = keyNumber(3076), rasterKey = keyNumber(1025) ?? 1, verticalUnit = keyNumber(4099);
    if (projectedCrs !== null && [4326, 4269, 4258, 4490, 4979].includes(projectedCrs) || modelType !== 1 && projectedCrs === null && keyNumber(2048) !== null)
        throw new RangeError('文件声明的是地理经纬度坐标，不能将角度确认成米；请先实际投影。');
    if (modelType !== null && ![1, 32767].includes(modelType) || linearUnit !== null && linearUnit !== 9001 || verticalUnit !== null && verticalUnit !== 9001)
        throw new RangeError('GeoTIFF 必须是米制投影/本地坐标及米制高程；经纬度、英尺或其他单位请先实际转换。');
    if (![1, 2].includes(rasterKey))
        throw new RangeError('GeoTIFF RasterType 暂仅支持 PixelIsArea 或 PixelIsPoint。');
    const metadata = text(42112), readMetadata = (role) => { const matches = [...metadata.matchAll(/<Item\b([^>]*)>([^<]*)<\/Item\s*>/gi)].filter(match => new RegExp(`(?:role|name)\\s*=\\s*["']${role}["']`, 'i').test(match[1])); if (matches.length > 1)
        throw new RangeError('GeoTIFF 波段比例或单位元数据重复。'); return matches[0]?.[2].trim(); };
    const rawScale = readMetadata('scale'), rawOffset = readMetadata('offset'), bandScale = rawScale === undefined ? 1 : Number(rawScale), bandOffset = rawOffset === undefined ? 0 : Number(rawOffset), unit = readMetadata('unittype');
    if (!finite(bandScale) || !finite(bandOffset) || rawScale !== undefined && !rawScale || rawOffset !== undefined && !rawOffset)
        throw new RangeError('GeoTIFF 高程比例/偏移无效。');
    if (unit && !['m', 'meter', 'metre', 'meters', 'metres'].includes(unit.toLowerCase()))
        throw new RangeError('GeoTIFF 波段高程单位不是米，请先转换实际高程单位。');
    const declaredMeters = linearUnit === 9001 || knownMetreProjectedCrs(projectedCrs);
    if (!declaredMeters && !options.confirmLocalMeters)
        throw new GeoTIFFUnitConfirmationRequired('文件未明确声明米制投影单位。请确认原坐标、像元尺寸与高程均为本地米制后导入；经纬度数据不能确认成米。');
    const cellSize = pixelScale[0], point = rasterKey === 2, originEasting = tiepoints[3] - tiepoints[0] * cellSize - (point ? cellSize / 2 : 0), originNorthing = tiepoints[4] + tiepoints[1] * cellSize + (point ? cellSize / 2 : 0);
    for (let i = 0; i < tiepoints.length; i += 6) {
        const east = tiepoints[i + 3] - tiepoints[i] * cellSize - (point ? cellSize / 2 : 0), north = tiepoints[i + 4] + tiepoints[i + 1] * cellSize + (point ? cellSize / 2 : 0);
        if (Math.abs(east - originEasting) > cellSize * 1e-7 || Math.abs(north - originNorthing) > cellSize * 1e-7)
            throw new RangeError('GeoTIFF 定位点相互矛盾或包含旋转，不能生成可靠格网。');
    }
    const rawNoData = tags.has(42113) ? text(42113).trim() : null;
    if (rawNoData !== null && (!rawNoData || rawNoData.length > 120 || !/^[-+]?(?:nan|inf(?:inity)?|(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)$/i.test(rawNoData)))
        throw new RangeError('GeoTIFF NoData 标记无效。');
    const noData = rawNoData === null ? null : /nan/i.test(rawNoData) ? NaN : /inf/i.test(rawNoData) ? (rawNoData.startsWith('-') ? -Infinity : Infinity) : Number(rawNoData);
    const source = { format: 'geotiff', byteOrder: little ? 'little' : 'big', compression: compression, storage: tags.has(324) ? 'tiles' : 'strips', width, height, bitsPerSample: bits, sampleFormat: sampleFormat, predictor: predictor, rasterType: point ? 'point' : 'area', pixelScale, tiepoints, originEasting, originNorthing, geoKeyDirectory, geoDoubleParams, geoAsciiParams, modelType, projectedCrs, linearUnit, unitBasis: declaredMeters ? 'metadata' : 'confirmed-local', noData: rawNoData, bandScale, bandOffset };
    validateTerrainGeoTIFFSource(source);
    const originalPosition = options.placement === 'source', originX = originalPosition ? originEasting : 0, originY = originalPosition ? -originNorthing : 0;
    const raster = { format: 'geotiff', ncols: width, nrows: height, xllcorner: originX, yllcorner: -originY - height * cellSize, cellSize, noDataValue: noData !== null && Number.isFinite(noData) ? noData : null, values: Array(width * height).fill(null), coordinateUnit: 'm', yDirection: 'north-up', originX, originY };
    if (originalPosition && [originX, originY, originX + width * cellSize, originY + height * cellSize].some(value => Math.abs(value) > 1e7))
        throw new RangeError('原始米制位置超出项目 ±10000000 m 范围。请选择“放到项目左上角 0,0”；原地理坐标仍完整保存，此操作仅平移。');
    const offsets = numbers(source.storage === 'tiles' ? 324 : 273), counts = numbers(source.storage === 'tiles' ? 325 : 279);
    if (!offsets.length || offsets.length !== counts.length || tags.has(273) && tags.has(324))
        throw new RangeError('GeoTIFF 分块偏移/长度或存储方式无效。');
    const blockWidth = source.storage === 'tiles' ? scalar(322) : width, declaredHeight = source.storage === 'tiles' ? scalar(323) : scalar(278, height), blockHeight = source.storage === 'tiles' ? declaredHeight : Math.min(declaredHeight, height), columns = source.storage === 'tiles' ? Math.ceil(width / blockWidth) : 1, rows = Math.ceil(height / blockHeight);
    if (!Number.isInteger(blockWidth) || !Number.isInteger(blockHeight) || blockWidth < 1 || blockHeight < 1 || blockWidth * blockHeight * (bits / 8) > MAX_BLOCK_BYTES || offsets.length !== columns * rows)
        throw new RangeError('GeoTIFF 条带或瓦片数量、尺寸超出当前解码范围。');
    const occupied = [];
    const inflate = async (data, expected) => {
        if (typeof DecompressionStream === 'undefined')
            throw new RangeError('当前浏览器不支持 Deflate 解码，请使用无压缩 GeoTIFF 或 ASC。');
        const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate')).getReader(), chunks = [];
        let length = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                length += value.byteLength;
                if (length > expected) {
                    await reader.cancel();
                    throw new RangeError('GeoTIFF 解压结果超过实际分块尺寸。');
                }
                chunks.push(value);
            }
        }
        catch (error) {
            throw new RangeError('GeoTIFF Deflate 分块损坏或无法解压：' + (error instanceof Error ? error.message : '无效压缩数据'));
        }
        if (length !== expected)
            throw new RangeError('GeoTIFF 解压高程数量与分块尺寸不一致。');
        const result = new Uint8Array(length);
        let at = 0;
        for (const chunk of chunks) {
            result.set(chunk, at);
            at += chunk.length;
        }
        return result;
    };
    for (let index = 0; index < offsets.length; index++) {
        const offset = offsets[index], length = counts[index];
        inside(offset, length);
        if (!length || offset < 8)
            throw new RangeError('GeoTIFF 分块数据为空或偏移无效。');
        if (offset < ifd + 2 + count * 12 + 4 && offset + length > ifd || occupied.some(part => offset < part.to && offset + length > part.from))
            throw new RangeError('GeoTIFF 分块数据偏移重复覆盖或覆盖图像目录。');
        occupied.push({ from: offset, to: offset + length });
        const x = source.storage === 'tiles' ? index % columns * blockWidth : 0, y = source.storage === 'tiles' ? Math.floor(index / columns) * blockHeight : index * blockHeight, h = source.storage === 'tiles' ? blockHeight : Math.min(blockHeight, height - y), expected = blockWidth * h * bits / 8;
        let raw = compression === 1 ? bytes.subarray(offset, offset + length) : compression === 5 ? decodeTIFFLZW(bytes.subarray(offset, offset + length), expected) : await inflate(bytes.subarray(offset, offset + length), expected);
        if (raw.length !== expected)
            throw new RangeError('GeoTIFF 高程字节数与实际分块尺寸不一致。');
        if (predictor === 3)
            raw = undoTIFFFloatingPredictor(raw, blockWidth, h, bits, little);
        const block = new DataView(raw.buffer, raw.byteOffset, raw.byteLength), bytesPerSample = bits / 8, modulus = 2 ** bits;
        for (let row = 0; row < h; row++) {
            let previous = 0;
            for (let col = 0; col < blockWidth; col++) {
                const at = (row * blockWidth + col) * bytesPerSample;
                let value;
                if (sampleFormat === 3)
                    value = bits === 32 ? block.getFloat32(at, little) : block.getFloat64(at, little);
                else {
                    const unsigned = bits === 8 ? block.getUint8(at) : bits === 16 ? block.getUint16(at, little) : block.getUint32(at, little);
                    const restored = predictor === 2 ? (unsigned + previous) % modulus : unsigned;
                    previous = restored;
                    value = sampleFormat === 2 && restored >= modulus / 2 ? restored - modulus : restored;
                }
                if (x + col >= width || y + row >= height)
                    continue;
                const missing = noData !== null && (Number.isNaN(noData) ? Number.isNaN(value) : value === noData);
                if (missing)
                    continue;
                if (!finite(value))
                    throw new RangeError('GeoTIFF 包含未声明为 NoData 的无效高程。');
                raster.values[(y + row) * width + x + col] = value * bandScale + bandOffset;
            }
        }
    }
    validateRaster(raster);
    return { raster, source };
}
//# sourceMappingURL=terrain-geotiff.js.map