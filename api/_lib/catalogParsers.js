// parsers.js — per-supplier feed parsers. Each takes the raw feed text
// (already fetched) and returns an array of "raw row" objects matching the
// shape update.py's parse_*() functions produce:
//   { sku, name, size, drop_price, retail_price, qty, brand, gender,
//     category, subcategory, description, photos: [urls], supplier }
// These raw rows feed directly into catalogPipeline.processRow().

const {
  getTagText, getAllTagTexts, getAllParams, iterateBlocks, normalizeXmlText,
} = require('./xmlLite');
const { normalizeCategory } = require('./catalogPipeline');

function toFloatOrNull(s) {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

function toIntOr0(s) {
  const n = toFloatOrNull(s);
  return n === null ? 0 : Math.trunc(n);
}

// ─── ideasport — YML feed ───────────────────────────────────────────
function parseIdeasportXml(xmlText) {
  xmlText = normalizeXmlText(xmlText);
  const rows = [];
  const shopMatch = xmlText.match(/<shop[\s>][\s\S]*/);
  const shopXml = shopMatch ? shopMatch[0] : xmlText;
  const offers = iterateBlocks(shopXml, 'offer');
  for (const offer of offers) {
    const sku = (getTagText(offer, 'vendorCode') || getTagText(offer, 'SKU') || '').trim();
    const name = (getTagText(offer, 'name') || '').trim();
    const dropPriceRaw = getTagText(offer, 'drop_price') || '';
    const retailRaw = getTagText(offer, 'price') || getTagText(offer, 'price_new') || '';
    const desc = (getTagText(offer, 'description') || '').trim();
    const cat = (getTagText(offer, 'categoryId') || '').trim();
    const qtyRaw = getTagText(offer, 'quantity_in_stock') || '0';

    const params = getAllParams(offer, 'param');
    let size = null;
    let brand = '';
    let gender = '';
    for (const p of params) {
      const pname = (p.name || '').toLowerCase();
      if (['розмір eur', 'розмір eu', 'розмір євро'].some((x) => pname.includes(x))) {
        size = (p.text || '').trim();
      } else if (['бренд', 'brand'].some((x) => pname.includes(x))) {
        brand = (p.text || '').trim();
      } else if (['стать', 'пол', 'gender'].some((x) => pname.includes(x))) {
        gender = (p.text || '').trim();
      }
    }

    const photos = getAllTagTexts(offer, 'picture').map((s) => s.trim()).filter(Boolean);

    if (!sku || !size) continue;
    const dropPrice = dropPriceRaw ? toFloatOrNull(dropPriceRaw) : null;
    const retail = retailRaw ? toFloatOrNull(retailRaw) : null;
    if (dropPriceRaw && dropPrice === null) continue;
    if (retailRaw && retail === null) continue;
    const qty = qtyRaw ? toIntOr0(qtyRaw) : 0;
    if (dropPrice === null) continue;

    rows.push({
      sku, name, size, drop_price: dropPrice, retail_price: retail,
      qty, brand, gender, category: cat, subcategory: '',
      description: desc, photos, supplier: 'ideasport',
    });
  }
  return rows;
}

// ─── dropyesoriginal — Atom / Google Shopping feed ──────────────────
function parseDropyesoriginalXml(xmlText) {
  xmlText = normalizeXmlText(xmlText);
  const rows = [];
  const entries = iterateBlocks(xmlText, 'entry');
  for (const entry of entries) {
    const findG = (tag) => (getTagText(entry, `g:${tag}`) || '').trim();
    const attrs = getAllParams(entry, 'g:attribute');
    const findAttr = (name) => {
      const hit = attrs.find((a) => a.name === name);
      return hit ? (hit.text || '').trim() : '';
    };

    const sku = findG('mpn');
    const name = findG('title');
    const dropPriceRaw = findG('drop_price');
    const priceRaw = findG('price').replace(/ UAN/g, '').replace(/ UAH/g, '').trim();
    const brand = findG('brand');
    const category = findG('product_type');
    const avail = findG('availability');
    const gender = findAttr('Стать');
    const size = findAttr('Розмір');

    const qty = avail.toLowerCase().includes('in stock') ? 1 : 0;

    const photos = [
      ...getAllTagTexts(entry, 'g:image_link'),
      ...getAllTagTexts(entry, 'g:additional_image_link'),
    ].map((s) => s.trim()).filter(Boolean);

    if (!sku || !size) continue;
    const dropPrice = dropPriceRaw ? toFloatOrNull(dropPriceRaw) : null;
    const retail = priceRaw ? toFloatOrNull(priceRaw) : null;
    if (dropPriceRaw && dropPrice === null) continue;
    if (priceRaw && retail === null) continue;
    if (dropPrice === null) continue;

    // dropyesoriginal's feed has only ONE category level (g:product_type).
    // passes_filter()/calculate_retail_price() run on the RAW category/
    // subcategory before normalize_category() — with an empty subcategory
    // every item fell into the generic "інше" bucket (150 markup, below the
    // 200 MIN_MARKUP) and got silently dropped. Pre-compute the subcategory
    // with the same classifier normalize_category() uses, so the filter
    // sees it correctly. (Mirrors update.py's parse_dropyesoriginal_xml.)
    const [, subcatGuess] = normalizeCategory(category, '', gender, name);

    rows.push({
      sku, name, size, drop_price: dropPrice, retail_price: retail,
      qty, brand, gender, category, subcategory: subcatGuess,
      description: '', photos, supplier: 'dropyesoriginal',
    });
  }
  return rows;
}

// ─── ultrasport — YML feed (CDATA-heavy) ────────────────────────────
function parseUltrasportXml(xmlText) {
  xmlText = normalizeXmlText(xmlText);
  const rows = [];
  const shopMatch = xmlText.match(/<shop[\s>][\s\S]*/);
  const shopXml = shopMatch ? shopMatch[0] : xmlText;
  const offers = iterateBlocks(shopXml, 'offer');
  for (const offer of offers) {
    const sku = (getTagText(offer, 'vendorCode') || '').trim();
    const name = (getTagText(offer, 'name') || '').trim();
    const priceRaw = getTagText(offer, 'price') || '';
    const oldRaw = getTagText(offer, 'oldprice') || '';
    const brand = (getTagText(offer, 'vendor') || '').trim();
    const desc = (getTagText(offer, 'description') || '').trim();

    const params = getAllParams(offer, 'param');
    let qty = 0;
    let size = null;
    for (const p of params) {
      const pname = (p.name || '').trim().toLowerCase();
      if (['кількість', 'количество', 'qty', 'quantity'].includes(pname)) {
        qty = toIntOr0(p.text);
      } else if (['розмір', 'размер', 'size'].includes(pname)) {
        size = (p.text || '').trim();
      }
    }
    if (size === null && params.length >= 2) {
      size = (params[1].text || '').trim();
      if (qty === 0) qty = toIntOr0(params[0].text);
    } else if (size === null && params.length === 1) {
      size = (params[0].text || '').trim();
    }

    const photos = getAllTagTexts(offer, 'picture').map((s) => s.trim()).filter(Boolean);

    if (!sku || !size) continue;
    const dropPrice = priceRaw ? toFloatOrNull(priceRaw) : null;
    const retail = oldRaw ? toFloatOrNull(oldRaw) : null;
    if (priceRaw && dropPrice === null) continue;
    if (oldRaw && retail === null) continue;
    if (dropPrice === null) continue;

    rows.push({
      sku, name, size, drop_price: dropPrice, retail_price: retail,
      qty, brand, gender: '', category: '', subcategory: '',
      description: desc, photos, supplier: 'ultrasport',
    });
  }
  return rows;
}

// ─── tcross — public YML feed (https://tcross1.pp.ua.s52.hhos.net/feed.xml) ─────
// Combines tcross_feed_sync.py's category-chain resolution with
// update.py's parse_tcross() column mapping, reading the feed directly
// instead of round-tripping through an .xlsx file.
function parseTcrossXml(xmlText) {
  xmlText = normalizeXmlText(xmlText);
  const rows = [];
  const shopMatch = xmlText.match(/<shop[\s>][\s\S]*/);
  const shopXml = shopMatch ? shopMatch[0] : xmlText;

  const cats = {};
  const categoriesBlocks = iterateBlocks(shopXml, 'categories');
  if (categoriesBlocks.length) {
    for (const catEl of iterateBlocks(categoriesBlocks[0], 'category')) {
      const idMatch = catEl.match(/<category[^>]*\bid\s*=\s*"([^"]*)"/);
      const parentMatch = catEl.match(/<category[^>]*\bparentId\s*=\s*"([^"]*)"/);
      const id = idMatch ? idMatch[1] : null;
      if (!id) continue;
      const gt = catEl.indexOf('>');
      const closeIdx = catEl.lastIndexOf('</category>');
      const text = closeIdx > gt ? catEl.slice(gt + 1, closeIdx).trim() : '';
      cats[id] = { name: text, parentId: parentMatch ? parentMatch[1] : '' };
    }
  }
  const categoryChain = (catId) => {
    const chain = [];
    const seen = new Set();
    let cid = catId;
    while (cid && cats[cid] && !seen.has(cid)) {
      seen.add(cid);
      chain.push(cats[cid].name);
      cid = cats[cid].parentId;
    }
    return chain;
  };

  const offers = iterateBlocks(shopXml, 'offer');
  for (const offer of offers) {
    const articul = (getTagText(offer, 'vendorCode') || getTagText(offer, 'sku') || '').trim();
    const name = (getTagText(offer, 'name') || '').trim();
    if (!articul || !name) continue;

    const paramList = getAllParams(offer, 'param');
    const paramVal = (pname) => {
      const hit = paramList.find((p) => p.name === pname);
      return hit ? (hit.text || '').trim() : '';
    };
    const sizeUs = paramVal('Розмір US');
    const sizeEu = paramVal('Розмір EU');
    const sizeCm = paramVal('Розмір СМ') || paramVal('Розмір CM');
    const gender = paramVal('Стать');
    const brand = paramVal('Бренд');

    const qty = toIntOr0(getTagText(offer, 'quantity_in_stock') || '0');
    const priceRaw = (getTagText(offer, 'price') || '').trim();
    const dropPriceRaw = (getTagText(offer, 'drop_price') || '').trim();
    const retail = priceRaw ? toFloatOrNull(priceRaw) : null;
    const dropPrice = dropPriceRaw ? toFloatOrNull(dropPriceRaw) : null;

    const photos = getAllTagTexts(offer, 'picture').map((s) => s.trim()).filter(Boolean);

    const catId = (getTagText(offer, 'categoryId') || '').trim();
    const category = categoryChain(catId).join(';');

    const size = sizeEu || sizeUs || sizeCm;
    if (!articul || !size || dropPrice === null) continue;

    rows.push({
      sku: articul, name, size,
      drop_price: dropPrice, retail_price: retail,
      qty, brand, gender, category, subcategory: '',
      description: '', photos, supplier: 'tcross',
    });
  }
  return rows;
}

