export const MAX_TIFF_DECODED_BLOCK_BYTES = 2_000_000;
function expectedSize(expected) { if (!Number.isSafeInteger(expected) || expected < 1 || expected > MAX_TIFF_DECODED_BLOCK_BYTES)
    throw new RangeError('TIFF 解码分块尺寸应为 1～2000000 字节。'); }
/** TIFF 6 LZW is MSB-first with early-change=1, independent of TIFF byte order.
 * Prefix/suffix tables are bounded to 4096 codes; no growing string dictionary. */
export function decodeTIFFLZW(data, expectedBytes) {
    expectedSize(expectedBytes);
    if (!(data instanceof Uint8Array) || !data.length || data.length > 8_000_000)
        throw new RangeError('TIFF LZW 压缩分块无效。');
    const output = new Uint8Array(expectedBytes), prefix = new Int16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4096);
    for (let i = 0; i < 256; i++)
        suffix[i] = i;
    let bit = 0, width = 9, next = 258, previous = -1, written = 0, started = false, ended = false;
    const read = () => { if (bit + width > data.length * 8)
        throw new RangeError('TIFF LZW 位流截断，缺少完整代码或 EOI。'); let code = 0; for (let i = 0; i < width; i++, bit++)
        code = code * 2 + (data[bit >> 3] >> (7 - (bit & 7)) & 1); return code; };
    const expand = (code) => { let length = 0, cursor = code; while (cursor >= 256) {
        if (cursor < 258 || cursor >= next || length >= 4095)
            throw new RangeError('TIFF LZW 字典引用无效或循环。');
        stack[length++] = suffix[cursor];
        cursor = prefix[cursor];
    } stack[length++] = cursor; return { length, first: cursor }; };
    while (!ended) {
        const code = read();
        if (!started && code !== 256)
            throw new RangeError('TIFF LZW 必须以 Clear 代码开始；旧 LSB 编码暂未支持。');
        started = true;
        if (code === 256) {
            width = 9;
            next = 258;
            previous = -1;
            continue;
        }
        if (code === 257) {
            ended = true;
            break;
        }
        if (code > next || code === next && previous < 0)
            throw new RangeError('TIFF LZW 含有超出字典的代码。');
        const special = code === next, entry = expand(special ? previous : code), length = entry.length + (special ? 1 : 0);
        if (written + length > expectedBytes)
            throw new RangeError('TIFF LZW 解码结果超过实际分块尺寸。');
        for (let i = entry.length - 1; i >= 0; i--)
            output[written++] = stack[i];
        if (special)
            output[written++] = entry.first;
        if (previous >= 0 && next < 4096) {
            prefix[next] = previous;
            suffix[next] = entry.first;
            next++;
            if (width < 12 && next === (1 << width) - 1)
                width++;
        }
        previous = code;
    }
    if (written !== expectedBytes)
        throw new RangeError('TIFF LZW 解码字节数与实际分块尺寸不一致。');
    // TIFF writers byte-pad the EOI; nonzero trailing data indicates corruption.
    for (; bit < data.length * 8; bit++)
        if (data[bit >> 3] >> (7 - (bit & 7)) & 1)
            throw new RangeError('TIFF LZW EOI 后包含额外非零数据。');
    return output;
}
/** Predictor 3 differences the complete byte row with sample stride 1, then
 * stores MSB-first byte planes. Restore planes into the file's IEEE byte order.
 * This single-band operation never interprets floats or alters NaN payloads. */
export function undoTIFFFloatingPredictor(data, width, rows, bits, littleEndian) {
    if (![32, 64].includes(bits) || !Number.isSafeInteger(width) || !Number.isSafeInteger(rows) || width < 1 || rows < 1 || typeof littleEndian !== 'boolean')
        throw new RangeError('TIFF 浮点 Predictor 3 样本尺寸或字节序无效。');
    const bps = bits / 8, rowBytes = width * bps, expected = rowBytes * rows;
    expectedSize(expected);
    if (!(data instanceof Uint8Array) || data.length !== expected)
        throw new RangeError('TIFF 浮点 Predictor 3 字节数与实际分块尺寸不一致。');
    const output = new Uint8Array(expected), row = new Uint8Array(rowBytes);
    for (let r = 0; r < rows; r++) {
        const offset = r * rowBytes;
        row.set(data.subarray(offset, offset + rowBytes));
        for (let i = 1; i < rowBytes; i++)
            row[i] = (row[i] + row[i - 1]) & 255;
        for (let col = 0; col < width; col++)
            for (let plane = 0; plane < bps; plane++)
                output[offset + col * bps + (littleEndian ? bps - 1 - plane : plane)] = row[plane * width + col];
    }
    return output;
}
//# sourceMappingURL=terrain-tiff-codecs.js.map