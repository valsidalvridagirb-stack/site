// Спільні хелпери для роботи з Nova Poshta API та Supabase REST
// з-під токена користувача (без сервісного ключа — авторизація йде через RLS).
const SUPABASE_URL = 'https://jkwppbriklmxbivndxeq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprd3BwYnJpa2xteGJpdm5keGVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0OTIyMDUsImV4cCI6MjEwMTA2ODIwNX0.z1URg0dT6DsBT8nSkGvDeSrXls6bgOuU3UJBlvS-5gc';
const NP_URL = 'https://api.novaposhta.ua/v2.0/json/';
const NP_KEY = process.env.NOVA_POSHTA_API_KEY;

async function npCall(modelName, calledMethod, methodProperties) {
  if (!NP_KEY) throw new Error('NOVA_POSHTA_API_KEY не налаштовано на сервері (Vercel → Settings → Environment Variables)');
  const r = await fetch(NP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: NP_KEY, modelName, calledMethod, methodProperties: methodProperties || {} })
  });
  const json = await r.json();
  if (!json.success) {
    const errs = [].concat(json.errors || []).concat(json.warnings || []);
    throw new Error(errs.length ? errs.join('; ') : 'Помилка Nova Poshta API');
  }
  return json.data;
}

async function supaFetch(path, token, opts) {
  opts = opts || {};
  const isWrite = opts.method && opts.method !== 'GET';
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    body: opts.body,
    headers: Object.assign(
      {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      isWrite ? { Prefer: 'return=representation' } : {},
      opts.headers || {}
    )
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Supabase ${path} -> ${r.status}: ${text}`);
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function requireAdmin(token) {
  if (!token) {
    const e = new Error('no_token');
    e.httpStatus = 401;
    throw e;
  }
  const rows = await supaFetch('profiles?select=is_admin', token);
  if (!rows || !rows.length || !rows[0].is_admin) {
    const e = new Error('not_admin');
    e.httpStatus = 403;
    throw e;
  }
}

function getToken(req) {
  const authHeader = req.headers['authorization'] || '';
  return authHeader.replace(/^Bearer\s+/i, '').trim();
}

module.exports = { npCall, supaFetch, requireAdmin, getToken };
