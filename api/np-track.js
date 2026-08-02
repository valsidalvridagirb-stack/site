// Повертає ТТН і статус доставки для замовлення. RLS сама вирішує, хто що бачить:
// клієнт бачить лише свої замовлення, адмін — усі (ті ж політики, що і на сайті).
const { npCall, supaFetch, getToken } = require('./_lib/np');

const CACHE_MS = 20 * 60 * 1000; // 20 хвилин — не смикаємо Нову пошту на кожен рендер

module.exports = async (req, res) => {
  const token = getToken(req);
  try {
    if (!token) {
      res.status(401).json({ error: 'no_token' });
      return;
    }
    const url = new URL(req.url, 'http://internal');
    const orderId = url.searchParams.get('orderId');
    if (!orderId) {
      res.status(400).json({ error: 'no_order_id' });
      return;
    }

    const orders = await supaFetch(
      `orders?id=eq.${encodeURIComponent(orderId)}&select=ttn,ttn_status,ttn_status_updated_at,customer_phone`,
      token
    );
    // RLS: якщо це не ваше замовлення і ви не адмін, тут просто прийде порожній масив
    if (!orders || !orders.length) {
      res.status(404).json({ error: 'order_not_found' });
      return;
    }
    const order = orders[0];
    if (!order.ttn) {
      res.status(200).json({ ttn: null, status: null });
      return;
    }

    const isFresh = order.ttn_status_updated_at &&
      (Date.now() - new Date(order.ttn_status_updated_at).getTime() < CACHE_MS);
    if (isFresh) {
      res.status(200).json({ ttn: order.ttn, status: order.ttn_status || null });
      return;
    }

    let statusText = order.ttn_status || null;
    try {
      const data = await npCall('TrackingDocument', 'getStatusDocuments', {
        Documents: [{ DocumentNumber: order.ttn, Phone: order.customer_phone || '' }]
      });
      if (data && data.length && data[0].Status) statusText = data[0].Status;
    } catch (npErr) {
      // якщо Нова пошта тимчасово недоступна — віддаємо останній відомий статус, не падаємо
    }

    supaFetch(`orders?id=eq.${encodeURIComponent(orderId)}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ ttn_status: statusText, ttn_status_updated_at: new Date().toISOString() })
    }).catch(() => {});

    res.status(200).json({ ttn: order.ttn, status: statusText });
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String(err && err.message || err) });
  }
};
