// Місток між сайтом і Google-таблицею CRM_дропшиппинг_fixed (аркуш
// "Замовлення"). Сама таблиця нічого не знає про Supabase — приймає лише
// готові дані через Google Apps Script Web App (SHEET_WEBAPP_URL), захищений
// спільним секретом (SHEET_WEBAPP_SECRET), обидва — змінні середовища на
// Vercel, ніколи не потрапляють у браузер.
//
// Два режими:
//   action=create — викликається з checkout.html одразу після оформлення
//     замовлення (публічно, як і /api/notify-order — не блокує оформлення,
//     якщо щось піде не так). Тут-таки підтягуємо дроп-ціну з окремої
//     таблиці product_costs (сервісним ключем, в обхід RLS) — вона ніколи
//     не потрапляє в jsonLd/меню/куди-небудь на сайт, тільки в цю таблицю.
//   action=update — викликається з адмінки (saveTtnManual, тому вимагає
//     admin-токен) і з cron-sync-ttn.js (сервер-сервер, тому напряму, без
//     цього ендпоінта) при зміні ТТН/статусу посилки вже існуючого рядка.
const { requireAdmin, getToken } = require('./_lib/np');

const SUPABASE_URL = 'https://jkwppbriklmxbivndxeq.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHEET_WEBAPP_URL = process.env.SHEET_WEBAPP_URL;
const SHEET_WEBAPP_SECRET = process.env.SHEET_WEBAPP_SECRET;

async function callSheetWebApp(payload) {
  if (!SHEET_WEBAPP_URL || !SHEET_WEBAPP_SECRET) {
    throw new Error('SHEET_WEBAPP_URL / SHEET_WEBAPP_SECRET не налаштовано на сервері');
  }
  const r = await fetch(SHEET_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ secret: SHEET_WEBAPP_SECRET }, payload)),
    redirect: 'follow'
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { ok: false, raw: text.slice(0, 300) }; }
  if (!r.ok || !data.ok) {
    throw new Error('Apps Script webhook: ' + (data.message || data.error || text.slice(0, 200)));
  }
  return data;
}

// Дроп-ціни для позицій замовлення — з окремої (не anon-доступної) таблиці
// product_costs, сервісним ключем. Якщо для якоїсь позиції дроп-ціни немає
// (новий товар, ще не було в жодному sync) — сума лишається null, у таблиці
// колонка "Ціна постачальника" лишиться порожньою (як і зараз доводиться
// вписувати вручну для таких випадків), решта рядка все одно створюється.
async function lookupDropPriceTotal(items) {
  if (!SERVICE_KEY) return { total: null, missing: items.map(it => it.articul) };
  const keys = items
    .filter(it => it.articul && it.size)
    .map(it => `and(articul.eq.${encodeURIComponent(it.articul)},size.eq.${encodeURIComponent(it.size)})`);
  if (!keys.length) return { total: null, missing: items.map(it => it.articul) };

  const url = `${SUPABASE_URL}/rest/v1/product_costs?select=articul,size,drop_price&or=(${keys.join(',')})`;
  const r = await fetch(url, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  if (!r.ok) return { total: null, missing: items.map(it => it.articul) };
  const rows = await r.json();
  const priceMap = new Map(rows.map(row => [`${row.articul}__${row.size}`, Number(row.drop_price)]));

  let total = 0;
  const missing = [];
  for (const it of items) {
    const key = `${it.articul}__${it.size}`;
    if (priceMap.has(key)) {
      total += priceMap.get(key) * (it.quantity || 1);
    } else {
      missing.push(it.articul);
    }
  }
  return { total: missing.length ? null : total, missing };
}

function buildProductLabel(items) {
  return items
    .map(it => `${it.name || it.product_name || '-'} (${it.size || '-'}) x${it.quantity || 1}`)
    .join('; ');
}

async function handleCreate(body, res) {
  const { orderId, customerName, customerPhone, items, totalPrice, createdAt } = body;
  if (!orderId) { res.status(400).json({ error: 'no_order_id' }); return; }
  const safeItems = Array.isArray(items) ? items : [];

  const { total: dropPrice } = await lookupDropPriceTotal(safeItems).catch(() => ({ total: null }));

  await callSheetWebApp({
    action: 'create',
    id: orderId,
    name: customerName || '',
    phone: customerPhone || '',
    product: buildProductLabel(safeItems),
    dropPrice: dropPrice,
    price: totalPrice || 0,
    paymentStatus: 'Не оплачено',
    date: createdAt || new Date().toISOString()
  });
  res.status(200).json({ ok: true });
}

async function handleUpdate(req, body, res) {
  await requireAdmin(getToken(req));
  const { orderId, ttn, status, paymentStatus } = body;
  if (!orderId) { res.status(400).json({ error: 'no_order_id' }); return; }
  const result = await callSheetWebApp({ action: 'update', id: orderId, ttn, status, paymentStatus });
  res.status(200).json({ ok: true, result });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  try {
    let body = req.body;
    if (!body || typeof body === 'string') {
      try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
    }
    body = body || {};

    if (body.action === 'create') {
      await handleCreate(body, res);
    } else if (body.action === 'update') {
      await handleUpdate(req, body, res);
    } else {
      res.status(400).json({ error: 'unknown_action' });
    }
  } catch (err) {
    // Навмисно НЕ ламаємо оформлення замовлення чи адмінку через збій
    // синхронізації з таблицею — просто повертаємо помилку, викликач сам
    // вирішує (checkout.html — ігнорує, як і /api/notify-order).
    const status = err && err.httpStatus ? err.httpStatus : 500;
    res.status(status).json({ error: 'server_error', message: String((err && err.message) || err) });
  }
};
