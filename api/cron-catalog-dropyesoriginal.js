// Автоматичне оновлення каталогу постачальника dropyesoriginal — повністю в
// хмарі, без участі локального ПК. Викликається щогодини через WebFetch зі
// scheduled task на /api/cron-catalog-dropyesoriginal?secret=...
// Деталі архітектури — див. api/_lib/catalogCronHandler.js.
const { makeCatalogCronHandler } = require('./_lib/catalogCronHandler');
const { parseDropyesoriginalXml } = require('./_lib/catalogParsers');

module.exports = makeCatalogCronHandler({
  supplier: 'dropyesoriginal',
  url: 'https://drop.yesoriginal.com.ua/price/drop.xml',
  parse: parseDropyesoriginalXml,
  minExpectedRows: 100,
});
