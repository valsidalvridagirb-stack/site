// Автоматичне оновлення каталогу постачальника tcross — повністю в хмарі,
// без участі локального ПК. Раніше вимагало окремого локального скрипта
// tcross_feed_sync.py, що перезаписував tcross.xlsx для update.py; тут той
// самий публічний фід парситься напряму, без проміжного xlsx.
// Викликається щогодини через WebFetch зі scheduled task на
// /api/cron-catalog-tcross?secret=... Деталі архітектури — див.
// api/_lib/catalogCronHandler.js.
const { makeCatalogCronHandler } = require('./_lib/catalogCronHandler');
const { parseTcrossXml } = require('./_lib/catalogParsers');

module.exports = makeCatalogCronHandler({
  supplier: 'tcross',
  url: 'https://tcross1.pp.ua/feed.xml',
  parse: parseTcrossXml,
  minExpectedRows: 200,
});
