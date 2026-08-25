// supabaseService.js — thin server-to-server Supabase REST helper using the
// service-role key (bypasses RLS). Mirrors the supaService() pattern already
// used in api/cron-sync-ttn.js, factored out here because the 6 new catalog
// cron endpoints all need it.
const SUPABASE_URL = 'https://jkwppbriklmxbivndxeq.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supaService(path, opts) {
  opts = opts || {};
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    body: opts.body,
    headers: Object.assign(
      {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      opts.method && opts.method !== 'GET' ? { Prefer: 'return=minimal' } : {},
      opts.headers || {},
    ),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Supabase ${path} -> ${r.status}: ${text}`);
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

// Paginated GET — PostgREST caps a single response's row count (project
// "max rows" setting, commonly 1000), so any table/view that can exceed
// that (products: ~13k rows; supplier_catalog_merged: tens of thousands)
// must be paged through via the Range header rather than fetched in one call.
async function supaServiceAll(path, opts) {
  opts = opts || {};
  const pageSize = opts.pageSize || 1000;
  const all = [];
  let offset = 0;
  for (;;) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: Object.assign(
        {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          Range: `${offset}-${offset + pageSize - 1}`,
        },
        opts.headers || {},
      ),
    });
    if (!r.ok && r.status !== 206) {
      const text = await r.text().catch(() => '');
      throw new Error(`Supabase ${path} -> ${r.status}: ${text}`);
    }
    const text = await r.text();
    const page = text ? JSON.parse(text) : [];
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

module.exports = {
  supaService, supaServiceAll, SUPABASE_URL, SERVICE_KEY,
};
