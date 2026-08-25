// api/_lib/catalogPipeline.js
//
// Хмарний порт бізнес-логіки з update.py (той самий скрипт, який Влад раніше
// запускав локально на своєму ПК). Тут — тільки ЧИСТІ функції нормалізації/
// фільтрації/ціноутворення/очистки назв, без жодного I/O (без fetch, без
// Supabase) — так само як відповідні функції в update.py. Кожен
// api/cron-catalog-<постачальник>.js викликає ці функції для кожного
// розпарсеного рядка перед тим, як писати його в supplier_catalog.
//
// ВАЖЛИВО: логіка тут має лишатись ІДЕНТИЧНОЮ update.py — це та сама
// бізнес-логіка (ціни, категорії, фільтри брендів), що вже перевірена в
// продакшені. Будь-яку зміну правил вносити одночасно в обох місцях (або,
// якщо update.py більше ніде не використовується — тільки тут).

'use strict';

// ═══════════════════════════════════════════════════════════════════
// ФІЛЬТРИ
// ═══════════════════════════════════════════════════════════════════

const ALLOWED_BRANDS = new Set([
  'nike', 'adidas', 'puma', 'jordan', 'new balance',
  'under armour', 'reebok', 'converse', 'asics',
  'helly hansen', 'columbia', 'ellesse', 'crocs', 'saucony',
  'karrimor', 'hi-tec', 'the north face', 'jack wolfskin',
  'calvin klein', "levi's", 'marmot', 'lacoste', 'salomon',
  'timberland', 'champion', 'spyder', 'everlast', 'fila',
]);

const MIN_MARKUP = 200;
const MIN_SHOE_SIZE_EU = 35;

const EXCLUDED_NAME_WORDS = [
  'труси', 'трусы', 'underwear', 'boxer', 'боксери', 'боксерки',
  'нижня білизна', 'стринги', 'сліпи', 'шорти-труси',
  'сукня', 'сукні', 'спідниця', 'спідниці',
  'велосипедки', 'сорочка', 'сорочки',
  'бутси', 'сороконіжки', 'термобілизна',
  'футзалки', 'лосини', 'легінси', 'легінс', 'леггінси', 'леггинсы',
  'леггинс', 'leggings', 'legging',
  'майка', 'лосіни', 'щітка', 'шкарпетки',
  'бейсболка', 'кепка', 'лонгслів', 'топ', 'панама',
];

const ALLOWED_LETTER_SIZES = new Set([
  'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL', '2XS',
  'SM', 'MD', 'LG', 'S/M', 'M/L', 'L/XL',
  'ONE SIZE', 'ONESIZE', '1SIZE', 'OS', 'OSFA', 'OSFM', 'NS', 'MISC',
]);

function isAllowedSize(sizeStr) {
  if (sizeStr === null || sizeStr === undefined) return false;
  const s = String(sizeStr).trim().toUpperCase();
  if (!s || s === 'NONE') return false;
  if (ALLOWED_LETTER_SIZES.has(s)) return true;
  let m = s.match(/^(\d{2})\s+(\d)\/(\d)$/);
  if (m) {
    const v = parseFloat(m[1]);
    if (v >= 35 && v <= 60) return true;
  }
  m = s.match(/^(\d{2}(?:\.\d)?)$/);
  if (m) {
    const v = parseFloat(m[1]);
    if (v >= 16 && v <= 60) return true;
  }
  m = s.match(/^(\d{1,2}(?:\.\d)?)([YWMB]?)$/);
  if (m) {
    const v = parseFloat(m[1]);
    if (v >= 1 && v <= 16) return true;
  }
  m = s.match(/(\d{2})[-/](\d{2})/);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (a >= 16 && a <= 60 && b >= 16 && b <= 60) return true;
  }
  return false;
}

function normalizeSize(sizeStr) {
  if (!sizeStr) return sizeStr;
  let s = String(sizeStr).trim();
  if (/\b[MWJ]\d/i.test(s)) {
    const rng = s.match(/(\d{1,2})\s*[-/]\s*(\d{1,2})/);
    if (rng) return `${rng[1]}-${rng[2]}`;
  }
  const mapping = {
    SM: 'S', MD: 'M', LG: 'L',
    NS: 'ONE SIZE', ONESIZE: 'ONE SIZE', '1SIZE': 'ONE SIZE',
    OSFA: 'ONE SIZE', OSFM: 'ONE SIZE', OS: 'ONE SIZE',
    MISC: 'ONE SIZE',
  };
  const up = s.toUpperCase();
  return mapping[up] !== undefined ? mapping[up] : s;
}

// ═══════════════════════════════════════════════════════════════════
// СТАТЬ ТА КАТЕГОРІЇ
// ═══════════════════════════════════════════════════════════════════

function normalizeGender(gender) {
  const g = gender ? String(gender).trim().toLowerCase() : '';
  if (['чоловіча', 'чоловіки', 'чоловічий', 'мужская', 'мужской'].includes(g)) return 'Чоловіки';
  if (['жіноча', 'жінки', 'жіночий', 'женская', 'женский'].includes(g)) return 'Жінки';
  if (['унісекс дорослий', 'унісекс', 'унісекс дорослі'].includes(g)) return 'Унісекс';
  if (g.includes('дитяч') || g.includes('хлопчик') || g.includes('дівчинк')) {
    if (g.includes('8-15') || g.includes('(8')) return 'Діти (8-15)';
    if (g.includes('3-8') || g.includes('(3')) return 'Діти (3-8)';
    return 'Діти';
  }
  if (['n/s', '', 'none'].includes(g)) return 'Унісекс';
  return gender ? String(gender).trim() : 'Унісекс';
}

