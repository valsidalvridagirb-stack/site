// Одноразовий діагностичний ендпоінт: сканує бакет product-images і знаходить
// файли з конкретними пікс. розмірами. Читає лише перші ~256KB кожного файлу
// (Range-запит) і парсить заголовок JPEG/JFIF/PNG/WEBP самостійно.
//
// Список шляхів береться сторінками через RPC list_product_image_paths
// (бакет публічний, самі назви файлів не є секретом).
const { parseDimensions, mapWithConcurrency } = require('./_lib/imgdims');

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
