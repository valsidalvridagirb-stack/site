// Єдина точка входу для сторінки товару (/product?articul=...).
//
// Чому не просто статичний файл: боти соцмереж (Instagram/Telegram/Facebook/
// Twitter тощо) НЕ виконують JavaScript, коли розгортають прев'ю посилання —
// вони роблять один запит і зчитують <meta property="og:*"> з відповіді. А
// звичайна сторінка товару підвантажує назву/фото/ціну через JS вже ПІСЛЯ
// завантаження, тому такий бот бачить порожню сторінку і показує голе
// посилання без фото й ціни.
//
// Детект бота — прямо тут, у звичайному JS-коді (не через "has"-умову в
// vercel.json, яка на практиці ненадійна для same-app rewrite):
//   - якщо User-Agent належить відомому боту соцмережі — віддаємо HTML з
//     og-тегами конкретного товару (фото/назва/ціна з бази);
//   - інакше — віддаємо звичайну SPA-сторінку товару (product-page.html,
//     вшита у функцію через "includeFiles" в vercel.json), АЛЕ з уже
//     підставленими на сервері <title>/description/canonical/og-тегами й
//     JSON-LD для КОНКРЕТНОГО товару (див. injectSeoIntoPage нижче).
//
// ВАЖЛИВО (причина, чому товари майже не індексувались Google): реальний
// Googlebot НЕ входив у список BOT_UA_RE нижче (там був лише
// "Google-InspectionTool" — це інструмент перевірки URL у Search Console,
// а не сам краулер). Тобто Googlebot потрапляв у гілку "звичайний
// відвідувач" і отримував product-page.html БЕЗ жодних правок — з
// однаковими для ВСІХ товарів <title>Товар — NEXXTLEVEL STORE</title>,
// однаковим description і, найгірше, статичним
// <link rel="canonical" href="https://nexxtlevel.store/product"> (без
// ?articul=...) для кожної товарної сторінки. Для Google це виглядало як
// ~100 дублікатів однієї й тієї ж сторінки, тому переважна більшість була
// позначена в Search Console як "Discovered — currently not indexed"
// замість реальної індексації. Раніше в коді малось на увазі, що Google
// виконає JS і сам виправить ці теги при рендері — але рішення "рендерити
// сторінку чи ні" Google приймає ще ДО рендеру, на основі сирого HTML, тож
// цей розрахунок на практиці не спрацьовував.
//
// Фікс: тепер і "звичайний відвідувач" (а отже і Googlebot/Bingbot/будь-
// який інший краулер, що НЕ входить у BOT_UA_RE) отримує ту саму повну
// product-page.html, але з уже підставленими на сервері правильними тегами
// для конкретного товару — без залежності від виконання JS. Живі
// відвідувачі нічого не помітять: клієнтський updateProductSeoTags() все
// одно виконається при завантаженні й ще раз (уже точніше, з урахуванням
// розмірів/наявності) оновить ці самі теги.
//
// vercel.json робить ОДИН безумовний rewrite: /product -> /api/product, і
// явно вимикає edge-кешування rewrite-відповідей (x-vercel-enable-rewrite-
// caching: 0) — без цього Vercel кешував першу віддану відповідь на URL і
// роздавав ЇЇ ЖЕ всім наступним відвідувачам того самого товару, незалежно
// від їхнього User-Agent. Перевірено напряму на реальному запиті від
// Telegram (User-Agent "TelegramBot (like TwitterBot)") — сервер віддає
// правильні og-теги з фото, назвою і ціною товару.
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://jkwppbriklmxbivndxeq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprd3BwYnJpa2xteGJpdm5keGVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0OTIyMDUsImV4cCI6MjEwMTA2ODIwNX0.z1URg0dT6DsBT8nSkGvDeSrXls6bgOuU3UJBlvS-5gc';

const SITE_URL = 'https://nexxtlevel.store';
const FALLBACK_IMAGE = `${SITE_URL}/assets/logo.jpg`;

