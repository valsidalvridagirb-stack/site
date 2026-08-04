// Динамічна sitemap.xml — головна причина, чому Google взагалі не бачив
// сайт: без sitemap пошуковик має сам "натрапити" на кожну сторінку,
// переходячи за посиланнями, що для нового сайту без зовнішніх посилань
// на нього займає дуже довго (тижні-місяці) або не відбувається взагалі.
// Sitemap явно перелічує всі URL, включно з кожним товаром — і головне,
// генерується "на льоту" з бази, тож ніколи не застаріває при додаванні/
// видаленні товарів, на відміну від статичного файлу.
const SUPABASE_URL = 'https://jkwppbriklmxbivndxeq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprd3BwYnJpa2xteGJpdm5keGVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0OTIyMDUsImV4cCI6MjEwMTA2ODIwNX0.z1URg0dT6DsBT8nSkGvDeSrXls6bgOuU3UJBlvS-5gc';
const SITE_URL = 'https://nexxtlevel.store';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = async (req, res) => {
  try {
    const staticPages = [
      { loc: '/', priority: '1.0' },
      { loc: '/catalog', priority: '0.9' },
      { loc: '/delivery', priority: '0.5' },
      { loc: '/payment', priority: '0.5' },
      { loc: '/returns', priority: '0.5' },
      { loc: '/size-chart', priority: '0.4' },
      { loc: '/track-order', priority: '0.3' }
    ];

    let products = [];
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/products?select=articul,created_at&order=created_at.desc`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
      );
      if (r.ok) products = await r.json();
    } catch (e) {
      // якщо база недоступна — все одно віддамо статичні сторінки нижче
    }

    // Дедуплікація за артикулом (у таблиці по рядку на кожен розмір).
    const seen = new Set();
    const productEntries = [];
    for (const p of products || []) {
      if (!p.articul || seen.has(p.articul)) continue;
      seen.add(p.articul);
      productEntries.push({
        loc: `/product?articul=${encodeURIComponent(p.articul)}`,
        lastmod: p.created_at ? new Date(p.created_at).toISOString().slice(0, 10) : undefined,
        priority: '0.8'
      });
    }

    const urls = staticPages.concat(productEntries);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${esc(SITE_URL + u.loc)}</loc>
${u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : ''}    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).send(xml);
  } catch (err) {
    res.status(500).send('Server error: ' + String(err && err.message || err));
  }
};
