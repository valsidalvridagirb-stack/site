// "Жива" XML-вигрузка каталогу (формат YML, який приймає Prom.ua та більшість
// українських маркетплейсів) — /feed.xml (rewrite у vercel.json на цю функцію).
//
// Ключова ідея: файл НІКОЛИ не зберігається і не генерується заздалегідь —
// при кожному зверненні (Prom.ua сам періодично заходить за цією адресою)
// функція читає АКТУАЛЬНИЙ стан таблиці products напряму з Supabase. Тобто
// щойно local_sync_catalog.py оновить ціни/залишки від постачальників, наступний
// заход Prom.ua за цією ж адресою вже поверне свіжі дані — нічого вручну
// перезаливати не треба.
//
// У вигрузку потрапляють лише розміри з quantity > 0 (той самий фільтр, що й
// у product_summary — view, з якої каталог сайту будує сітку товарів), тому
// склад товарів у фіді завжди відповідає тому, що реально видно на сайті.
// Порядок фото — рядок products.photos, як він є (кроскодним split(';')),
// це той самий рядок і той самий порядок, що на сторінці товару.
const SUPABASE_URL = 'https://jkwppbriklmxbivndxeq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprd3BwYnJpa2xteGJpdm5keGVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0OTIyMDUsImV4cCI6MjEwMTA2ODIwNX0.z1URg0dT6DsBT8nSkGvDeSrXls6bgOuU3UJBlvS-5gc';
const SITE_URL = 'https://nexxtlevel.store';

// Стабільна ручна карта категорій (ID НІКОЛИ не змінюються між генераціями,
// навіть якщо в майбутньому додасться новий тип товару) — Prom.ua запам'ятовує
// прив'язку кожного categoryId до СВОЄЇ категорії один раз в кабінеті продавця;
// якби ID рахувались динамічно (напр. за алфавітом на льоту), будь-яка нова
// категорія зсунула б усі наступні номери і зламала вже зроблене спряження.
// Значення category_2 — точна копія CATEGORY_2_OPTIONS з admin.html.
const PARENT_CATEGORIES = { 'Взуття': 1, 'Одяг': 2, 'Аксесуари': 3 };
const CHILD_CATEGORIES = {
  'Взуття': { 'Кросівки': 11, 'Черевики': 12, 'Капці': 13, 'Сандалі': 14, 'Шиповки': 15 },
  'Одяг': {
    'Куртки та вітровки': 21, 'Кофти та худі': 22, 'Штани та лосини': 23, 'Футболки та майки': 24,
    'Шорти': 25, 'Спортивні костюми': 26, 'Тренч': 27
  },
  'Аксесуари': {
    'Шкарпетки': 31, 'Кепки та шапки': 32, 'Рюкзаки': 33, 'Спортивні сумки': 34, 'Жіночі сумки': 35,
    'Сумки на пояс, плече': 36, 'Месенджери': 37, 'Ремені': 38, 'Рукавички': 39
  }
};
// Стара об'єднана категорія (до розділення на "Капці"/"Сандалі") — те саме
// правило міграції значення, що й у admin.html.
const LEGACY_CATEGORY_ALIASES = { 'Шльопанці та сандалі': 'Капці' };
const FALLBACK_CATEGORY_ID = 99; // "Інше" — товар з нетиповим/відсутнім category_2

function categoryIdFor(cat1, cat2raw) {
  const cat2 = LEGACY_CATEGORY_ALIASES[cat2raw] || cat2raw;
  const childMap = CHILD_CATEGORIES[cat1];
  if (childMap && cat2 && childMap[cat2]) return childMap[cat2];
  if (PARENT_CATEGORIES[cat1]) return PARENT_CATEGORIES[cat1];
  return FALLBACK_CATEGORY_ID;
}