// Список за User-Agent відомих ботів соцмереж/месенджерів, які розгортають
// прев'ю посилань (не пошукові індексатори — тим окремо не заважаємо, вони
// й так тепер отримують правильні теги через injectSeoIntoPage нижче).
const BOT_UA_RE = /facebookexternalhit|Facebot|Twitterbot|TelegramBot|WhatsApp|LinkedInBot|Slackbot|Discordbot|Pinterest|vkShare|Viber|SkypeUriPreview|Google-InspectionTool|redditbot/i;

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

// Один товар (articul) у таблиці products лежить окремим рядком на кожен
// розмір — тож забираємо ВСІ рядки з цим артикулом, а не перший-ліпший:
// це дає коректну мін. ціну серед наявних розмірів і реальну наявність.
async function fetchProductRows(filterField, filterVal) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/products?select=name,price,photos,description,articul,brand,quantity&${filterField}=eq.${encodeURIComponent(filterVal)}&order=price.asc`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
  );
  if (!r.ok) return [];
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

function aggregateProduct(rows) {
  if (!rows.length) return null;
  const first = rows[0];
  const inStockRows = rows.filter(r => Number(r.quantity) > 0);
  const priceSource = inStockRows.length ? inStockRows : rows;
  const price = Math.min(...priceSource.map(r => Number(r.price)).filter(n => !Number.isNaN(n)));
  return {
    name: first.name,
    brand: first.brand,
    description: first.description,
    photos: first.photos,
    articul: first.articul,
    price: Number.isFinite(price) ? price : null,
    inStock: inStockRows.length > 0
  };
}

async function lookupProduct(url) {
  const articul = url.searchParams.get('articul');
  const name = url.searchParams.get('name');
  if (!articul && !name) return null;
  const filterField = articul ? 'articul' : 'name';
  const filterVal = articul || name;
  try {
    const rows = await fetchProductRows(filterField, filterVal);
    return aggregateProduct(rows);
  } catch (e) {
    // якщо база недоступна — повертаємо null, виклики нижче впадуть у fallback
    return null;
  }
}

function firstPhoto(photos) {
  if (!photos) return null;
  const first = String(photos)
    .split(/[;,]/)
    .map(p => p.trim())
    .filter(Boolean)[0];
  return first ? cleanImageUrl(first) : null;
}

// Готує спільний набір SEO-полів (title/description/canonical/image) для
// конкретного товару — використовується і прев'ю для соцботів, і вставкою
// тегів у повну сторінку нижче, щоб обидва шляхи давали однакові дані.
function buildSeoFields(product, url) {
  const title = product && product.name ? `${product.name} — NEXXTLEVEL STORE` : 'NEXXTLEVEL STORE';
  const priceNum = product && product.price != null ? Number(product.price) : null;

  let description = 'Оригінальні кросівки та одяг з США та Європи. Дивіться фото, ціну та наявні розміри.';
  if (product) {
    const desc = (product.description || '').replace(/\s+/g, ' ').trim();
    const priceLine = priceNum ? `${Math.round(priceNum)} грн.` : '';
    description = [priceLine, desc].filter(Boolean).join(' ').slice(0, 200).trim() || description;
  }

  const articul = product && product.articul;
  const canonicalUrl = articul
    ? `${SITE_URL}/product?articul=${encodeURIComponent(articul)}`
    : `${SITE_URL}/product`;

  const image = (product && firstPhoto(product.photos)) || FALLBACK_IMAGE;

  return { title, description, priceNum, canonicalUrl, image };
}

async function renderBotPreview(url, product) {
  const pageUrl = `${SITE_URL}/product${url.search}`;
  // Посилання/редирект у самій прев'ю-сторінці веде НЕ на /product (той самий
  // "розумний" ендпоінт), а напряму на статичний файл сторінки товару в обхід
  // будь-якої бот-детекції — так реальний відвідувач гарантовано не застрягне
  // на цій голій прев'ю-сторінці, навіть якщо його випадково визнали ботом.
  const humanUrl = `${SITE_URL}/product-page${url.search}`;
  const { title, description, priceNum, image } = buildSeoFields(product, url);

  return `<!DOCTYPE html>
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
<meta http-equiv="refresh" content="0; url=${esc(humanUrl)}">
</head>
<body>
<p>${esc(title)}</p>
<p><a href="${esc(humanUrl)}">Перейти до товару на NEXXTLEVEL STORE</a></p>
</body>
</html>`;
}

// Вставляє в СИРУ (ще не виконану JS-ом) product-page.html правильні
// <title>/description/canonical/og-теги й JSON-LD Product/Offer конкретного
// товару — саме цього не вистачало Googlebot'у. Всі заміни — точні збіги
// рядків, які зараз статично прописані в product-page.html; якщо розмітку
// колись змінять і рядок не знайдеться, replace() просто нічого не зробить
// (безпечний фолбек), сторінка не зламається.
function injectSeoIntoPage(html, product, url) {
  if (!product) return html;

  const { title, description, canonicalUrl, image } = buildSeoFields(product, url);

  let out = html;
  out = out.replace(
    '<title>Товар — NEXXTLEVEL STORE</title>',
    `<title>${esc(title)}</title>`
  );
  out = out.replace(
    '<meta name="description" content="Оригінальні кросівки та одяг з США та Європи. Дивіться фото, ціну та наявні розміри.">',
    `<meta name="description" content="${esc(description)}">`
  );
  out = out.replace(
    '<link rel="canonical" href="https://nexxtlevel.store/product" id="canonicalLink">',
    `<link rel="canonical" href="${esc(canonicalUrl)}" id="canonicalLink">`
  );
  out = out.replace(
    '<meta property="og:title" content="NEXXTLEVEL STORE">',
    `<meta property="og:title" content="${esc(title)}">`
  );
  out = out.replace(
    '<meta property="og:description" content="Оригінальні кросівки та одяг з США та Європи.">',
    `<meta property="og:description" content="${esc(description)}">`
  );
  out = out.replace(
    '<meta property="og:image" content="https://nexxtlevel.store/assets/logo.jpg">',
    `<meta property="og:image" content="${esc(image)}">`
  );

  const jsonLd = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: title.replace(/ — NEXXTLEVEL STORE$/, ''),
    image: [image],
    description: description,
    sku: product.articul || undefined,
    brand: product.brand ? { '@type': 'Brand', name: product.brand } : undefined,
    offers: {
      '@type': 'Offer',
      url: canonicalUrl,
      priceCurrency: 'UAH',
      price: product.price != null ? Number(product.price).toFixed(2) : undefined,
      availability: product.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition'
    }
  };

  // Додаємо og:url (його не було в статичній розмітці взагалі) і JSON-LD
  // одразу після twitter:card — клієнтський JS далі знайде productJsonLd за
  // id і за потреби перезапише точнішими даними (розміри/наявність), тож
  // дублювання не буде.
  out = out.replace(
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:card" content="summary_large_image">
<meta property="og:url" content="${esc(canonicalUrl)}">
<script type="application/ld+json" id="productJsonLd">${JSON.stringify(jsonLd)}</script>`
  );

  return out;
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://internal');
    const ua = req.headers['user-agent'] || '';
    const isBot = BOT_UA_RE.test(ua);

    const product = await lookupProduct(url);

    if (isBot) {
      const html = await renderBotPreview(url, product);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).send(html);
      return;
    }

    // Звичайний відвідувач (і, найважливіше, реальний Googlebot/Bingbot/
    // будь-який краулер, що не входить у BOT_UA_RE вище) — та сама сторінка
    // товару, що раніше лежала прямо на диску як product.html, але вже з
    // підставленими для цього конкретного товару SEO-тегами (якщо товар
    // знайдено; інакше — без змін, як і раніше).
    const filePath = path.join(__dirname, '..', 'product-page.html');
    let html = fs.readFileSync(filePath, 'utf8');
    try {
      html = injectSeoIntoPage(html, product, url);
    } catch (e) {
      // Будь-яка помилка вставки тегів не повинна ламати сторінку для
      // живого відвідувача — просто віддаємо оригінал.
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Server error: ' + String(err && err.message || err));
  }
};
