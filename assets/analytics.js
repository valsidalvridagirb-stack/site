// NexxtLevel Store — Meta Pixel + GA4 event helpers.
// Base Pixel/gtag loader is inlined in each page's <head>.
// These wrappers fire matching events to both platforms and never throw
// (a tracking failure must never break the shop UI).

function trackViewContent(product) {
  try {
    const id = product.articul || String(product.id || '');
    const price = Number(product.price) || 0;
    if (window.fbq) {
      fbq('track', 'ViewContent', {
        content_name: product.name,
        content_ids: [id],
        content_type: 'product',
        value: price,
        currency: 'UAH'
      });
    }
    if (window.gtag) {
      gtag('event', 'view_item', {
        currency: 'UAH',
        value: price,
        items: [{ item_id: id, item_name: product.name, price: price }]
      });
    }
  } catch (e) { /* tracking must never break the page */ }
}

function trackAddToCart(item) {
  try {
    const id = item.articul || '';
    const price = Number(item.price) || 0;
    const qty = item.quantity || 1;
    if (window.fbq) {
      fbq('track', 'AddToCart', {
        content_name: item.name,
        content_ids: [id],
        content_type: 'product',
        value: price,
        currency: 'UAH'
      });
    }
    if (window.gtag) {
      gtag('event', 'add_to_cart', {
        currency: 'UAH',
        value: price,
        items: [{ item_id: id, item_name: item.name, price: price, quantity: qty }]
      });
    }
  } catch (e) { /* tracking must never break the page */ }
}

function trackInitiateCheckout(items, total) {
  try {
    const contentIds = items.map(i => i.articul || '');
    const value = Number(total) || 0;
    if (window.fbq) {
      fbq('track', 'InitiateCheckout', {
        content_ids: contentIds,
        content_type: 'product',
        value: value,
        currency: 'UAH',
        num_items: items.length
      });
    }
    if (window.gtag) {
      gtag('event', 'begin_checkout', {
        currency: 'UAH',
        value: value,
        items: items.map(i => ({ item_id: i.articul || '', item_name: i.name, price: Number(i.price) || 0, quantity: i.quantity || 1 }))
      });
    }
  } catch (e) { /* tracking must never break the page */ }
}

function trackPurchase(orderId, items, total) {
  try {
    const contentIds = items.map(i => i.articul || '');
    const value = Number(total) || 0;
    if (window.fbq) {
      fbq('track', 'Purchase', {
        content_ids: contentIds,
        content_type: 'product',
        value: value,
        currency: 'UAH',
        num_items: items.length
      });
    }
    if (window.gtag) {
      gtag('event', 'purchase', {
        transaction_id: String(orderId),
        currency: 'UAH',
        value: value,
        items: items.map(i => ({ item_id: i.articul || '', item_name: i.name, price: Number(i.price) || 0, quantity: i.quantity || 1 }))
      });
    }
  } catch (e) { /* tracking must never break the page */ }
}