function buildCategoriesXml() {
  let xml = '';
  for (const [name, id] of Object.entries(PARENT_CATEGORIES)) {
    xml += `<category id="${id}">${escXml(name)}</category>\n`;
  }
  for (const [cat1, children] of Object.entries(CHILD_CATEGORIES)) {
    const parentId = PARENT_CATEGORIES[cat1];
    for (const [name, id] of Object.entries(children)) {
      xml += `<category id="${id}" parentId="${parentId}">${escXml(name)}</category>\n`;
    }
  }
  xml += `<category id="${FALLBACK_CATEGORY_ID}">Інше</category>\n`;
  return xml;
}

function escXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escCdata(s) {
  // ']]>' закриває CDATA-блок посеред тексту — на практиці в описах товарів
  // такого не буває, але про всяк випадок розриваємо цю послідовність.
  return String(s == null ? '' : s).replace(/]]>/g, ']]&gt;');
}

function cleanImageUrl(raw) {
  let clean = String(raw || '').trim();
  if (!clean) return '';
  if (clean.startsWith('http://')) clean = clean.replace('http://', 'https://');
  else if (clean.startsWith('//')) clean = 'https:' + clean;
  return clean;
}

// PostgREST за один запит віддає максимум 1000 рядків — гортаємо сторінки
// (Range-заголовок), поки не заберемо весь каталог, так само як це вже робить
// catalog.html через fetchAllRows().
async function fetchAllProducts() {
  const pageSize = 1000;
  let offset = 0;
  let all = [];
  const fields = [
    'articul', 'name', 'size', 'price', 'quantity', 'brand', 'gender',
    'category_1', 'category_2', 'description', 'photos'
  ].join(',');
  while (true) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/products?select=${fields}&quantity=gt.0&order=articul.asc`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Range: `${offset}-${offset + pageSize - 1}`
        }
      }
    );
    if (!r.ok) throw new Error(`Supabase products -> ${r.status}`);
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) break;
    all = all.concat(rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

function buildOfferXml(row) {
  const articul = row.articul || '';
  const size = row.size || '';
  const offerId = `${articul}_${size}`.replace(/\s+/g, '_');
  const price = Number(row.price) || 0;
  const categoryId = categoryIdFor(row.category_1, row.category_2);
  const pageUrl = `${SITE_URL}/product?articul=${encodeURIComponent(articul)}`;

  const pictures = String(row.photos || '')
    .split(/[;,]/)
    .map(cleanImageUrl)
    .filter(Boolean)
    .map(u => `<picture>${escXml(u)}</picture>`)
    .join('\n');

  const genderParam = row.gender ? `<param name="Стать">${escXml(row.gender)}</param>\n` : '';
  const brandXml = row.brand ? `<vendor>${escXml(row.brand)}</vendor>\n` : '';
  const descriptionXml = row.description
    ? `<description><![CDATA[${escCdata(row.description)}]]></description>\n`
    : '';

  return `<offer id="${escXml(offerId)}" available="true" group_id="${escXml(articul)}">
<url>${escXml(pageUrl)}</url>
<price>${price}</price>
<currencyId>UAH</currencyId>
<categoryId>${categoryId}</categoryId>
${pictures}
${brandXml}<vendorCode>${escXml(articul)}</vendorCode>
<name>${escXml(row.name || '')}</name>
${descriptionXml}<param name="Розмір">${escXml(size)}</param>
${genderParam}</offer>`;
}

module.exports = async (req, res) => {
  try {
    const rows = await fetchAllProducts();
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

    const offersXml = rows.map(buildOfferXml).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<yml_catalog date="${now}">
<shop>
<name>NEXXTLEVEL STORE</name>
<company>NEXXTLEVEL STORE</company>
<url>${SITE_URL}</url>
<currencies>
<currency id="UAH" rate="1"/>
</currencies>
<categories>
${buildCategoriesXml()}</categories>
<offers>
${offersXml}
</offers>
</shop>
</yml_catalog>`;

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    // 30 хв кешу на CDN Vercel — Prom.ua зазвичай сам заходить не частіше
    // кількох разів на день, тому це просто оберігає базу від зайвих
    // однакових запитів, не заважаючи фіду лишатись актуальним.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=1800, stale-while-revalidate=3600');
    res.status(200).send(xml);
  } catch (err) {
    res.status(500).send('Server error: ' + String(err && err.message || err));
  }
};
