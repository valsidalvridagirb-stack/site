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
  // '500' — максимум відділень за ОДИН виклик, який приймає Нова Пошта.
  // Великі міста (Київ, Харків, Одеса, Дніпро) мають більше 500 точок разом
  // із поштоматами, тому одного виклику замало — гортаємо сторінки (Page),
  // поки НП не поверне менше за Limit (це і є ознака останньої сторінки).
  // Обмеження в 5 сторінок (=2500 точок) — з запасом покриває навіть Київ
  // (найбільше місто за кількістю відділень+поштоматів в Україні), і водночас
  // не дає запиту "зависнути", гортаючи сторінки в нескінченність.
  const MAX_PAGES = 5;
  let all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const props = { CityRef: cityRef, Limit: '500', Page: String(page) };
    if (q) props.FindByString = q;
    const chunk = await npCall('Address', 'getWarehouses', props);
    if (!chunk || !chunk.length) break;
    all = all.concat(chunk);
    if (chunk.length < 500) break; // остання сторінка
  }
  const items = all.map(w => ({
    ref: w.Ref,
    name: w.Description,
    number: w.Number ? parseInt(w.Number, 10) : null,
    isPostomat: w.CategoryOfWarehouse === 'Postomat' || /поштомат/i.test(w.TypeOfWarehouse || '') || /поштомат/i.test(w.Description || '')
  }));
  // Сортуємо: спершу звичайні відділення за зростанням номера, потім поштомати —
  // щоб великий список було зручно гортати, а не бачити хаотичний порядок від API.
  items.sort((a, b) => {
    if (a.isPostomat !== b.isPostomat) return a.isPostomat ? 1 : -1;
    if (a.number == null && b.number == null) return 0;
    if (a.number == null) return 1;
    if (b.number == null) return -1;
    return a.number - b.number;
  });
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
