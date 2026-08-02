// Віддає повний Excel-каталог тільки авторизованому адміну.
// Токен доступу користувача передається з браузера (Authorization: Bearer <access_token>),
// підтвердження прав робиться через Supabase REST з тим самим токеном:
// RLS-політика "Пользователи видят свой профиль" (auth.uid() = id) сама
// гарантує, що повернеться рядок лише цього користувача — тож жодного
// service-role ключа тут не потрібно.
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://jkwppbriklmxbivndxeq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprd3BwYnJpa2xteGJpdm5keGVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0OTIyMDUsImV4cCI6MjEwMTA2ODIwNX0.z1URg0dT6DsBT8nSkGvDeSrXls6bgOuU3UJBlvS-5gc';

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
        Authorization: `Bearer ${token}`
      }
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

    const filePath = path.join(__dirname, '_data', 'excel-catalog.json');
    const data = fs.readFileSync(filePath, 'utf8');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(data);
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String(err && err.message || err) });
  }
};