// ─── olxandery — CSV export (Google Sheets, export?format=csv) ─────
const OLXANDERY_JACKET_RE = /\b(jacket|parka|vest|puffer|bomber|windbreaker|coat|down|anorak)\b/i;
const OLXANDERY_SUIT_RE = /\b(suit|tracksuit|sweatsuit)\b/i;
const OLXANDERY_SANDAL_RE = /sandal|slide|шльопанц|сандал/i;
const OLXANDERY_HOODIE_RE = /\b(hoodie|hoody|sweatshirt|pullover)\b/i;
const OLXANDERY_PANTS_RE = /\b(pants|trousers|joggers|jogger|sweatpants|cargo)\b/i;

// Minimal RFC-4180 CSV line splitter (handles quoted fields with embedded
// commas/newlines/escaped quotes) — enough for a Google Sheets CSV export,
// without pulling in an npm CSV dependency.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  // Strip BOM (utf-8-sig equivalent)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // skip; \n (or EOF) will terminate the row
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function parseOlxanderyCsv(csvText) {
  const rows = [];
  const table = parseCsv(csvText);
  if (!table.length) return rows;
  const header = table[0];
  const colIdx = {};
  header.forEach((h, i) => { colIdx[h.trim()] = i; });
  const get = (r, name) => {
    const idx = colIdx[name];
    return idx === undefined ? '' : (r[idx] || '').trim();
  };

  for (let i = 1; i < table.length; i += 1) {
    const r = table[i];
    if (!r.some((v) => v && v.trim())) continue;

    const sku = get(r, 'Артикул');
    const name = get(r, 'Назва');
    const size = get(r, 'Розмір (EU)');
    const usSize = get(r, 'Розмір, US');
    const priceRaw = get(r, 'Ціна (грн.)').replace(',', '.');
    const qtyRaw = get(r, 'Кількість');
    const gender = get(r, 'Стать');
    let brand = get(r, 'Бренд');

    if (!sku || !size) continue;

    if (brand.trim().toLowerCase() === 'new') brand = 'New Balance';

    const isShoe = Boolean(usSize);
    let category;
    let subcategory;
    if (isShoe) {
      if (OLXANDERY_SANDAL_RE.test(name)) {
        category = 'Взуття'; subcategory = 'Шльопанці та сандалі';
      } else {
        category = 'Взуття'; subcategory = 'Кросівки';
      }
    } else if (OLXANDERY_JACKET_RE.test(name)) {
      category = 'Одяг'; subcategory = 'Куртки та вітровки';
    } else if (OLXANDERY_SUIT_RE.test(name)) {
      category = 'Одяг'; subcategory = 'Спортивні костюми';
    } else if (OLXANDERY_HOODIE_RE.test(name)) {
      category = 'Одяг'; subcategory = 'Кофти та худі';
    } else if (OLXANDERY_PANTS_RE.test(name)) {
      category = 'Одяг'; subcategory = 'Штани та лосини';
    } else {
      continue; // product type not imported yet, matches update.py
    }

    const dropPrice = priceRaw ? toFloatOrNull(priceRaw) : null;
    const qty = qtyRaw ? toIntOr0(qtyRaw) : 0;
    if (dropPrice === null) continue;

    rows.push({
      sku, name, size, drop_price: dropPrice, retail_price: null,
      qty, brand, gender, category, subcategory,
      description: '', photos: [], supplier: 'olxandery',
    });
  }
  return rows;
}

module.exports = {
  parseIdeasportXml,
  parseDropyesoriginalXml,
  parseUltrasportXml,
  parseTcrossXml,
  parseOlxanderyCsv,
};
