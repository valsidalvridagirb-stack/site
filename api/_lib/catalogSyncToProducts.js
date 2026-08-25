// catalogSyncToProducts.js — заміняє собою колишній ручний ланцюжок Google
// Drive catalog xlsx -> scripts/sync_catalog.py -> git push: порівнює вже
// готовий supplier_catalog_merged (SQL-в'юха над supplier_catalog, яку
// наповнюють 5 cron-catalog-<постачальник> дій api/catalog.js) напряму з
// таблицею products у Supabase й одразу пише зміни через сервісний ключ —
// без git-кроку.
//
// Повторює ТОЧНО ту саму логіку, що й scripts/sync_catalog.py (і НІЧОГО не
// рахує заново — ціни/категорії вже прораховані в catalogPipeline.processRow()):
//   1. Для вже опублікованих розмірів — якщо ціна/залишок у постачальника
//      змінились, оновлює products.price/quantity.
//   2. Для АРТИКУЛІВ, які вже мають хоча б один опублікований розмір, але в
//      постачальника з'явився НОВИЙ розмір — додає цей розмір, копіюючи
//      назву/опис/фото/стать/категорії з уже опублікованого розміру того ж
//      артикулу (шаблон), а не з фіда постачальника (адмін міг вручну
//      виправити помилкову стать/категорію постачальника).
//   3. НІКОЛИ не публікує товар, якого зараз на сайті немає взагалі — це
//      лишається ручною дією через адмінку (потрібні фото/опис).
//   4. Розмір, вручну прибраний адміном через excluded_sizes, НЕ повертається
//      автоматично, навіть якщо він знов з'явився в прайсі постачальника.
//   5. Розмір, що зник із прайсів постачальників, НЕ видаляється і не
//      ховається — лишається на сайті як є (тільки лічильник у підсумку).
//
// На відміну від старого шляху, тут БІЛЬШЕ НЕ регенерується
// api/_data/excel-catalog.json — api/catalog.js читає supplier_catalog_merged
// напряму, тож статичний файл більше не потрібен.
const { supaService, supaServiceAll } = require('./supabaseService');

const CRON_SECRET = process.env.CRON_SECRET;
const WRITE_BATCH_SIZE = 500;
const SAMPLE_LIMIT = 20;

function key(art, size) {
  return `${String(art).toLowerCase()}${String(size)}`;
}

// Журнал перебігу в sync_runs (action='sync') — суто для діагностики через
// Supabase. "fire-and-forget" (рання відповідь + продовження роботи після
// res.json()) тут навмисно НЕ використовується — перевірено емпірично на
// catalogCronHandler.js, що Vercel вбиває інвокейшн одразу після
// відправленої відповіді, без офіційного waitUntil() з @vercel/functions
// (якого в цьому build-free проєкті немає). Хендлер лишається повністю
// синхронним.
async function logRunStart() {
  try {
    const rows = await supaService('sync_runs', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{ action: 'sync' }]),
    });
    return rows && rows[0] ? rows[0].id : null;
  } catch (err) {
    console.error('[sync_runs] insert failed for sync:', err);
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

async function writeBatches(rows, path, headers) {
  let written = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += WRITE_BATCH_SIZE) {
    const chunk = rows.slice(i, i + WRITE_BATCH_SIZE);
    try {
      await supaService(path, { method: 'POST', headers, body: JSON.stringify(chunk) });
      written += chunk.length;
    } catch (err) {
      errors.push(String((err && err.message) || err));
    }
  }
  return { written, errors };
}

// products.id — GENERATED ALWAYS AS IDENTITY: Postgres refuses ANY INSERT
// that supplies an explicit id, even one whose only real purpose is to hit
// an ON CONFLICT DO UPDATE branch ("cannot insert a non-DEFAULT value into
// column \"id\""), so the usual bulk-upsert-by-primary-key trick used
// elsewhere in this project (see catalogSyncToProducts's insert step below,
// and catalogCronHandler.js) doesn't work here. A set-based UPDATE has no
// such restriction, so price/qty changes go through a small SQL function
// (see migration bulk_update_product_price_qty_fn) that does
// `UPDATE products ... FROM jsonb_array_elements($1)` in one round trip
// per batch instead.
async function applyPriceQtyUpdates(updateRows) {
  let written = 0;
  const errors = [];
  for (let i = 0; i < updateRows.length; i += WRITE_BATCH_SIZE) {
    const chunk = updateRows.slice(i, i + WRITE_BATCH_SIZE).map((u) => ({
      id: u.id, price: u.price, quantity: u.quantity,
    }));
    try {
      await supaService('rpc/bulk_update_product_price_qty', {
        method: 'POST',
        body: JSON.stringify({ updates: chunk }),
      });
      written += chunk.length;
    } catch (err) {
      errors.push(String((err && err.message) || err));
    }
  }
  return { written, errors };
}

