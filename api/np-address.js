// Публічний (без авторизації) ендпоінт для підказок при оформленні замовлення:
// клієнт вводить перші літери міста — повертаємо список міст Нової Пошти;
// клієнт вибрав місто — повертаємо список відділень/поштоматів цього міста.
//
// Навмисно НЕ використовує supaFetch/getToken (checkout доступний гостям без
// токена) — лише npCall із спільного _lib/np.js, тому NOVA_POSHTA_API_KEY
// ніколи не потрапляє у відповідь клієнту.
const { npCall } = require('./_lib/np');

const MIN_QUERY_LEN = 2;

async function handleCities(url, res) {
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < MIN_QUERY_LEN) {
    res.status(200).json({ items: [] });
    return;
  }
  const data = await npCall('Address', 'getCities', { FindByString: q, Limit: '20' });
  const items = (data || []).map(c => ({
    ref: c.Ref,
    name: c.Description,
    area: c.AreaDescription || '',
    region: c.SettlementTypeDescription || ''
  }));
  res.status(200).json({ items });
}

async function handleWarehouses(url, res) {
  const cityRef = (url.searchParams.get('cityRef') || '').trim();
  const q = (url.searchParams.get('q') || '').trim();
  if (!cityRef) {
    res.status(200).json({ items: [] });
    return;
  }
  const props = { CityRef: cityRef, Limit: q ? '100' : '50' };
  if (q) props.FindByString = q;
  const data = await npCall('Address', 'getWarehouses', props);
  const items = (data || []).map(w => ({
    ref: w.Ref,
    name: w.Description,
    number: w.Number || '',
    isPostomat: w.CategoryOfWarehouse === 'Postomat' || /поштомат/i.test(w.TypeOfWarehouse || '') || /поштомат/i.test(w.Description || '')
  }));
  res.status(200).json({ items });
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://internal');
    const type = url.searchParams.get('type');
    res.setHeader('Cache-Control', 'private, no-store');

    if (type === 'cities') {
      await handleCities(url, res);
    } else if (type === 'warehouses') {
      await handleWarehouses(url, res);
    } else {
      res.status(400).json({ error: 'bad_type' });
    }
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String(err && err.message || err) });
  }
};