function genderLabel(g) {
  if (g.includes('Чоловік')) return 'Чоловічі';
  if (g.includes('Жінк')) return 'Жіночі';
  if (g.includes('8-15')) return 'Дитячі (8-15)';
  if (g.includes('3-8')) return 'Дитячі (3-8)';
  if (g.includes('Діти')) return 'Дитячі';
  return 'Унісекс';
}

function detectGenderFromName(n) {
  n = (n || '').toLowerCase();
  if (/жіноч|\bwomen'?s\b|\bwomen\b|женск/.test(n)) return 'Жінки';
  if (/чоловіч|\bmen'?s\b|\bmen\b|мужск/.test(n)) return 'Чоловіки';
  if (/дитяч|підлітков|малюк|\bkids\b|\bjunior\b/.test(n)) return 'Діти (8-15)';
  return null;
}

function resolveGender(genderNorm, name) {
  const g = genderNorm || 'Унісекс';
  if (genderLabel(g) === 'Унісекс') {
    const detected = detectGenderFromName(name ? String(name).toLowerCase() : '');
    if (detected) return detected;
  }
  return g;
}

function looksLikeId(text) {
  if (!text) return true;
  const t = String(text).trim();
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(t)) return true;
  if (t.length >= 20 && /^[0-9a-fA-F]+$/.test(t)) return true;
  return false;
}

function normalizeCategory(cat, sub, genderNorm, name) {
  const c = cat ? String(cat).trim() : '';
  const s = sub ? String(sub).trim() : '';
  let g = genderNorm || 'Унісекс';
  const n = name ? String(name).toLowerCase() : '';
  let gl = genderLabel(g);

  const cn = (c + ' ' + n).toLowerCase();

  if (gl === 'Унісекс') {
    const detected = detectGenderFromName(n);
    if (detected) gl = genderLabel(detected);
  }

  const any = (arr, str) => arr.some((x) => str.includes(x));

  // ВЗУТТЯ
  if (any(['кросівки', 'кросівк', 'кеді', 'кеди', 'кед '], cn) || any(['кросівки', 'кросовки', 'sneaker', 'кеди', 'кед '], n)) {
    return ['Взуття', 'Кросівки', gl];
  }
  if (any(['бутси', 'сороконіжки', 'mercurial', 'predator', 'tiempo', 'crazyfast', 'copa', 'firm ground', 'turf'], cn)) {
    return ['Взуття', 'Футбольне взуття', gl];
  }
  if (any(['тренувальне взуття', 'trainer', 'футзалки'], cn)) {
    return ['Взуття', 'Тренувальне взуття', gl];
  }
  if (any(['черевик', 'чобот', 'boots '], cn)) {
    return ['Взуття', 'Черевики та чоботи', gl];
  }
  if (any(['шльопанц', 'тапочк', 'сандал', 'slides', 'sandal', 'пантолет', 'капці', 'сланц', 'мул'], cn)) {
    return ['Взуття', 'Шльопанці та сандалі', gl];
  }

  // ОДЯГ
  if (any(['спортивний костюм', 'костюм', 'tracksuit'], cn)) {
    return ['Одяг', 'Спортивні костюми', gl];
  }
  if (any(['штани-карго', 'карго', 'джогери'], n)) {
    return ['Одяг', 'Штани та лосини', gl];
  }
  if (any(['штан', 'брюк', 'лосин', 'тайтс', 'легінс', 'pants', 'legging', 'велосипедк'], cn)) {
    return ['Одяг', 'Штани та лосини', gl];
  }
  if (any(['шорт', 'shorts'], cn)) {
    return ['Одяг', 'Шорти', gl];
  }
  if (any(['куртк', 'вітровк', 'анорак', 'пуховик', 'жилет', 'бомбер', 'jacket', 'parka', 'парк'], cn)) {
    return ['Одяг', 'Куртки та вітровки', gl];
  }
  if (any(['худі', 'толстовк', 'кофт', 'світшот', 'hoodie', 'олімпійк', 'термо'], cn)) {
    return ['Одяг', 'Кофти та худі', gl];
  }
  if (any(['футболк', 'майк', 'топ', 'джерсі', 't-shirt', 'tee', 'лонгслів'], cn)) {
    return ['Одяг', 'Футболки та майки', gl];
  }
  if (any(['сорочк', 'блуз', 'поло', 'shirt'], cn)) {
    return ['Одяг', 'Сорочки та блузи', gl];
  }
  if (any(['сукн', 'спідниц', 'dress', 'skirt'], cn)) {
    return ['Одяг', 'Сукні та спідниці', gl];
  }
  if (any(['нижня білизна', 'боксерк', 'трус', 'underwear'], cn)) {
    return ['Одяг', 'Нижня білизна', gl];
  }
  if (any(['купальник'], cn)) {
    return ['Одяг', 'Купальники', gl];
  }
  if (any(['футбольний одяг'], cn)) {
    return ['Одяг', 'Футбольний одяг', gl];
  }

  // АКСЕСУАРИ
  if (any(['рюкзак', 'сумк', 'bag', 'backpack', 'bkpk', 'crossbody', 'кросбоді',
    'waistpack', 'sling', 'fanny pack', 'duffel', 'gym sack', 'gymsack',
    'tote', 'гаманец'], cn)) {
    return ['Аксесуари', 'Сумки та рюкзаки', gl];
  }
  if (any(['шапк', 'кепк', 'бейсболк', 'рукавиц', 'шарф', 'баф', 'hat', 'cap', 'beanie'], cn)) {
    return ['Аксесуари', 'Головні убори та рукавиці', gl];
  }
  if (any(['шкарпетк', 'гетр', 'socks'], cn)) {
    return ['Аксесуари', 'Шкарпетки та гетри', gl];
  }
  if (any(["м'яч", 'мяч', 'насос'], cn) || /\bball\b/.test(cn)) {
    return ['Аксесуари', "М'ячі та насоси", gl];
  }
  if (any(['щітк', 'пін', 'догляд за взуттям', 'бальзам'], cn)) {
    return ['Аксесуари', 'Догляд за взуттям', gl];
  }
  if (any(['для плавання', 'окуляри плав', 'ласти'], cn)) {
    return ['Аксесуари', 'Для плавання', gl];
  }
  if (any(['для тренувань', 'рукавички для', 'гантел', 'скакалк'], cn)) {
    return ['Аксесуари', 'Для тренувань', gl];
  }

  if (c && s && !looksLikeId(c)) return [c, s, gl];
  if (c && !looksLikeId(c)) return [c, 'Інше', gl];
  return ['Інше', 'Інше', gl];
}

// ═══════════════════════════════════════════════════════════════════
// ЦІНОУТВОРЕННЯ
// ═══════════════════════════════════════════════════════════════════

function roundPrice(price) {
  if (!price) return price;
  price = parseFloat(price);
  if (price < 200) {
    return Math.ceil(price / 5) * 5;
  } else if (price < 500) {
    const endings = [0, 5, 9];
    const base = Math.floor(price / 10) * 10;
    for (const e of endings) {
      const candidate = base + e;
      if (candidate >= price) return candidate;
    }
    return base + 10 + 9;
  } else if (price < 1000) {
    const endings = [0, 9, 49, 50, 99];
    const base = Math.floor(price / 100) * 100;
    for (const e of endings.slice().sort((a, b) => a - b)) {
      const candidate = base + e;
      if (candidate >= price) return candidate;
    }
    return (Math.floor(price / 100) + 1) * 100 - 1;
  } else if (price < 3000) {
    const endings = [0, 49, 50, 99, 199, 249, 299, 399, 449, 499, 549, 599, 649, 699, 749, 799, 849, 899, 949, 999];
    const base = Math.floor(price / 1000) * 1000;
    for (const e of endings.slice().sort((a, b) => a - b)) {
      const candidate = base + e;
      if (candidate >= price) return candidate;
    }
    return (Math.floor(price / 1000) + 1) * 1000 - 1;
  } else {
    const endings = [0, 99, 199, 299, 399, 499, 599, 699, 799, 899, 999];
    const base = Math.floor(price / 1000) * 1000;
    for (const e of endings.slice().sort((a, b) => a - b)) {
      const candidate = base + e;
      if (candidate >= price) return candidate;
    }
    return (Math.floor(price / 1000) + 1) * 1000 - 1;
  }
}

function calculateRetailPrice(dropPrice, catL1, catL2) {
  if (!dropPrice) return null;
  const cat1 = catL1 ? String(catL1).toLowerCase() : '';
  const cat2 = catL2 ? String(catL2).toLowerCase() : '';
  let markup;

  if (cat1 === 'взуття') {
    if (['кросівки', 'тренувальне', 'футбольне', 'баскетбольне'].some((x) => cat2.includes(x))) markup = 400;
    else if (['черевики', 'чоботи'].some((x) => cat2.includes(x))) markup = 400;
    else if (['шльопанці', 'сандалі'].some((x) => cat2.includes(x))) markup = 200;
    else markup = 400;
  } else if (cat1 === 'одяг') {
    if (['футболки', 'майки'].some((x) => cat2.includes(x))) markup = 200;
    else if (['кофти', 'худі'].some((x) => cat2.includes(x))) markup = 250;
    else if (['куртки', 'вітровки'].some((x) => cat2.includes(x))) markup = 700;
    else if (['штани', 'лосини', 'шорти'].some((x) => cat2.includes(x))) markup = 250;
    else if (['костюми'].some((x) => cat2.includes(x))) markup = 500;
    else markup = 250;
  } else if (cat1 === 'аксесуари') {
    if (['сумк', 'рюкзак'].some((x) => cat2.includes(x))) markup = 200;
    else if (['шкарпет', 'гетр', 'головні убори', 'головний убір'].some((x) => cat2.includes(x))) markup = 100;
    else markup = 150;
  } else {
    markup = 300;
  }

  return Math.round(dropPrice + markup);
}

// ═══════════════════════════════════════════════════════════════════
// ОЧИСТКА НАЗВ ТОВАРІВ
// ═══════════════════════════════════════════════════════════════════

const BRAND_CANONICAL = {
  nike: 'Nike', adidas: 'Adidas', jordan: 'Jordan',
  'air jordan': 'Jordan', puma: 'Puma', 'new balance': 'New Balance',
  newbalance: 'New Balance', 'under armour': 'Under Armour',
  'under armor': 'Under Armour', reebok: 'Reebok', converse: 'Converse',
  asics: 'Asics', 'helly hansen': 'Helly Hansen', 'helly-hansen': 'Helly Hansen',
  columbia: 'Columbia', ellesse: 'Ellesse', crocs: 'Crocs', крокси: 'Crocs', joma: 'Joma',
  saucony: 'Saucony',
  karrimor: 'Karrimor', 'hi-tec': 'Hi-Tec', hitec: 'Hi-Tec',
  'the north face': 'The North Face', 'north face': 'The North Face',
  'jack wolfskin': 'Jack Wolfskin', 'calvin klein': 'Calvin Klein',
  "levi's": "Levi's", levis: "Levi's", marmot: 'Marmot',
  lacoste: 'Lacoste', salomon: 'Salomon', timberland: 'Timberland',
  champion: 'Champion', spyder: 'Spyder', everlast: 'Everlast',
  fila: 'Fila',
};

const BRAND_SEARCH_ORDER = [
  'air jordan', 'new balance', 'under armour', 'under armor',
  'helly-hansen', 'helly hansen', 'newbalance',
  'the north face', 'north face', 'jack wolfskin', 'calvin klein',
  "levi's", 'levis', 'hi-tec', 'hitec',
  'nike', 'adidas', 'jordan', 'puma', 'reebok', 'converse',
  'asics', 'columbia', 'ellesse', 'crocs', 'крокси', 'joma', 'saucony',
  'karrimor', 'marmot', 'lacoste', 'salomon', 'timberland',
  'champion', 'spyder', 'everlast', 'fila',
];

const PRODUCT_TYPES = {
  кросівки: 'Кросівки', кроссовки: 'Кросівки', кеды: 'Кросівки',
  кеди: 'Кросівки', sneaker: 'Кросівки', sneakers: 'Кросівки',
  бутси: 'Бутси', сороконіжки: 'Бутси',
  футзалки: 'Футзалки', тапочки: 'Тапочки',
  шльопанці: 'Шльопанці', сланці: 'Шльопанці',
  сандалі: 'Сандалі', сандали: 'Сандалі', сандалії: 'Сандалі',
  пантолети: 'Пантолети', капці: 'Капці', мули: 'Мули', мул: 'Мули',
  черевики: 'Черевики', чоботи: 'Чоботи', чобіт: 'Чоботи',
  ботильйони: 'Ботильйони',
  футболка: 'Футболка', футболку: 'Футболка', майка: 'Майка',
  топ: 'Топ', топи: 'Топ', лонгслів: 'Лонгслів',
  сорочка: 'Сорочка', блуза: 'Блуза', поло: 'Поло',
  худі: 'Худі', толстовка: 'Толстовка', кофта: 'Кофта',
  світшот: 'Світшот', олімпійка: 'Олімпійка', жилет: 'Жилет',
  жилетка: 'Жилет', куртка: 'Куртка', вітровка: 'Вітровка',
  анорак: 'Анорак', пуховик: 'Пуховик', бомбер: 'Бомбер',
  штани: 'Штани', брюки: 'Штани', лосини: 'Лосини',
  тайтси: 'Тайтси', легінси: 'Легінси', джогери: 'Джогери',
  карго: 'Карго', велосипедки: 'Велосипедки',
  шорти: 'Шорти', термошорти: 'Термошорти',
  костюм: 'Костюм', костюми: 'Костюм',
  сукня: 'Сукня', спідниця: 'Спідниця',
  термобілизна: 'Термобілизна',
  рюкзак: 'Рюкзак', сумка: 'Сумка', гаманець: 'Гаманець',
  шапка: 'Шапка', кепка: 'Кепка', бейсболка: 'Бейсболка',
  панама: 'Панама', шарф: 'Шарф', баф: 'Баф',
  рукавиці: 'Рукавиці', рукавички: 'Рукавички',
  шкарпетки: 'Шкарпетки', гетри: 'Гетри',
};

const CAT2_TO_TYPE_MAP = {
  Кросівки: 'Кросівки', Кеди: 'Кросівки', Шиповки: 'Шиповки',
  'Футбольне взуття': 'Бутси', 'Тренувальне взуття': 'Кросівки',
  'Шльопанці та сандалі': 'Шльопанці', "В'єтнамки": 'Шльопанці', Крокси: 'Шльопанці',
  'Черевики та чоботи': 'Черевики',
  'Футболки та майки': 'Футболка', 'Футболки і майки': 'Футболка',
  Футболка: 'Футболка', 'Футболка тренувальна': 'Футболка',
  'Кофти та худі': 'Кофта', Кофта: 'Кофта', Джемпер: 'Джемпер',
  Светр: 'Светр', Толстовка: 'Толстовка',
  'Куртки та вітровки': 'Куртка', Куртка: 'Куртка', Плащ: 'Плащ',
  Тренч: 'Тренч', Парка: 'Парка', Пальто: 'Пальто',
  Жилет: 'Жилет', Безрукавка: 'Безрукавка',
  'Штани та лосини': 'Штани', Штани: 'Штани', Лосини: 'Лосини',
  'Лосини і тайтси': 'Лосини', Бриджи: 'Бриджи', Шорти: 'Шорти',
  'Костюм спортивний': 'Костюм', Костюми: 'Костюм',
  'Сорочки та блузи': 'Сорочка', 'Сукні та спідниці': 'Сукня',
  Купальники: 'Купальник', Боді: 'Боді', Комбінезон: 'Комбінезон',
  Манішка: 'Манішка', Термобілизна: 'Термобілизна', Плавки: 'Плавки',
  Борцівки: 'Борцівки',
  'Сумки та рюкзаки': 'Сумка', 'Головні убори та рукавиці': 'Шапка',
  'Шкарпетки та гетри': 'Шкарпетки', "М'ячі та насоси": "М'яч",
  Щітка: 'Щітка', 'Для тренувань': 'Інвентар', 'Для плавання': 'Інвентар',
};

const NAME_GENDER_AGE_WORDS = [
  'чоловічі', 'чоловічий', 'чоловіча', 'чоловічого',
  'жіночі', 'жіночий', 'жіноча',
  'унісекс', 'дитячі', 'дитячий', 'дитяча', 'дитячого',
  'підліткові', 'підлітковий', 'малюка', 'малюків',
  'дівчинки', 'хлопчика',
  "men's", 'mens', "women's", 'womens', 'men', 'women', 'kids', "kid's",
  'boys', 'girls', 'boy', 'girl', 'unisex', 'junior', 'jr', 'wmns', 'wmn',
  'infant', 'baby', 'toddler', 'дорослий', 'дорослі',
];

const PAREN_MARKERS_TO_REMOVE = ['(w)', '(m)', '(wmn)', '(wmns)', '(gs)', '(ps)',
  '(td)', '(bp)', '(jor)', '(jf)', '(j)', '(jv)'];

const NAME_COLORS = [
  'чорний', 'чорна', 'чорне', 'чорні', 'чорно', 'білий', 'біла', 'біле', 'білі',
  'блакитний', 'блакитна', 'синій', 'синя', 'синє', 'сині', 'темно-синій', 'темно',
  'червоний', 'червона', 'червоне', 'рожевий', 'рожева', 'зелений', 'зелена',
  'жовтий', 'жовта', 'сірий', 'сіра', 'коричневий', 'бежевий', 'бежева',
  'помаранчевий', 'фіолетовий', 'бірюзовий', 'бордовий', 'золотий', 'срібний',
  'чорно-червоний', 'червоний-чорний', 'світло', 'кремовий', 'кремова', 'хакі',
  'army green', 'bone', 'оливковий', "м'ятний", 'лавандовий', 'пудровий',
  'black', 'white', 'blue', 'red', 'green', 'yellow', 'grey', 'gray',
  'pink', 'orange', 'brown', 'purple', 'beige', 'gold', 'silver',
  'navy', 'crystal', 'primegreen', 'cold.rdy', 'ready.dye', 'collegiate',
  'scarlet', 'multicolor', 'khaki', 'cream', 'olive',
];

const NAME_JUNK_WORDS = ['оригінал', 'original', 'ориг', 'mpu', 'promo', 'pre-order', 'pre order',
  'знижка', 'акція', 'хіт', 'розпродаж'];

const NAME_KEEP_UPPER = new Set([
  'nb', 'ua', 'hd', 'trk', 'wvn', 'nk', 'fg', 'ag', 'sg', 'tf', 'fg/ag', 'fg,ag',
  'knvb', 'nrg', 'tdd', 'se', 'gs', 'ps', 'acg', 'wp', 'gtx', 'gore-tex',
  'rdy', 'primaloft', 'app', 'eqt', 'dwm', 'fkr', 'vcp', 'ics', 'ipath',
  'ii', 'iii', 'iv', 'vi', 'vii', 'viii', 'ix', 'x',
  'jr', 'sr',
]);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// JS-регекс \b орієнтований лише на ASCII \w (A-Za-z0-9_) — кириличні літери
// він взагалі НЕ вважає "словесними" символами, тому \bчоловіча\b ніколи не
// збігається всередині кириличного тексту (на відміну від Python re, де \b
// коректно працює і з кирилицею). Це давало системний баг: видалення
// кольорів/статі/сміттєвих слів у назвах товарів просто не спрацьовувало.
// wordRe() — Unicode-обізнаний відповідник \bWORD\b через lookaround.
// Memoized: cleanModel()/detectBrandFromName() call this for the same
// (mostly static) word lists on EVERY row — at catalog scale (15k+ rows for
// ultrasport alone) rebuilding each RegExp from scratch on every call was
// the dominant cost (~25s for one supplier locally), risking a timeout
// against Vercel's serverless maxDuration. Safe to cache: String.replace()
// resets a global regex's lastIndex to 0 before each match loop (per spec),
// and the non-global .test()/.match() call sites here never use lastIndex,
// so a shared RegExp instance behaves identically to a freshly-built one.
const _wordReCache = new Map();
function wordRe(word, flags) {
  const key = `${flags || ''}|${word}`;
  let re = _wordReCache.get(key);
  if (!re) {
    re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(word)}(?![\\p{L}\\p{N}_])`, 'u' + (flags || ''));
    _wordReCache.set(key, re);
  }
  return re;
}

// cleanModel()/detectBrandFromName() re-scan these SAME static word lists on
// EVERY row (brand/color/gender/junk-word stripping). Even with wordRe()
// memoized by string key, a per-row loop still pays a Map lookup + template
// string build for each of the ~190 combined words on every single row — at
// catalog scale (15k+ rows for one supplier) that overhead is measurable
// against Vercel's serverless maxDuration budget. Precomputing the
// [word, RegExp] pairs ONCE at module load and iterating those pairs
// directly in the hot loop removes it entirely.
function precompileWordRes(words, flags) {
  return words.map((w) => [w, wordRe(w, flags)]);
}
const BRAND_SEARCH_ORDER_RE_GI = precompileWordRes(BRAND_SEARCH_ORDER, 'gi');
const BRAND_SEARCH_ORDER_RE_PLAIN = precompileWordRes(BRAND_SEARCH_ORDER, '');
const NAME_COLORS_RE_GI = precompileWordRes(NAME_COLORS, 'gi');
const NAME_GENDER_AGE_WORDS_RE_GI = precompileWordRes(NAME_GENDER_AGE_WORDS, 'gi');
const NAME_JUNK_WORDS_RE_GI = precompileWordRes(NAME_JUNK_WORDS, 'gi');
const JORDAN_ALIASES_RE_PLAIN = precompileWordRes(['air jordan', 'jordan'], '');

function clean_composition(text) {
  if (!text) return '';
  text = text.replace(/\s*;\s*/g, ', ');
  text = text.replace(/\s+/g, ' ');
  text = text.trim().replace(/,+$/, '').trim();
  return text;
}

function normalizeBrand(brandText) {
  if (!brandText) return null;
  const b = String(brandText).trim().toLowerCase();
  return BRAND_CANONICAL[b] || null;
}

function detectBrandFromName(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  for (const [alias, re] of JORDAN_ALIASES_RE_PLAIN) {
    if (n.includes(alias) && re.test(n)) return 'Jordan';
  }
  const found = [];
  for (const [alias, re] of BRAND_SEARCH_ORDER_RE_PLAIN) {
    if (alias === 'air jordan' || alias === 'jordan') continue;
    if (!n.includes(alias)) continue;
    const m = n.match(re);
    if (m) found.push([m.index, BRAND_CANONICAL[alias]]);
  }
  if (!found.length) return null;
  found.sort((a, b) => a[0] - b[0]);
  return found[0][1];
}

function getProductType(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  const words = n.split(/[\s/]+/);
  for (const w of words) {
    const wClean = w.replace(/[^\wа-яієїґ\-]/gi, '');
    if (PRODUCT_TYPES[wClean]) return PRODUCT_TYPES[wClean];
  }
  return null;
}

function smartCase(word) {
  if (!word) return word;
  if (NAME_KEEP_UPPER.has(word.toLowerCase())) return word.toUpperCase();
  if (word.includes('-') || word.includes('/')) {
    const parts = word.split(/([-/])/);
    return parts.map((p) => (/^[a-zA-Z]/.test(p) && p !== '-' && p !== '/' ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p)).join('');
  }
  if (word === word.toUpperCase() && word.length >= 2 && /^[A-Za-z]+$/.test(word)) return word;
  if (/^[a-zA-Z]/.test(word)) return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  return word;
}

function cleanModel(name, brandFound, sizeActual, sku) {
  if (!name) return '';
  let s = String(name);
  const sl = s.toLowerCase();

  if (sku) {
    const skuStr = String(sku).trim();
    if (skuStr) s = s.replace(new RegExp(escapeRe(skuStr), 'gi'), ' ');
  }

  s = s.replace(/\b\d{1,2}(?:[.,]\d+)?\s*\(\s*\d{1,2}(?:[.,]\d+)?\s*\)/g, ' ');
  s = s.replace(/\b[MWJ]\d{1,2}(?:\s*\/\s*[MWJ]\d{1,2})?\s*\(\s*\d{1,2}\s*[-/]\s*\d{1,2}\s*\)/gi, ' ');
  s = s.replace(/\(\s*\d{1,2}\s*[-/]\s*\d{1,2}\s*\)/g, ' ');

  let typeWord = null;
  const slWords = sl.split(/\s+/);
  for (const w of Object.keys(PRODUCT_TYPES)) {
    if (slWords.includes(w)) { typeWord = w; break; }
  }
  if (typeWord) s = s.replace(wordRe(typeWord, 'gi'), ' ');

  if (sku) {
    let skuStr = String(sku).trim();
    if (skuStr.endsWith('.0')) skuStr = skuStr.slice(0, -2);
    if (skuStr) {
      for (const v of new Set([skuStr, skuStr.toUpperCase(), skuStr.toLowerCase()])) {
        if (v) s = s.replace(wordRe(v, 'gi'), ' ');
      }
    }
  }

  // Fast-path: only attempt the (expensive, Unicode-lookbehind) boundary
  // regex when the word is even present as a plain substring of the
  // ORIGINAL lowercased name. Safe because every step in this function only
  // REMOVES characters from `s` (via replace(..., ' ')) — it never inserts
  // letters — so a word absent from the original `sl` can never appear in
  // the still-being-cleaned `s` either. This skips the costly regex for the
  // large majority of (word, name) pairs where the word simply isn't there.
  for (const [alias, re] of BRAND_SEARCH_ORDER_RE_GI) {
    if (sl.includes(alias)) s = s.replace(re, ' ');
  }

  s = s.replace(/\b[A-Z]{0,3}\d{4,}[-_]\d{2,4}\b/g, ' ');
  s = s.replace(/\b[A-Z]{2,3}\d{4,6}\b/g, ' ');
  s = s.replace(/\b\d{5,}\b/g, ' ');
  s = s.replace(/\b\d{5,}\.\d+\b/g, ' ');

  if (sizeActual) {
    const sizeStr = String(sizeActual).trim();
    for (const sv of new Set([sizeStr, sizeStr.replace('.', ','), sizeStr.replace(',', '.')])) {
      if (sv && /\d/.test(sv)) {
        s = s.replace(new RegExp('\\(\\s*' + escapeRe(sv) + '\\s*\\)'), ' ');
        s = s.replace(new RegExp('(?<=, )' + escapeRe(sv) + '(?=\\s|$)'), ' ');
        s = s.replace(new RegExp('(?<![\\p{L}\\p{N}_])' + escapeRe(sv) + '(?=\\s|$|,)', 'u'), ' ');
      } else if (sv) {
        s = s.replace(wordRe(sv, 'gi'), ' ');
      }
    }
  }

  s = s.replace(/\(\s*\d{1,2}(?:[.,]\d+)?\s*\)/g, ' ');
  s = s.replace(/,\s*\d{1,2}(?:[.,]\d+)?\s*$/, '');
  s = s.replace(/\b(?:eu|us|uk)\s*\d{1,2}(?:[.,]\d+)?\b/gi, ' ');

  for (const [color, re] of NAME_COLORS_RE_GI) {
    if (sl.includes(color)) s = s.replace(re, ' ');
  }

  for (const [w, re] of NAME_GENDER_AGE_WORDS_RE_GI) {
    if (sl.includes(w)) s = s.replace(re, ' ');
  }

  for (const marker of PAREN_MARKERS_TO_REMOVE) {
    s = s.split(marker.toUpperCase()).join(' ');
    s = s.split(marker).join(' ');
  }

  for (const [junk, re] of NAME_JUNK_WORDS_RE_GI) {
    if (sl.includes(junk)) s = s.replace(re, ' ');
  }
  s = s.replace(/\([^)]*(?:оригінал|original)[^)]*\)/gi, ' ');
  s = s.replace(/\(\s*\)/g, ' ');

  s = s.replace(/^["'\s]+/, '');
  s = s.replace(/["']+$/, '');

  s = s.replace(/\s+[MmWw]\s+(?=[A-Z])/g, ' ');
  s = s.replace(/\s+[MmWw]$/, '');

  let tokens = s.split(/\s+/).filter(Boolean);
  const seen = new Set();
  const cleanTokens = [];
  for (const t of tokens) {
    const tl = t.toLowerCase().replace(/^[.,]+|[.,]+$/g, '');
    // Python: лише коли tl непорожній І ще не бачений — токен зберігається.
    // Порожній tl (сама лише кома/крапка після зачистки) МОВЧКИ відкидається,
    // а не залишається в назві.
    if (tl && !seen.has(tl)) {
      seen.add(tl);
      cleanTokens.push(t);
    }
  }
  s = cleanTokens.join(' ');

  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*-\s*$/, '').trim();
  s = s.replace(/^\s*-\s*/, '').trim();
  s = s.replace(/\s*,\s*$/, '').trim();

  if (s) {
    s = s.split(' ').map(smartCase).join(' ');
  }
  s = s.trim();

  if (['m', 'w', 'men', 'women', 'unisex', 'jr'].includes(s.toLowerCase())) return '';

  return s;
}

function dedupeWords(name) {
  if (!name) return name;
  let tokens = String(name).trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return name;
  let articul = null;
  const last = tokens[tokens.length - 1];
  if (/^[A-Z0-9]{4,}[-_]?[0-9A-Z]*$/.test(last) && /\d/.test(last)) {
    articul = last;
    tokens = tokens.slice(0, -1);
  }
  const seen = new Set();
  const result = [];
  for (const t of tokens) {
    const key = t.toLowerCase().replace(/^['.,\-/]+|['.,\-/]+$/g, '');
    if (key.length >= 2 && seen.has(key)) continue;
    if (key) seen.add(key);
    result.push(t);
  }
  if (articul) result.push(articul);
  return result.join(' ').replace(/\s+/g, ' ').trim();
}

function buildCleanName(originalName, colBrand, sku, sizeActual, cat2) {
  const nameBrand = detectBrandFromName(originalName);
  let finalBrand;
  if (nameBrand === 'Jordan') finalBrand = 'Jordan';
  else if (nameBrand) finalBrand = nameBrand;
  else {
    finalBrand = normalizeBrand(colBrand) || (colBrand ? String(colBrand).trim().replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()) : '');
  }

  let productType = getProductType(originalName);
  if (!productType && cat2) {
    productType = CAT2_TO_TYPE_MAP[String(cat2).trim()] || null;
  }

  let model = cleanModel(originalName, finalBrand, sizeActual, sku);
  if (model && productType && model.toLowerCase() === productType.toLowerCase()) model = '';

  let skuStr = sku ? String(sku).trim() : '';
  if (skuStr.endsWith('.0')) skuStr = skuStr.slice(0, -2);

  const parts = [];
  if (productType) parts.push(productType);
  if (finalBrand) parts.push(finalBrand);
  if (model) parts.push(model);
  if (skuStr) parts.push(skuStr);

  let cleanName = parts.join(' ');
  cleanName = dedupeWords(cleanName);
  return [cleanName, finalBrand, model];
}

function generateDescription(item) {
  const name = item.name || '';
  const brand = item.brand || '';
  const cat1 = item.cat_l1 || '';
  const cat2 = item.cat_l2 || '';
  const gender = item.gender_norm || '';
  const existingDesc = clean_composition((item.description || '').trim());

  const cleanName = name.replace(/\s*\([A-Z0-9\-]+\)\s*$/, '').trim();
  if (!cleanName) return '';

  const genderText = { Чоловіки: 'чоловіків', Жінки: 'жінок', Унісекс: 'чоловіків та жінок' }[gender] || '';

  const parts = [];

  if (cat2 === 'Нижня білизна') {
    parts.push(`${cleanName} — комфортна та практична білизна від ${brand}, створена для повсякденного використання.`);
    parts.push("Якісні матеріали забезпечують відмінну посадку, м'якість та довговічність.");
  } else if (cat2 === 'Головні убори та рукавиці') {
    parts.push(`${cleanName} — функціональний аксесуар від ${brand} для тренувань та активного відпочинку.`);
    parts.push('Забезпечує надійний захист та комфорт під час занять спортом.');
  } else if (cat2 === 'Шкарпетки та гетри') {
    parts.push(`${cleanName} — якісні шкарпетки від ${brand} для спорту та повсякденного носіння.`);
    parts.push('Забезпечують комфорт та підтримку стопи протягом усього дня.');
  } else if (cat2 === 'Сумки та рюкзаки') {
    parts.push(`${cleanName} — практичний та стильний аксесуар від ${brand}.`);
    parts.push('Зручний для тренувань, подорожей чи повсякденного використання.');
  } else if (cat1 === 'Взуття') {
    parts.push(`${cleanName} — оригінальне взуття від ${brand}${genderText ? ', розраховане на ' + genderText : ''}.`);
    parts.push('Поєднання стилю та функціональності робить цю модель чудовим вибором для повсякденного носіння та активного способу життя.');
  } else if (cat1 === 'Одяг') {
    parts.push(`${cleanName} — стильний одяг від ${brand}${genderText ? ', призначений для ' + genderText : ''}.`);
    parts.push('Виготовлений з якісних матеріалів для максимального комфорту.');
  } else if (cat1 === 'Аксесуари') {
    parts.push(`${cleanName} — практичний аксесуар від ${brand}.`);
    parts.push('Поєднує функціональність та стильний дизайн.');
  } else {
    parts.push(`${cleanName} — оригінальний товар від ${brand}.`);
  }

  if (existingDesc && existingDesc.length < 150) {
    parts.push(`Склад: ${existingDesc}.`);
  }

  return parts.join(' ');
}

// ═══════════════════════════════════════════════════════════════════
// ЗВЕДЕНИЙ ПАЙПЛАЙН ДЛЯ ОДНОГО РЯДКА (виклик з cron-catalog-<supplier>.js)
// ═══════════════════════════════════════════════════════════════════

// row: { sku, name, size, drop_price, retail_price, qty, brand, gender,
//        category, subcategory, description, photos: [urls], supplier }
// Повертає null, якщо рядок відсіюється фільтром (розмір/бренд/наценка),
// інакше — готовий об'єкт для upsert у supplier_catalog.
function processRow(row) {
  if (!isAllowedSize(row.size)) return null;
  const size = normalizeSize(row.size);

  const brand = (row.brand || '').trim().toLowerCase();
  const name = (row.name || '').toLowerCase();
  let brandOk = [...ALLOWED_BRANDS].some((b) => brand.includes(b));
  if (!brandOk && !brand) brandOk = [...ALLOWED_BRANDS].some((b) => name.includes(b));
  if (!brandOk) return null;

  if (EXCLUDED_NAME_WORDS.some((w) => name.includes(w))) return null;

  // Number() (на відміну від parseFloat!) вимагає, щоб ЦІЛИЙ рядок був
  // числом — інакше NaN. Python float('2XL') кидає ValueError і рядок
  // пропускається (розмір нечисловий, перевірка не застосовується); JS
  // parseFloat('2XL') натомість мовчки повернув би 2 (бере лише початок
  // рядка) — це хибно відсіювало б нечислові розміри одягу (2XL, 3XL...)
  // як "занадто малий розмір взуття".
  const sizeVal = Number(String(size).trim().replace(',', '.'));
  if (!Number.isNaN(sizeVal)) {
    if (sizeVal < MIN_SHOE_SIZE_EU) return null;
  }

  const dropPrice = row.drop_price || 0;

  // ВАЖЛИВО: це той самий виклик, що Python робить у passes_filter() —
  // на СИРИХ category/subcategory постачальника (часто технічний UUID),
  // ДО normalize_category(). Це навмисно окремий розрахунок від того, що
  // йде в retail_price нижче (там уже нормалізовані категорії) — Python
  // так само рахує це двічі з різними вхідними даними, тут повторюємо
  // те саме, інакше фільтр наценки відсіює не ті товари.
  const rawCat1 = row.category ? String(row.category).toLowerCase() : '';
  const rawCat2 = row.subcategory ? String(row.subcategory).toLowerCase() : '';
  const filterMarkup = calculateRetailPrice(dropPrice, rawCat1, rawCat2);
  if (filterMarkup === null) return null;
  if (filterMarkup - dropPrice < MIN_MARKUP) return null;

  let genderNorm = normalizeGender(row.gender || '');
  genderNorm = resolveGender(genderNorm, row.name || '');
  const [l1, l2, l3] = normalizeCategory(row.category || '', row.subcategory || '', genderNorm, row.name || '');

  const displayMarkup = calculateRetailPrice(dropPrice, l1, l2);
  const retailPrice = displayMarkup ? roundPrice(displayMarkup) : null;

  const [cleanName, cleanBrand] = buildCleanName(row.name || '', row.brand || '', row.sku || '', size, l2);

  const generatedDesc = generateDescription({
    name: cleanName, brand: cleanBrand, cat_l1: l1, cat_l2: l2,
    gender_norm: genderNorm, description: row.description || '',
  });

  const photos = (row.photos || []).slice(0, 8);

  return {
    sku: String(row.sku).trim(),
    size,
    supplier: row.supplier,
    name: cleanName,
    drop_price: dropPrice,
    retail_price: retailPrice,
    qty: row.qty || 0,
    brand: cleanBrand,
    gender: genderNorm,
    category_1: l1,
    category_2: l2,
    category_3: l3,
    description: generatedDesc,
    photos: photos.join(';'),
  };
}

module.exports = {
  isAllowedSize, normalizeSize, normalizeGender, genderLabel, detectGenderFromName,
  resolveGender, normalizeCategory, roundPrice, calculateRetailPrice,
  normalizeBrand, detectBrandFromName, getProductType, cleanModel, buildCleanName,
  generateDescription, processRow,
  ALLOWED_BRANDS, MIN_MARKUP, MIN_SHOE_SIZE_EU, EXCLUDED_NAME_WORDS,
};
