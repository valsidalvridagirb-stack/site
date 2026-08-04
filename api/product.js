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
//     вшита у функцію через "includeFiles" в vercel.json) без жодних змін,
//     так само, як якби Vercel віддав статичний файл напряму.
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

async function renderBotPreview(url) {
  const articul = url.searchParams.get('articul');
  const name = url.searchParams.get('name');

  let product = null;
  if (articul || name) {
    const filterField = articul ? 'articul' : 'name';
    const filterVal = articul || name;
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/products?select=name,price,photos,description,articul&${filterField}=eq.${encodeURIComponent(filterVal)}&order=price.asc&limit=1`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
      );
      if (r.ok) {
        const rows = await r.json();
        if (Array.isArray(rows) && rows.length) product = rows[0];
      }
    } catch (e) {
      // якщо база недоступна — просто покажемо загальний варіант нижче
    }
  }

  const pageUrl = `${SITE_URL}/product${url.search}`;
  // Посилання/редирект у самій прев'ю-сторінці веде НЕ на /product (той самий
  // "розумний" ендпоінт), а напряму на статичний файл сторінки товару в обхід
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

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
async function logDebugUa(pathname, ua, isBot, headers, extra) {
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
      body: JSON.stringify({
        path: pathname,
        ua,
        is_bot: isBot,
        headers: {
          host: headers['host'],
          xForwardedHost: headers['x-forwarded-host'],
          xVercelId: headers['x-vercel-id'],
          rewriteCaching: headers['x-vercel-enable-rewrite-caching'],
          debug: extra || null
        }
      })
    });
  } catch (e) {
    // діагностика не повинна ламати реальний запит
  }
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://internal');
    const ua = req.headers['user-agent'] || '';
    const isBot = BOT_UA_RE.test(ua);

    if (isBot) {
      const html = await renderBotPreview(url);
      await logDebugUa(url.pathname + url.search, ua, isBot, req.headers, {
        responseSnippet: html.slice(0, 500)
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).send(html);
      return;
    }

    await logDebugUa(url.pathname + url.search, ua, isBot, req.headers);

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
