// Спільний парсер піксельних розмірів зображень з "сирих" байтів заголовка
// (JPEG/JFIF, PNG, WEBP) — без завантаження всього файлу і без зовнішніх
// npm-залежностей. Використовується у api/scan-dimensions.js та
// api/scan-external-dimensions.js.

function getUint16BE(buf, off) { return (buf[off] << 8) | buf[off + 1]; }
function getUint32BE(buf, off) { return (buf[off] * 0x1000000) + (buf[off + 1] << 16) + (buf[off + 2] << 8) + buf[off + 3]; }

function parseJPEG(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xFF) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { off += 2; continue; }
    if (off + 4 > buf.length) break;
    const segLen = getUint16BE(buf, off + 2);
    const isSOF = (marker >= 0xC0 && marker <= 0xCF) && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isSOF) {
      if (off + 9 > buf.length) return null; // потрібно докачати більше — рідкісний випадок
      const height = getUint16BE(buf, off + 5);
      const width = getUint16BE(buf, off + 7);
      return { width, height, format: 'jpeg' };
    }
    if (marker === 0xDA) return null; // почались дані сканування, SOF мав бути раніше
    off += 2 + segLen;
  }
  return null; // SOF не знайдено у прочитаному діапазоні
}

function parsePNG(buf) {
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  if (buf.length < 24) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  const width = getUint32BE(buf, 16);
  const height = getUint32BE(buf, 20);
  return { width, height, format: 'png' };
}

function parseWEBP(buf) {
  if (buf.length < 30) return null;
  if (buf[0] !== 0x52 || buf[1] !== 0x49 || buf[2] !== 0x46 || buf[3] !== 0x46) return null; // RIFF
  if (buf[8] !== 0x57 || buf[9] !== 0x45 || buf[10] !== 0x42 || buf[11] !== 0x50) return null; // WEBP
  const fourcc = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
  if (fourcc === 'VP8 ') {
    // ці поля little-endian (на відміну від решти WEBP/RIFF, які теж LE,
    // але тут це особливо важливо — переплутати легко)
    const width = (buf[26] | (buf[27] << 8)) & 0x3FFF;
    const height = (buf[28] | (buf[29] << 8)) & 0x3FFF;
    return { width, height, format: 'webp' };
  }
  if (fourcc === 'VP8L') {
    const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    const width = 1 + (((b1 & 0x3F) << 8) | b0);
    const height = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
    return { width, height, format: 'webp' };
  }
  if (fourcc === 'VP8X') {
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height, format: 'webp' };
  }
  return null;
}

function parseDimensions(buf) {
  return parseJPEG(buf) || parsePNG(buf) || parseWEBP(buf);
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = { parseDimensions, mapWithConcurrency };
