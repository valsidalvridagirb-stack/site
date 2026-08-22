// Фонове (без участі клієнта чи адміна) оновлення статусів доставки Нової пошти.
// Викликається періодично зовнішнім планувальником (не Vercel Cron — його тут немає,
// запит шле scheduled task) на /api/cron-sync-ttn?secret=...
//
// На відміну від /api/np-track.js (який працює під токеном конкретного користувача
// і бачить лише його замовлення через RLS), цей ендпоінт має пройтися по ВСІХ активних
// замовленнях одразу, тому працює під сервісним ключем Supabase (обходить RLS).
// Ключ бере з process.env.SUPABASE_SERVICE_ROLE_KEY — ніколи не потрапляє в браузер,
// живе лише тут, на сервері.
const { npCall } = require('./_lib/np');

const SUPABASE_URL = 'https://jkwppbriklmxbivndxeq.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const SHEET_WEBAPP_URL = process.env.SHEET_WEBAPP_URL;
const SHEET_WEBAPP_SECRET = process.env.SHEET_WEBAPP_SECRET;

// Статус ТТН змінюється тут повністю автоматично (без адміна) — тож і рядок
// CRM-таблиці підтягуємо напряму, сервер-сервер, без /api/sheet-sync (той
// вимагає admin-токен, якого в цьому крон-джобі просто немає). Якщо таблиця
// не налаштована (немає env) — просто пропускаємо, це не критична дія.
async function syncStatusToSheet(orderId, status) {
  if (!SHEET_WEBAPP_URL || !SHEET_WEBAPP_SECRET) return;
  try {
    await fetch(SHEET_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SHEET_WEBAPP_SECRET, action: 'update', id: orderId, status })
    });
  } catch (e) {
    // не критично — рядок в таблиці просто не оновиться цього разу,
    // наступний прогін крона спробує ще раз
  }
}

// Не тягнемо статус для замовлень старших за це — щоб список активних замовлень
// не ріс нескінченно з часом (Нова пошта однаково не змінить статус давно виданої посилки).
const MAX_AGE_DAYS = 30;

async function supaService(path, opts) {
  opts = opts || {};
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    body: opts.body,
    headers: Object.assign(
      {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      opts.method && opts.method !== 'GET' ? { Prefer: 'return=minimal' } : {},
      opts.headers || {}
    )
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Supabase ${path} -> ${r.status}: ${text}`);
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://internal');
    const secret = url.searchParams.get('secret');
    if (!CRON_SECRET || secret !== CRON_SECRET) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!SERVICE_KEY) {
      res.status(500).json({ error: 'no_service_key', message: 'SUPABASE_SERVICE_ROLE_KEY не налаштовано на сервері' });
      return;
    }

    const since = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const orders = await supaService(
      `orders?select=id,ttn,ttn_status,customer_phone&ttn=not.is.null&created_at=gte.${encodeURIComponent(since)}`
    );

    let checked = 0;
    let updated = 0;
    const errors = [];

    for (const order of orders || []) {
      checked++;
      try {
        const data = await npCall('TrackingDocument', 'getStatusDocuments', {
          Documents: [{ DocumentNumber: order.ttn, Phone: order.customer_phone || '' }]
        });
        const newStatus = data && data.length && data[0].Status ? data[0].Status : null;
        if (newStatus && newStatus !== order.ttn_status) {
          await supaService(`orders?id=eq.${order.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ ttn_status: newStatus, ttn_status_updated_at: new Date().toISOString() })
          });
          await syncStatusToSheet(order.id, newStatus);
          updated++;
        } else if (newStatus) {
          // статус не змінився — все одно фіксуємо час перевірки
          await supaService(`orders?id=eq.${order.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ ttn_status_updated_at: new Date().toISOString() })
          });
        }
      } catch (err) {
        errors.push({ orderId: order.id, message: String(err && err.message || err) });
      }
    }

    res.status(200).json({ ok: true, checked, updated, errors });
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String(err && err.message || err) });
  }
};
