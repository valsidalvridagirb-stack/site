// /api/catalog — два зовсім різні споживачі одного файлу, навмисно
// об'єднані в ОДНУ Vercel Serverless Function.
//
// Чому в одному файлі: акаунт на Vercel Hobby-плані обмежений 12
// serverless-функціями на деплой, і цей ліміт вже був вичерпаний існуючими
// ендпоінтами сайту. Розносити хмарну синхронізацію каталогу (5
// постачальників + перенесення в products) по окремих файлах, як спочатку
// зроблено, означало 6 нових функцій і зламаний білд ("No more than 12
// Serverless Functions..."). Тому вся нова логіка — це гілки одного
// диспетчера за query-параметром ?action=, а не окремі файли.
//
// 1) БЕЗ ?action (або ?action=admin) — те, чим цей файл був раніше: віддає
//    повний каталог (для пошуку по артикулу в адмінці) тільки
//    авторизованому адміну. Права підтверджуються токеном доступу
//    користувача з браузера (Authorization: Bearer <access_token>) через
//    Supabase REST з тим самим токеном — RLS-політика на profiles сама
//    гарантує, що повернеться рядок лише цього користувача.
//    ВИПРАВЛЕНО (25.08.2026): короткий час читав SQL-в'юху
//    supplier_catalog_merged напряму з Supabase замість статичного файлу —
//    здавалось логічним, бо ті дані "завжди свіжі". Але supplier_catalog
//    наповнюють ЛИШЕ хмарні крон-завдання для 4 постачальників
//    (ideasport/ultrasport/tcross/olxandery) — для 7dreamsport і
//    dropyesoriginal такого крону взагалі нема (7dreamsport за логіном,
//    dropyesoriginal за Cloudflare-блоком), тому їх там НІКОЛИ не було, і
//    адмінка помилково писала "товару більше немає в каталозі
//    постачальників" для товарів, які насправді є. Повернуто назад: читає
//    статичний закомічений у git файл api/_data/excel-catalog.json — його
//    щогодини (незалежно від Claude) оновлює скрипт local_sync_catalog.py на
//    ПК власника, з ПОВНОГО каталогу всіх 6 постачальників одразу (у нього
//    вже локально лежать фіди всіх шести — включно з 7dreamsport і
//    dropyesoriginal, для яких хмарного шляху нема).
//
// 2) ?action=ideasport|dropyesoriginal|ultrasport|tcross|olxandery&secret=...
//    — хмарна синхронізація каталогу ОДНОГО постачальника (фід -> парсинг
//    -> catalogPipeline.processRow() -> Supabase supplier_catalog). Захищено
//    CRON_SECRET (той самий, що й в api/cron-sync-ttn.js), не токеном
//    користувача. Наразі розклад (GitHub Actions) вимкнено — лишається
//    ручний запуск, дивись .github/workflows/sync-catalog.yml.
//
// 3) ?action=sync&secret=... — переносить свіжі ціни/залишки з
//    supplier_catalog_merged у products (заміна scripts/sync_catalog.py,
//    без git). Деталі — api/_lib/catalogSyncToProducts.js.
const fs = require('fs');
const path = require('path');
const { makeCatalogCronHandler } = require('./_lib/catalogCronHandler');
const {
  parseIdeasportXml, parseDropyesoriginalXml, parseUltrasportXml, parseTcrossXml, parseOlxanderyCsv,
} = require('./_lib/catalogParsers');
const syncToProductsHandler = require('./_lib/catalogSyncToProducts');

const SUPABASE_URL = 'https://jkwppbriklmxbivndxeq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprd3BwYnJpa2xteGJpdm5keGVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0OTIyMDUsImV4cCI6MjEwMTA2ODIwNX0.z1URg0dT6DsBT8nSkGvDeSrXls6bgOuU3UJBlvS-5gc';

const COLS = ['art', 'size', 'name', 'price', 'qty', 'brand', 'gender', 'cat1', 'cat2', 'cat3', 'supplier'];

