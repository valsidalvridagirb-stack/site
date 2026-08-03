// Одноразовий діагностичний ендпоінт: сканує зовнішні фото постачальників
// (foto.7dreamsport.ua, hub.idealsport.com.ua — посилання з колонки
// "Фото (через ;)" excel-каталогу) і знаходить фото з конкретними пікс.
// розмірами. Список URL береться зі статичного файлу api/_data/
// external-photo-urls.json (сформований локально з excel, без мережевих
// запитів) — не з бази даних, бо ці фото ніде в Supabase не зберігаються.
const { parseDimensions, mapWithConcurrency } = require('./_lib/imgdims');
const ALL_PAIRS = require('./_data/external-photo-urls.json'); // [[articul, url], ...]

const RANGE_BYTES = 262144; // 256KB
const CONCURRENCY = 40;
const FETCH_TIMEOUT_MS = 8000;

async function fetchDims(pair) {
  const [articul, url] = pair;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let r;
    try {
      r = await fetch(url, {
        headers: { Range: `bytes=0-${RANGE_BYTES - 1}` },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok && r.status !== 206) return { articul, url, error: `http_${r.status}` };
    const ab = await r.arrayBuffer();
    const buf = new Uint8Array(ab);
    const dims = parseDimensions(buf);
    if (!dims) return { articul, url, error: 'unparsed' };
    return { articul, url, width: dims.width, height: dims.height, format: dims.format };
  } catch (err) {
    return { articul, url, error: String((err && err.message) || err) };
  }
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://internal');
    const offset = Number(url.searchParams.get('offset') || '0');
    const limit = Math.min(Number(url.searchParams.get('limit') || '300'), 1000);
    const targetsParam = url.searchParams.get('targets') || '';
    const targets = new Set(
      targetsParam.split(',').map(s => s.trim()).filter(Boolean)
    );

    const pairs = ALL_PAIRS.slice(offset, offset + limit);
    if (!pairs.length) {
      res.status(200).json({ scanned: 0, total: ALL_PAIRS.length, hasMore: false, matches: [], errors: [] });
      return;
    }

    const results = await mapWithConcurrency(pairs, CONCURRENCY, fetchDims);

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
      scanned: pairs.length,
      total: ALL_PAIRS.length,
      offset,
      limit,
      hasMore: offset + pairs.length < ALL_PAIRS.length,
      nextOffset: offset + pairs.length,
      matches,
      errorCount: errors.length,
      errors: errors.slice(0, 20)
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String((err && err.message) || err) });
  }
};
