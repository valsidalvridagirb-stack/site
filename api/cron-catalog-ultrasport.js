// Автоматичне оновлення каталогу постачальника ultrasport — повністю в
// хмарі, без участі локального ПК. Викликається щогодини через WebFetch зі
// scheduled task на /api/cron-catalog-ultrasport?secret=...
// Деталі архітектури — див. api/_lib/catalogCronHandler.js.
//
// Найбільший з 5 автоматизованих фідів (~18-19 тис. офферів, ~39МБ) — тому
// саме цей ендпоінт найближче до ліміту maxDuration (див. vercel.json).
const { makeCatalogCronHandler } = require('./_lib/catalogCronHandler');
const { parseUltrasportXml } = require('./_lib/catalogParsers');

module.exports = makeCatalogCronHandler({
  supplier: 'ultrasport',
  url: 'https://www.ultrasport.in.ua/content/export/096ca1b04127691f3dcc6e8927f35f63.xml',
  parse: parseUltrasportXml,
  minExpectedRows: 1000,
});
