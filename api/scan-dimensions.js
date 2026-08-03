// Одноразовий діагностичний ендпоінт: сканує бакет product-images і знаходить
// файли з конкретними пікс. розмірами. Читає лише перші ~256KB кожного файлу
// (Range-запит) і парсить заголовок JPEG/JFIF/PNG/WEBP самостійно — без
// завантаження всього файлу і без зовнішніх npm-залежностей.
//
// Список шляхів береться сторінками через RPC list_product_image_paths
// (бакет публічний, самі назви файлів не є секретом).
const SUPABASE_URL = 'https://jkwppbriklmxbivndxeq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprd3BwYnJpa2xteGJpdm5keGVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0OTIyMDUsImV4cCI6MjEwMTA2ODIwNX0.z1URg0dT6DsBT8nSkGvDeSrXls6bgOuU3UJBlvS-5gc';
const PUBLIC_BASE = `${SUPABASE_URL}/storage/v1/object/public/product-images/`;
const RANGE_BYTES = 262144; // 256KB
const CONCURRENCY = 40;

async function rpc(name, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`rpc ${name} -> ${r.status}`);
  return r.json();
}

// ---- парсери розмірів зображень (магічні байти, не розширення файлу) ----

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

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function fetchDims(path) {
  const url = PUBLIC_BASE + encodePath(path);
  try {
    const r = await fetch(url, { headers: { Range: `bytes=0-${RANGE_BYTES - 1}` } });
    if (!r.ok && r.status !== 206) return { path, error: `http_${r.status}` };
    const ab = await r.arrayBuffer();
    const buf = new Uint8Array(ab);
    const dims = parseDimensions(buf);
    if (!dims) return { path, error: 'unparsed' };
    return { path, width: dims.width, height: dims.height, format: dims.format };
  } catch (err) {
    return { path, error: String((err && err.message) || err) };
  }
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

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://internal');
    const offset = Number(url.searchParams.get('offset') || '0');
    const limit = Math.min(Number(url.searchParams.get('limit') || '500'), 2000);
    const targetsParam = url.searchParams.get('targets') || '';
    const targets = new Set(
      targetsParam.split(',').map(s => s.trim()).filter(Boolean)
    );

    const paths = await rpc('list_product_image_paths', { p_offset: offset, p_limit: limit });
    if (!paths || !paths.length) {
      res.status(200).json({ scanned: 0, hasMore: false, matches: [], errors: [] });
      return;
    }

    const results = await mapWithConcurrency(paths, CONCURRENCY, fetchDims);

    const matches = [];
    const errors = [];
    for (const r of results) {
      if (r.error) { errors.push(r); continue; }
      const key = `${r.width}x${r.height}`;
      if (targets.size === 0 || targets.has(key)) {
        matches.push(r);
      }
    }

    res.status(200).json({
      scanned: paths.length,
      offset,
      limit,
      hasMore: paths.length === limit,
      nextOffset: offset + paths.length,
      matches,
      errorCount: errors.length,
      errors: errors.slice(0, 20)
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String((err && err.message) || err) });
  }
};
