// Автоматичне оновлення каталогу постачальника ideasport — повністю в хмарі,
// без участі локального ПК. Викликається щогодини через WebFetch зі
// scheduled task на /api/cron-catalog-ideasport?secret=...
// Деталі архітектури — див. api/_lib/catalogCronHandler.js.
const { makeCatalogCronHandler } = require('./_lib/catalogCronHandler');
const { parseIdeasportXml } = require('./_lib/catalogParsers');

module.exports = makeCatalogCronHandler({
  supplier: 'ideasport',
  url: 'https://hub.idealsport.com.ua/feeds/dropshipping/dropshipping_products-ownwarehouses-categorya.xml',
  parse: parseIdeasportXml,
  minExpectedRows: 200,
});
