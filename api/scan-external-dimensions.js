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

// Позиція фото в межах артикула — постачальник нумерує файли послідовно
// (..._1.jpg, ..._2.jpg, ...), і ця позиція (а не роздільна здатність)
// визначає ракурс: 1=справа, 2=зліва, 3=пара спереду, 4=зверху, 5=задник,
// 6=підошва, 7-8=макро. Рахуємо по ПОВНОМУ набору фото артикула (до
// фільтрації за розміром), інакше позиції "поїдуть" якщо якесь фото
// випаде з відбору за roздільною здатністю.
const POSITION_BY_URL = new Map();
{
  const byArticul = new Map();
  for (const [articul, url] of ALL_PAIRS) {
    if (!byArticul.has(articul)) byArticul.set(articul, []);
    byArticul.get(articul).push(url);
  }
  const suffixRe = /(\d+)(?=\.[a-zA-Z0-9]+(?:\?.*)?$)/;
  for (const [articul, urls] of byArticul) {
    const sorted = urls.slice().sort((a, b) => {
      const na = Number((a.match(suffixRe) || [])[1]);
      const nb = Number((b.match(suffixRe) || [])[1]);
      if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b);
      return na - nb;
    });
    sorted.forEach((url, i) => {
      POSITION_BY_URL.set(url, { position: i + 1, totalForArticul: sorted.length });
    });
  }
}

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

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return {};
}

module.exports = async (req, res) => {
  try {
    let pairs, total, offset, limit;

    let targetsParam;
    if (req.method === 'POST') {
      // Режим повторної перевірки: клієнт сам присилає конкретні пари
      // [articul, url], які раніше впали з помилкою (таймаут, тимчасова
      // недоступність постачальника тощо) — без прив'язки до offset/limit
      // у загальному списку.
      const body = await readJsonBody(req);
      pairs = Array.isArray(body.pairs) ? body.pairs : [];
      total = pairs.length;
      offset = 0;
      limit = pairs.length;
      targetsParam = (body.targets || []).join(',');
    } else {
      const url = new URL(req.url, 'http://internal');
      offset = Number(url.searchParams.get('offset') || '0');
      limit = Math.min(Number(url.searchParams.get('limit') || '300'), 1000);
      pairs = ALL_PAIRS.slice(offset, offset + limit);
      total = ALL_PAIRS.length;
      targetsParam = url.searchParams.get('targets') || '';
    }

    const targets = new Set(
      targetsParam.split(',').map(s => s.trim()).filter(Boolean)
    );

    if (!pairs.length) {
      res.status(200).json({ scanned: 0, total, hasMore: false, matches: [], errors: [] });
      return;
    }

    const results = await mapWithConcurrency(pairs, CONCURRENCY, fetchDims);

    const matches = [];
    const errors = [];
    for (const r of results) {
      if (r.error) { errors.push(r); continue; }
      const key = `${r.width}x${r.height}`;
      if (targets.size === 0 || targets.has(key)) {
        const pos = POSITION_BY_URL.get(r.url);
        matches.push(Object.assign({}, r, pos ? { position: pos.position, totalForArticul: pos.totalForArticul } : {}));
      }
    }

    res.status(200).json({
      scanned: pairs.length,
      total,
      offset,
      limit,
      hasMore: req.method === 'POST' ? false : offset + pairs.length < total,
      nextOffset: offset + pairs.length,
      matches,
      errorCount: errors.length,
      errors
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String((err && err.message) || err) });
  }
};
