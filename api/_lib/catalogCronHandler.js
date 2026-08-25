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

      const feedRes = await fetch(url, fetchOptions || {});
      if (!feedRes.ok) {
        throw new Error(`Не вдалось завантажити фід ${url}: ${feedRes.status}`);
      }
      const feedText = await feedRes.text();

      const rawRows = parse(feedText);
      const processed = rawRows.map(processRow).filter(Boolean);

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
        processed: processed.length,
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