module.exports = async (req, res) => {
  const reqUrl = new URL(req.url, 'http://internal');
  const secret = reqUrl.searchParams.get('secret');
  if (!CRON_SECRET || secret !== CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const runId = await logRunStart();

  try {
    const [mergedRaw, products, excludedSizes] = await Promise.all([
      supaServiceAll('supplier_catalog_merged?select=sku,size,retail_price,qty,brand,gender,category_1,category_2,category_3,supplier'),
      supaServiceAll('products?select=id,articul,name,size,price,quantity,brand,gender,category_1,category_2,category_3,description,photos,supplier,size_chart_gender,extra_categories&order=id.asc'),
      supaServiceAll('excluded_sizes?select=articul,size'),
    ]);

    let skippedBad = 0;
    const catalogRows = [];
    for (const r of mergedRaw) {
      const art = String(r.sku || '').trim();
      const size = String(r.size || '').trim();
      const price = r.retail_price === null || r.retail_price === undefined ? null : Number(r.retail_price);
      if (!art || !size || price === null || Number.isNaN(price)) { skippedBad += 1; continue; }
      catalogRows.push({
        art, size, price, qty: r.qty || 0, brand: r.brand || '', gender: r.gender || '',
        cat1: r.category_1 || '', cat2: r.category_2 || '', cat3: r.category_3 || '',
        supplier: r.supplier || '',
      });
    }

    const lookup = new Map();
    for (const c of catalogRows) lookup.set(key(c.art, c.size), c);

    const existingKeys = new Set();
    const existingArticuls = new Set();
    const templateByArticul = new Map();
    for (const p of products) {
      const artL = String(p.articul).toLowerCase();
      existingKeys.add(key(artL, p.size));
      existingArticuls.add(artL);
      if (!templateByArticul.has(artL)) templateByArticul.set(artL, p);
    }

    const excludedKeys = new Set(excludedSizes.map((e) => key(e.articul, e.size)));

    // --- ціна/залишок для вже опублікованих розмірів ---
    const updates = [];
    let goneCount = 0;
    const goneSample = [];
    for (const p of products) {
      const k = key(p.articul, p.size);
      const c = lookup.get(k);
      if (!c) {
        goneCount += 1;
        if (goneSample.length < SAMPLE_LIMIT) goneSample.push(`${p.articul}/${p.size}`);
        continue;
      }
      const oldPrice = Number(p.price);
      const oldQty = Number(p.quantity || 0);
      if (Math.abs(c.price - oldPrice) > 0.01 || c.qty !== oldQty) {
        updates.push({
          id: p.id, articul: p.articul, name: p.name, size: p.size, price: c.price, quantity: c.qty,
        });
      }
    }

    // --- нові розміри вже опублікованих артикулів ---
    const newSizes = [];
    let skippedExcludedCount = 0;
    const skippedExcludedSample = [];
    for (const c of catalogRows) {
      const k = key(c.art, c.size);
      if (existingKeys.has(k)) continue;
      const artL = c.art.toLowerCase();
      if (!existingArticuls.has(artL)) continue;
      if (excludedKeys.has(k)) {
        skippedExcludedCount += 1;
        if (skippedExcludedSample.length < SAMPLE_LIMIT) skippedExcludedSample.push(`${c.art}/${c.size}`);
        continue;
      }
      newSizes.push({ catalog: c, template: templateByArticul.get(artL) });
    }

    // --- застосовуємо: bulk SET-based update ціни/залишку через RPC ---
    const updateResult = updates.length
      ? await applyPriceQtyUpdates(updates)
      : { written: 0, errors: [] };

    // --- застосовуємо: звичайний insert нових розмірів ---
    // Поля identity/подання (name/description/photos/gender/category_*/
    // size_chart_gender/extra_categories/articul) — ЗАВЖДИ з template
    // (вже опублікований рядок цього ж артикулу), а НЕ з фіда постачальника
    // — точнісінько як `template.get(field, ...)` у sync_catalog.py, де
    // ключ у словнику вже опублікованого товару присутній завжди, тож
    // резервне значення там ніколи фактично не спрацьовує.
    const newSizeRows = newSizes.map(({ catalog: c, template: t }) => ({
      articul: t.articul,
      name: t.name,
      size: c.size,
      price: c.price,
      quantity: c.qty,
      brand: c.brand,
      gender: t.gender,
      category_1: t.category_1,
      category_2: t.category_2,
      category_3: t.category_3,
      description: t.description,
      photos: t.photos,
      supplier: c.supplier,
      size_chart_gender: t.size_chart_gender,
      extra_categories: Array.isArray(t.extra_categories) ? t.extra_categories : [],
    }));
    const insertResult = newSizeRows.length
      ? await writeBatches(newSizeRows, 'products', { Prefer: 'return=minimal' })
      : { written: 0, errors: [] };

    const errors = [...updateResult.errors, ...insertResult.errors];

    const summary = {
      timestamp: new Date().toISOString(),
      source: 'supplier_catalog_merged',
      catalog_rows: catalogRows.length,
      skipped_bad: skippedBad,
      products_checked: products.length,
      updates_needed: updates.length,
      updates_applied: updateResult.written,
      new_sizes_needed: newSizes.length,
      new_sizes_applied: insertResult.written,
      skipped_excluded: skippedExcludedCount,
      no_longer_available: goneCount,
      no_longer_available_sample: goneSample,
      new_sizes_sample: newSizes.slice(0, SAMPLE_LIMIT).map((i) => `${i.catalog.art}/${i.catalog.size}`),
      skipped_excluded_sample: skippedExcludedSample,
      errors,
    };
    await logRunFinish(runId, errors.length === 0, summary);
    res.status(200).json({ ok: errors.length === 0, runId, ...summary });
  } catch (err) {
    const message = String((err && err.message) || err);
    await logRunFinish(runId, false, { error: message });
    res.status(500).json({ error: 'server_error', runId, message });
  }
};
