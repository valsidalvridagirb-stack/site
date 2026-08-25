// Instagram-стрічка на головній сторінці — /api/instagram-feed.
//
// Ходить у Instagram Graph API ("Instagram API with Instagram Login")
// довгостроковим токеном власника акаунту й повертає 6 останніх постів
// (фото/обкладинка + посилання на сам пост). Токен і ID акаунту — окремі
// змінні середовища на Vercel (INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_USER_ID),
// у браузер не потрапляють ніколи — фронтенд ходить лише сюди, а не напряму
// в Instagram.
//
// ВАЖЛИВО про токен: довгостроковий токен Instagram живе 60 днів і має
// оновлюватись раніше, ніж спливе (інакше стрічка на сайті просто зникне,
// поки не вписати новий токен вручну в змінні середовища на Vercel).
const IG_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_USER_ID = process.env.INSTAGRAM_USER_ID;

module.exports = async (req, res) => {
  // Якщо токен ще не налаштований — не ламаємо сторінку, просто повертаємо
  // порожній масив; фронтенд у такому разі ховає секцію на сторінці.
  if (!IG_ACCESS_TOKEN || !IG_USER_ID) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).json([]);
    return;
  }

  try {
    const url = `https://graph.instagram.com/${encodeURIComponent(IG_USER_ID)}/media` +
      `?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp` +
      `&limit=6&access_token=${encodeURIComponent(IG_ACCESS_TOKEN)}`;

    const r = await fetch(url);
    const data = await r.json();

    if (!r.ok || !Array.isArray(data.data)) {
      throw new Error((data && data.error && data.error.message) || `Instagram API -> ${r.status}`);
    }

    const posts = data.data
      // VIDEO не має придатного для картинки media_url — беремо thumbnail_url;
      // якщо його теж немає (буває для деяких старих відео), пропускаємо пост.
      .map(p => ({
        permalink: p.permalink,
        image: p.media_type === 'VIDEO' ? (p.thumbnail_url || null) : p.media_url,
        thumbnail: p.thumbnail_url || (p.media_type === 'VIDEO' ? null : p.media_url)
      }))
      .filter(p => p.permalink && (p.image || p.thumbnail))
      .slice(0, 6);

    // Кешуємо на 30 хвилин — Instagram Graph API має ліміти на кількість
    // запитів, а стрічка не мусить бути секундно-актуальною.
    res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600');
    res.status(200).json(posts);
  } catch (err) {
    // Помилка (протух токен, ліміти API тощо) — не валимо сторінку, просто
    // порожня відповідь, фронтенд ховає секцію. Деталі помилки лишаються
    // тільки в логах Vercel для діагностики.
    console.error('instagram-feed error:', err && err.message || err);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(200).json([]);
  }
};