// Кожен хендлер будується один раз при холодному старті функції (не на
// кожен запит) — makeCatalogCronHandler лише замикає конфіг постачальника,
// нічого мережевого при виклику не робить.
const CRON_ACTIONS = {
  ideasport: makeCatalogCronHandler({
    supplier: 'ideasport',
    url: 'https://hub.idealsport.com.ua/feeds/dropshipping/dropshipping_products-ownwarehouses-categorya.xml',
    parse: parseIdeasportXml,
    minExpectedRows: 200,
  }),
  dropyesoriginal: makeCatalogCronHandler({
    supplier: 'dropyesoriginal',
    url: 'https://drop.yesoriginal.com.ua/price/drop.xml',
    parse: parseDropyesoriginalXml,
    minExpectedRows: 100,
    // Їхній хостинг 403-ить запити з IP Vercel-датацентру навіть з повним
    // набором браузерних заголовків (з браузера власника той самий фід
    // доступний) — схоже на WAF/Cloudflare IP-reputation блок, який
    // заголовками не обійти. proxyFallback: якщо прямий запит впаде,
    // catalogCronHandler автоматично пробує повторно через публічний
    // raw-проксі (allorigins.win) — його IP може не потрапляти під той
    // самий блок-лист. Якщо й це не спрацює — у відповіді буде
    // directFetchDiag з точною причиною прямої відмови (статус,
    // сервер-заголовки, уривок тіла) для подальшої діагностики.
    fetchOptions: { headers: { Referer: 'https://drop.yesoriginal.com.ua/' } },
    proxyFallback: true,
  }),
  ultrasport: makeCatalogCronHandler({
    supplier: 'ultrasport',
    url: 'https://www.ultrasport.in.ua/content/export/096ca1b04127691f3dcc6e8927f35f63.xml',
    parse: parseUltrasportXml,
    minExpectedRows: 1000,
  }),
  tcross: makeCatalogCronHandler({
    supplier: 'tcross',
    url: 'https://tcross1.pp.ua/feed.xml',
    parse: parseTcrossXml,
    minExpectedRows: 200,
  }),
  olxandery: makeCatalogCronHandler({
    supplier: 'olxandery',
    url: 'https://docs.google.com/spreadsheets/d/1pOlj2HKFsfk3aYjrOAPjBSEikrKSh9NBmCL31FSRrFE/export?format=csv&gid=0',
    parse: parseOlxanderyCsv,
    minExpectedRows: 100,
  }),
  sync: syncToProductsHandler,
};

async function handleAdminCatalog(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    res.status(401).json({ error: 'no_token' });
    return;
  }

  const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=is_admin`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!profRes.ok) {
    res.status(401).json({ error: 'invalid_session' });
    return;
  }

  const rows = await profRes.json();
  if (!Array.isArray(rows) || !rows.length || !rows[0].is_admin) {
    res.status(403).json({ error: 'not_admin' });
    return;
  }

  // Статичний файл, закомічений у git — щогодини перезаписує
  // local_sync_catalog.py на ПК власника (Windows Планувальник завдань,
  // без Claude), з ПОВНОГО каталогу всіх 6 постачальників. Формат
  // {cols, rows} уже точно такий, який чекає admin.html — просто віддаємо
  // його як є, без переформатування.
  let raw;
  try {
    raw = fs.readFileSync(path.join(__dirname, '_data', 'excel-catalog.json'), 'utf8');
  } catch (err) {
    res.status(500).json({ error: 'catalog_file_missing', message: String((err && err.message) || err) });
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).send(raw);
}

module.exports = async (req, res) => {
  try {
    const reqUrl = new URL(req.url, 'http://internal');
    const action = reqUrl.searchParams.get('action');

    if (action && CRON_ACTIONS[action]) {
      await CRON_ACTIONS[action](req, res);
      return;
    }
    if (action && action !== 'admin') {
      res.status(400).json({ error: 'unknown_action', action });
      return;
    }

    await handleAdminCatalog(req, res);
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String((err && err.message) || err) });
  }
};
