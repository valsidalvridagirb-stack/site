// catalogCronHandler.js — factory that builds a Vercel serverless handler
// for ONE supplier's catalog sync: fetch its public feed -> parse -> run
// through catalogPipeline.processRow() -> upsert into Supabase
// `supplier_catalog` -> delete rows for this supplier that weren't touched
// by this run (stale / no-longer-listed products).
//
// Mirrors the existing api/cron-sync-ttn.js pattern: protected by
// CRON_SECRET (?secret=... query param), writes via SUPABASE_SERVICE_ROLE_KEY
// (bypasses RLS), triggered by a single WebFetch call from the hourly
// scheduled task rather than Vercel's own Cron.
//
// Writes are always scoped to THIS supplier only — a per-supplier run never
// touches other suppliers' rows. The cross-supplier "which price wins"
// merge/dedup happens at READ time via the `supplier_catalog_merged` SQL
// view, not here, so a slow/failed run for one supplier can never corrupt
// another supplier's currently-live data.
const { supaService, SERVICE_KEY } = require('./supabaseService');
const { processRow } = require('./catalogPipeline');

const CRON_SECRET = process.env.CRON_SECRET;
const UPSERT_BATCH_SIZE = 500;
const UPSERT_CONCURRENCY = 4;

// Деякі постачальники (напр. drop.yesoriginal.com.ua) віддають 403 на запит
// без "браузерного" User-Agent — типовий bot-detection на боці хостингу
// фіда. Fetch() у Node/Vercel за замовчуванням шле generic/порожній UA.
const DEFAULT_FEED_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: '*/*',
};

// Дедублікація В МЕЖАХ одного постачальника — те саме, що робив merge_all()
// у update.py (ключ — (sku, size) у ВЕРХНЬОМУ регістрі, лишаємо рядок з
// найменшою drop_price, а при рівній ціні — з більшою кількістю). Це не
// заміна supplier_catalog_merged (та в'юха дедублікує МІЖ постачальниками
// на READ), а обов'язковий крок ПЕРЕД bulk-upsert: сам фід постачальника
// (напр. tcross) може містити кілька офферів з однаковим (sku, size) —
// а один SQL-запит на upsert не може зачепити той самий рядок (той самий
// on_conflict-ключ) двічі, інакше Postgres падає з
// "ON CONFLICT DO UPDATE command cannot affect row a second time".
function dedupeWithinSupplier(rows) {
  const bySkuSize = new Map();
  for (const r of rows) {
    const k = `${String(r.sku).trim().toUpperCase()}::${String(r.size).trim().toUpperCase()}`;
    const existing = bySkuSize.get(k);
    if (!existing) {
      bySkuSize.set(k, r);
    } else if (r.drop_price < existing.drop_price
      || (r.drop_price === existing.drop_price && r.qty > existing.qty)) {
      bySkuSize.set(k, r);
    }
  }
  return [...bySkuSize.values()];
}

function toUpsertRow(r, runStart) {
  return {
    sku: r.sku,
    size: r.size,
    supplier: r.supplier,
    name: r.name,
    drop_price: r.drop_price,
    retail_price: r.retail_price,
    qty: r.qty,
    brand: r.brand,
    gender: r.gender,
    category_1: r.category_1,
    category_2: r.category_2,
    category_3: r.category_3,
    description: r.description,
    photos: r.photos,
    updated_at: runStart,
  };
}

async function upsertBatches(batches) {
  let upserted = 0;
  const errors = [];
  let idx = 0;
  async function worker() {
    for (;;) {
      const my = idx;
      idx += 1;
      if (my >= batches.length) return;
      try {
        await supaService('supplier_catalog?on_conflict=sku,size,supplier', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(batches[my]),
        });
        upserted += batches[my].length;
      } catch (err) {
        errors.push(String((err && err.message) || err));
      }
    }
  }
  const workerCount = Math.max(1, Math.min(UPSERT_CONCURRENCY, batches.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return { upserted, errors };
}

// opts:
//   supplier      — string, must match the `supplier` value processRow() sets
//   url           — feed URL to fetch
//   parse         — (feedBodyText) => raw rows (see catalogParsers.js)
//   fetchOptions  — optional extra fetch() init (headers, etc.)
//   minExpectedRows — sanity floor: if parsed+processed rows fall below
//     this, ABORT without writing/deleting anything (mirrors update.py's
//     own "якщо офферів 0 — файл НЕ перезаписую" guard in
//     tcross_feed_sync.py, generalized as a safety net against a supplier
//     feed that's temporarily empty/broken silently wiping the catalog)
function makeCatalogCronHandler(opts) {
  const {
    supplier, url, parse, fetchOptions, minExpectedRows = 1,
  } = opts;

  return async (req, res) => {
    try {
      const reqUrl = new URL(req.url, 'http://internal');
      const secret = reqUrl.searchParams.get('secret');
      if (!CRON_SECRET || secret !== CRON_SECRET) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      if (!SERVICE_KEY) {
        res.status(500).json({ error: 'no_service_key', message: 'SUPABASE_SERVICE_ROLE_KEY не налаштовано на сервері' });
        return;
      }

      const runStart = new Date().toISOString();

      const mergedFetchOptions = {
        ...(fetchOptions || {}),
        headers: { ...DEFAULT_FEED_HEADERS, ...((fetchOptions && fetchOptions.headers) || {}) },
      };
      const feedRes = await fetch(url, mergedFetchOptions);
      if (!feedRes.ok) {
        throw new Error(`Не вдалось завантажити фід ${url}: ${feedRes.status}`);
      }
      const feedText = await feedRes.text();

      const rawRows = parse(feedText);
      const processedRaw = rawRows.map(processRow).filter(Boolean);
      const processed = dedupeWithinSupplier(processedRaw);

      if (processed.length < minExpectedRows) {
        res.status(200).json({
          ok: false,
          supplier,
          fetched: rawRows.length,
          processed: processed.length,
          upserted: 0,
          warning: 'too_few_rows_aborted_without_writing',
        });
        return;
      }

      const batches = [];
      for (let i = 0; i < processed.length; i += UPSERT_BATCH_SIZE) {
        batches.push(processed.slice(i, i + UPSERT_BATCH_SIZE).map((r) => toUpsertRow(r, runStart)));
      }
      const { upserted, errors } = await upsertBatches(batches);

      // Remove rows for this supplier that this run did NOT touch (i.e. no
      // longer present in the feed) — scoped strictly to this supplier so it
      // can never affect other suppliers' rows.
      let staleCleanupOk = true;
      try {
        await supaService(
          `supplier_catalog?supplier=eq.${encodeURIComponent(supplier)}&updated_at=lt.${encodeURIComponent(runStart)}`,
          { method: 'DELETE' },
        );
      } catch (err) {
        staleCleanupOk = false;
        errors.push(`stale_cleanup: ${String((err && err.message) || err)}`);
      }

      res.status(200).json({
        ok: errors.length === 0,
        supplier,
        fetched: rawRows.length,
        processed: processedRaw.length,
        duplicatesRemoved: processedRaw.length - processed.length,
        upserted,
        staleCleanupOk,
        errors,
      });
    } catch (err) {
      res.status(500).json({
        error: 'server_error', supplier, message: String((err && err.message) || err),
      });
    }
  };
}

module.exports = { makeCatalogCronHandler };
