// Надсилає повідомлення в Telegram адміну про нове замовлення.
// Викликається з checkout.html одразу після успішного створення замовлення.
// Якщо Telegram не налаштовано або сталася помилка — це НЕ ламає оформлення
// замовлення клієнтом, просто сповіщення не прийде.
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  try {
    if (!BOT_TOKEN || !CHAT_ID) {
      res.status(200).json({ ok: false, error: 'not_configured' });
      return;
    }

    let body = req.body;
    if (!body || typeof body === 'string') {
      try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
    }
    body = body || {};

    const { orderId, customerName, customerPhone, city, novaPoshtaDept, comment, totalPrice, items } = body;
    if (!orderId) {
      res.status(400).json({ error: 'no_order_id' });
      return;
    }

    const itemsList = Array.isArray(items) && items.length
      ? items.map((it) => `• ${it.name || ''} (${it.size || '-'}) x${it.quantity || 1} — ${it.price || 0} грн`).join('\n')
      : '';

    const lines = [
      `🛒 Нове замовлення №${orderId}`,
      `👤 ${customerName || '-'}`,
      `📞 ${customerPhone || '-'}`,
      `📍 ${city || '-'}, ${novaPoshtaDept || '-'}`
    ];
    if (itemsList) lines.push('', itemsList);
    if (comment) lines.push('', `💬 Коментар: ${comment}`);
    lines.push('', `💰 Разом: ${totalPrice || 0} грн`);
    const text = lines.join('\n');

    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text })
    });
    const data = await r.json().catch(() => ({}));
    if (!data || !data.ok) {
      res.status(200).json({ ok: false, error: (data && data.description) || 'telegram_error' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String((err && err.message) || err) });
  }
};
