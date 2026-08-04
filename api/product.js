// Єдина точка входу для сторінки товару (/product?articul=...).
//
// Чому не просто статичний файл: боти соцмереж (Instagram/Telegram/Facebook/
// Twitter тощо) НЕ виконують JavaScript, коли розгортають прев'ю посилання —
// вони роблять один запит і зчитують <meta property="og:*"> з відповіді. А
// звичайна сторінка товару підвантажує назву/фото/ціну через JS вже ПІСЛЯ
// завантаження, тому такий бот бачить порожню сторінку і показує голе
// посилання без фото й ціни.
//
// Раніше бот-детект жив у vercel.json через умову "has" на заголовок
// user-agent — але на практиці Telegram (перевірено через @WebpageBot,
// примусове оновлення прев'ю) продовжував бачити старий/загальний варіант,
// тобто ця умова ненадійно спрацьовує на рівні Vercel routing. Тому детект
// бота перенесено сюди, у звичайний JS-код, де все прозоро й тестовано:
//   - якщо User-Agent належить відомому боту соцмережі — віддаємо HTML з
//     og-тегами конкретного товару (фото/назва/ціна з бази);
//   - інакше — віддаємо звичайну SPA-сторінку товару (product-page.html,
//     вшита у функцію через "includeFiles" в vercel.json) без жодних змін,
//     так само, як якби Vercel віддав статичний файл напряму.
//
// vercel.json робить ОДИН безумовний rewrite: /product -> /api/product.
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://jkwppbriklmxbivndxeq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprd3BwYnJpa2xteGJpdm5keGVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0OTIyMDUsImV4cCI6MjEwMTA2ODIwNX0.z1URg0dT6DsBT8nSkGvDeSrXls6bgOuU3UJBlvS-5gc';

const SITE_URL = 'https://nexxtlevel.store';
const FALLBACK_IMAGE = `${SITE_URL}/assets/logo.jpg`;

// Список за User-Agent відомих ботів соцмереж/месенджерів, які розгортають
// прев'ю посилань (не пошукові індексатори — тим окремо не заважаємо).
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

async function renderBotPreview(url, debug) {
  const articul = url.searchParams.get('articul');
  const name = url.searchParams.get('name');

  let product = null;
  if (articul || name) {
    const filterField = articul ? 'articul' : 'name';
    const filterVal = articul || name;
    const fetchUrl = `${SUPABASE_URL}/rest/v1/products?select=name,price,photos,description,articul&${filterField}=eq.${encodeURIComponent(filterVal)}&order=price.asc&limit=1`;
    try {
      const r = await fetch(fetchUrl, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
      });
      const bodyText = await r.text();
      if (debug) {
        debug.supabaseStatus = r.status;
        debug.supabaseBody = bodyText.slice(0, 500);
        debug.fetchUrl = fetchUrl;
      }
      if (r.ok) {
        const rows = JSON.parse(bodyText);
        if (Array.isArray(rows) && rows.length) product = rows[0];
      }
    } catch (e) {
      if (debug) debug.supabaseError = String(e && e.message || e);
    }
  }

  const pageUrl = `${SITE_URL}/product${url.search}`;
  // ВАЖЛИВО: посилання/редирект у самій прев'ю-сторінці веде НЕ на /product
  // (той самий "розумний" ендпоінт, що міг би знову класифікувати запит як
  // бота і зациклити), а напряму на статичний файл сторінки товару в обхід
  // будь-якої бот-детекції — так реальний відвідувач гарантовано не застрягне
  // на цій голій прев'ю-сторінці, навіть якщо його випадково визнали ботом.
  const humanUrl = `${SITE_URL}/product-page${url.search}`;
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

// ТИМЧАСОВЕ діагностичне логування: щоб з'ясувати, чому реальний краулер
// Telegram (@WebpageBot) продовжує бачити загальну заглушку — записуємо в
// окрему таблицю debug_ua_log, який саме User-Agent і заголовки приходять на
// кожен запит /product, і як ми його класифікували. Можна прибрати пізніше.
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
async function logDebugUa(pathname, ua, headers, isBot, extra) {
  if (!SERVICE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/debug_ua_log`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ path: pathname, ua, headers: Object.assign({}, headers, extra ? { __debug: extra } : {}), is_bot: isBot })
    });
  } catch (e) {
    // діагностика не повинна ламати реальний запит
  }
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://internal');
    const ua = req.headers['user-agent'] || '';
    // debugforcebot=1 — тимчасовий параметр лише для діагностики (без
    // подвійного підкреслення на початку: з'ясувалось, що Vercel вирізає
    // параметри виду __xxx ще до того, як запит долітає до функції).
    const isBot = BOT_UA_RE.test(ua) || url.searchParams.get('debugforcebot') === '1';

    if (isBot) {
      const debug = {};
      const html = await renderBotPreview(url, debug);
      await logDebugUa(url.pathname + url.search, ua, req.headers, isBot, debug);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // НІКОЛИ не кешувати публічно (на CDN/shared-кеші): один URL віддає РІЗНИЙ
      // HTML залежно від User-Agent, а публічний кеш (Cache-Control: public/
      // s-maxage) не розрізняє, хто питав, і роздав би цю "заглушку для бота"
      // усім наступним відвідувачам того самого товару протягом TTL. Саме це
      // й трапилось: після одного запиту від @WebpageBot цю сторінку якийсь
      // час бачив і звичайний браузер.
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).send(html);
      return;
    }

    await logDebugUa(url.pathname + url.search, ua, req.headers, isBot);

    // Звичайний відвідувач — віддаємо ту саму сторінку товару, що й раніше
    // лежала прямо на диску як product.html, без жодних змін.
    const filePath = path.join(__dirname, '..', 'product-page.html');
    const html = fs.readFileSync(filePath, 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Server error: ' + String(err && err.message || err));
  }
};
