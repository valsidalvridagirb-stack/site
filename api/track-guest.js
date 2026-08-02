// Публічна перевірка замовлення за номером + телефоном (для гостьових замовлень,
// без входу в акаунт). Доступ до конкретного замовлення підтверджується збігом
// телефону на рівні Postgres-функції (SECURITY DEFINER get_order_status /
// update_order_ttn_status) — сюди не потрібен ані токен користувача, ані
// сервісний ключ Supabase.
const SUPABASE_URL = 'https://jkwppbriklmxbivndxeq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprd3BwYnJpa2xteGJpdm5keGVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0OTIyMDUsImV4cCI6MjEwMTA2ODIwNX0.z1URg0dT6DsBT8nSkGvDeSrXls6bgOuU3UJBlvS-5gc';
const CACHE_MS = 20 * 60 * 1000;

const { npCall } = require('./_lib/np');

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
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`rpc ${name} -> ${r.status}: ${text}`);
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://internal');
    const orderId = Number(url.searchParams.get('orderId'));
    const phone = (url.searchParams.get('phone') || '').trim();

    if (!orderId || !phone) {
      res.status(400).json({ error: 'missing_params' });
      return;
    }

    const order = await rpc('get_order_status', { p_order_id: orderId, p_phone: phone });
    if (!order) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    if (order.ttn) {
      const isFresh = order.ttn_status_updated_at &&
        (Date.now() - new Date(order.ttn_status_updated_at).getTime() < CACHE_MS);
      if (!isFresh) {
        try {
          const data = await npCall('TrackingDocument', 'getStatusDocuments', {
            Documents: [{ DocumentNumber: order.ttn, Phone: phone }]
          });
          if (data && data.length && data[0].Status) {
            order.ttn_status = data[0].Status;
            await rpc('update_order_ttn_status', { p_order_id: orderId, p_phone: phone, p_status: order.ttn_status }).catch(() => {});
          }
        } catch (npErr) {
          // Нова пошта тимчасово недоступна — віддаємо останній відомий статус
        }
      }
    }

    res.status(200).json({ ok: true, order });
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String((err && err.message) || err) });
  }
};
