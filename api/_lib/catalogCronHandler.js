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
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'uk-UA,uk;q=0.9,ru;q=0.8,en-US;q=0.7,en;q=0.6',
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

// Деякі постачальники (drop.yesoriginal.com.ua) 403-ять САМЕ запити з IP
// Vercel-датацентрів, навіть з повним набором браузерних заголовків (з
// браузера власника той самий URL відкривається без проблем) — типовий
// WAF/Cloudflare IP-reputation блок, який заголовками не обійти. Якщо для
// постачальника ввімкнено opts.proxyFallback, при 403/мережевій помилці
// пробуємо ще раз через публічний CORS/raw-проксі (allorigins.win) — його
// IP може не потрапляти під той самий блок-лист. Це не гарантоване рішення
// (проксі теж хмарний і теж може бути заблокований), але дешевий і швидкий
// спосіб перевірити, перш ніж визнавати постачальника недоступним для
// автоматизації.
async function fetchViaProxy(url) {
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxyUrl, { headers: DEFAULT_FEED_HEADERS });
  if (!res.ok) {
    throw new Error(`proxy_http_${res.status}`);
  }
  return res.text();
}

async function describeFailedResponse(feedRes) {
  const bodySnippet = await feedRes.text().catch(() => '');
  return {
    status: feedRes.status,
    statusText: feedRes.statusText,
    server: feedRes.headers.get('server') || '',
    cfRay: feedRes.headers.get('cf-ray') || '',
    cfMitigated: feedRes.headers.get('cf-mitigated') || '',
    contentType: feedRes.headers.get('content-type') || '',
    bodySnippet: bodySnippet.slice(0, 500),
  };
}

// Повертає { text, usedProxy, directFetchDiag } замість голого тексту, щоб
// у відповіді хендлера було видно, ЩО саме сталось при прямому запиті
// (корисно для діагностики навіть коли проксі-фолбек все ж спрацював).
async function fetchFeedText(url, mergedFetchOptions, useProxyFallback) {
  let feedRes;
  let directFetchDiag = null;
  try {
    feedRes = await fetch(url, mergedFetchOptions);
  } catch (err) {
    directFetchDiag = { networkError: String((err && err.message) || err) };
    if (!useProxyFallback) throw new Error(`Мережева помилка при запиті ${url}: ${directFetchDiag.networkError}`);
  }

  if (feedRes && !feedRes.ok) {
    directFetchDiag = await describeFailedResponse(feedRes);
  }

  if (feedRes && feedRes.ok) {
    return { text: await feedRes.text(), usedProxy: false, directFetchDiag: null };
  }

  if (!useProxyFallback) {
    throw new Error(`Не вдалось завантажити фід ${url}: ${JSON.stringify(directFetchDiag)}`);
  }

  try {
    const text = await fetchViaProxy(url);
    return { text, usedProxy: true, directFetchDiag };
  } catch (proxyErr) {
    throw new Error(`Пряме завантаження ${url} впало (${JSON.stringify(directFetchDiag)}), проксі-фолбек теж впав: ${String((proxyErr && proxyErr.message) || proxyErr)}`);
  }
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

// ПРИМІТКА (перевірено емпірично): "fire-and-forget" тут НЕ працює — Vercel
// вбиває інвокейшн одразу після res.json(), навіть якщо async-хендлер ще не
// повернувся (жодного коду після відправленої відповіді фактично не
// виконується, без офіційного waitUntil() з @vercel/functions, якого в цьому
// build-free проєкті немає). Тому хендлер лишається повністю синхронним —
// відповідає ОДНИМ res.json() у самому кінці, як і раніше. sync_runs
// (started_at/finished_at/ok/summary) тепер лишається просто журналом
// перебігу (для діагностики через Supabase), а не механізмом обходу
// таймауту виклику — той вирішується на боці інструменту, яким щогодинне
// завдання дзвонить на ці урли (не WebFetch — у нього закороткий
// read-timeout для великих фідів, підтверджено тестами).
async function logRunStart(action) {
  if (!SERVICE_KEY) return null;
  try {
    const rows = await supaService('sync_runs', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{ action }]),
    });
    return rows && rows[0] ? rows[0].id : null;
  } catch (err) {
    console.error(`[sync_runs] insert failed for ${action}:`, err);
    return null;
  }
}

async function logRunFinish(runId, ok, summary) {
  if (!runId) return;
  try {
    await supaService(`sync_runs?id=eq.${runId}`, {
      method: 'PATCH',
      body: JSON.stringify({ finished_at: new Date().toISOString(), ok, summary }),
    });
  } catch (err) {
    console.error(`[sync_runs] update failed for run ${runId}:`, err);
  }
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
    supplier, url, parse, fetchOptions, minExpectedRows = 1, proxyFallback = false,
  } = opts;

  return async (req, res) => {
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
    const runId = await logRunStart(supplier);

    try {
      const mergedFetchOptions = {
        ...(fetchOptions || {}),
        headers: { ...DEFAULT_FEED_HEADERS, ...((fetchOptions && fetchOptions.headers) || {}) },
      };
      const { text: feedText, usedProxy, directFetchDiag } = await fetchFeedText(url, mergedFetchOptions, proxyFallback);

      const rawRows = parse(feedText);
      const processedRaw = rawRows.map(processRow).filter(Boolean);
      const processed = dedupeWithinSupplier(processedRaw);

      if (processed.length < minExpectedRows) {
        const summary = {
          supplier,
          fetched: rawRows.length,
          processed: processed.length,
          upserted: 0,
          usedProxy,
          directFetchDiag,
          warning: 'too_few_rows_aborted_without_writing',
        };
        await logRunFinish(runId, false, summary);
        res.status(200).json({ ok: false, runId, ...summary });
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

      const summary = {
        supplier,
        fetched: rawRows.length,
        processed: processedRaw.length,
        duplicatesRemoved: processedRaw.length - processed.length,
        upserted,
        staleCleanupOk,
        usedProxy,
        directFetchDiag,
        errors,
      };
      await logRunFinish(runId, errors.length === 0, summary);
      res.status(200).json({ ok: errors.length === 0, runId, ...summary });
    } catch (err) {
      const message = String((err && err.message) || err);
      await logRunFinish(runId, false, { supplier, error: message });
      res.status(500).json({
        error: 'server_error', supplier, runId, message,
      });
    }
  };
}

module.exports = { makeCatalogCronHandler };
