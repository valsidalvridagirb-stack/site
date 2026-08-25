// Автоматичне оновлення каталогу постачальника olxandery — повністю в
// хмарі, без участі локального ПК. Джерело — публічний CSV-експорт
// Google Sheets постачальника. Викликається щогодини через WebFetch зі
// scheduled task на /api/cron-catalog-olxandery?secret=...
// Деталі архітектури — див. api/_lib/catalogCronHandler.js.
const { makeCatalogCronHandler } = require('./_lib/catalogCronHandler');
const { parseOlxanderyCsv } = require('./_lib/catalogParsers');

module.exports = makeCatalogCronHandler({
  supplier: 'olxandery',
  url: 'https://docs.google.com/spreadsheets/d/1pOlj2HKFsfk3aYjrOAPjBSEikrKSh9NBmCL31FSRrFE/export?format=csv&gid=0',
  parse: parseOlxanderyCsv,
  minExpectedRows: 100,
});
