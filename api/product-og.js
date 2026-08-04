// Прев'ю товару для соцмереж (Instagram/Telegram/Facebook/Twitter тощо).
//
// Коли хтось кидає посилання на товар у чат чи сторіс, ці сервіси НЕ виконують
// JavaScript — вони роблять один запит і зчитують <meta property="og:*"> з
// відповіді. А product.html підвантажує дані про товар (фото, назву, ціну)
// через JS вже ПІСЛЯ завантаження сторінки, тому такий краулер бачить порожню
// сторінку без потрібних тегів і показує голе посилання.
//
// vercel.json переписує запит сюди ТІЛЬКИ якщо User-Agent належить відомому
// боту соцмережі (правило "has" на заголовок user-agent) — для звичайних
// відвідувачів сайту цей файл взагалі не викликається, вони, як і раніше,
// отримують оригінальний product.html без жодних змін і без затримки.
const SUPABASE_URL = 'https://jkwppbriklmxbivndxeq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprd3BwYnJpa2xteGJpdm5keGVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0OTIyMDUsImV4cCI6MjEwMTA2ODIwNX0.z1URg0dT6DsBT8nSkGvDeSrXls6bgOuU3UJBlvS-5gc';

const SITE_URL = 'https://nexxtlevel.store';
const FALLBACK_IMAGE = `${SITE_URL}/assets/logo.jpg`;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cleanImageUrl(raw) {
  let clean = raw.trim();
  if (clean.startsWith('http://')) clean = clean.replace('http://', 'https://');
  else if (clean.startsWith('//')) clean = 'https:' + clean;
  return clean;
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://internal');
    const articul = url.searchParams.get('articul');
    const name = url.searchParams.get('name');

    let product = null;
    if (articul || name) {
      const filterField = articul ? 'articul' : 'name';
      const filterVal = articul || name;
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/products?select=name,price,photos,description,articul&${filterField}=eq.${encodeURIComponent(filterVal)}&order=price.asc&limit=1`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
      );
      if (r.ok) {
        const rows = await r.json();
        if (Array.isArray(rows) && rows.length) product = rows[0];
      }
    }

    const pageUrl = `${SITE_URL}/product.html${url.search}`;
    const title = product && product.name ? `${product.name} — NEXXTLEVEL STORE` : 'NEXXTLEVEL STORE';
    const priceNum = product && product.price != null && product.price !== '' ? Number(product.price) : null;

    let description = 'Оригінальні кросівки та одяг з США та Європи.';
    if (product) {
      const desc = (product.description || '').replace(/\s+/g, ' ').trim();
      const priceLine = priceNum ? `${priceNum} грн.` : '';
      description = [priceLine, desc].filter(Boolean).join(' ').slice(0, 200).trim() || description;
    }

    let image = FALLBACK_IMAGE;
    if (product && product.photos) {
      const first = String(product.photos)
        .split(/[;,]/)
        .map(p => p.trim())
        .filter(Boolean)[0];
      if (first) image = cleanImageUrl(first);
    }

    const html = `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<meta property="og:type" content="product">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:site_name" content="NEXXTLEVEL STORE">
${priceNum ? `<meta property="product:price:amount" content="${priceNum}">
<meta property="product:price:currency" content="UAH">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<meta http-equiv="refresh" content="0; url=${esc(pageUrl)}">
</head>
<body>
<p>${esc(title)}</p>
<p><a href="${esc(pageUrl)}">Перейти до товару на NEXXTLEVEL STORE</a></p>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Error generating preview');
  }
};
