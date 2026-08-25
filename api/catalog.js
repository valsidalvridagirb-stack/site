// Віддає повний каталог (для пошуку по артикулу в адмінці) тільки
// авторизованому адміну.
//
// РАНІШЕ читав статичний закомічений у git файл api/_data/excel-catalog.json,
// який генерував scripts/sync_catalog.py з xlsx, що збирав локальний
// update.py на комп'ютері власника сайту (а значить каталог не оновлювався,
// поки ноутбук вимкнений). Тепер натомість читає SQL-в'юху
// supplier_catalog_merged напряму з Supabase — її наповнюють хмарні
// cron-catalog-<постачальник>.js ендпоінти, тож дані тут завжди свіжі,
// незалежно від того, чи увімкнений ноутбук.
//
// Права підтверджуються токеном доступу користувача з браузера
// (Authorization: Bearer <access_token>) через Supabase REST з тим самим
// токеном — RLS-політика "Пользователи видят свой профиль" (auth.uid() = id)
// сама гарантує, що повернеться рядок лише цього користувача. Сам виклик
// supplier_catalog_merged після підтвердження прав іде вже під сервісним
// ключем (як і в інших cron/service-ендпоінтах цього проєкту) — так надійніше,
// ніж покладатись на RLS в'юхи, і не залежить від того, чи view позначена
// security_invoker.
const { supaServiceAll } = require('./_lib/supabaseService');

const SUPABASE_URL = 'https://jkwppbriklmxbivndxeq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprd3BwYnJpa2xteGJpdm5keGVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0OTIyMDUsImV4cCI6MjEwMTA2ODIwNX0.z1URg0dT6DsBT8nSkGvDeSrXls6bgOuU3UJBlvS-5gc';

const COLS = ['art', 'size', 'name', 'price', 'qty', 'brand', 'gender', 'cat1', 'cat2', 'cat3', 'supplier'];

module.exports = async (req, res) => {
  try {
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

    const merged = await supaServiceAll(
      'supplier_catalog_merged?select=sku,size,name,retail_price,qty,brand,gender,category_1,category_2,category_3,supplier',
    );

    const catalogRows = merged.map((r) => [
      r.sku, r.size, r.name, r.retail_price, r.qty, r.brand, r.gender,
      r.category_1, r.category_2, r.category_3, r.supplier,
    ]);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json({ cols: COLS, rows: catalogRows });
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String((err && err.message) || err) });
  }
};
