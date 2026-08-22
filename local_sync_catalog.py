#!/usr/bin/env python3
"""
local_sync_catalog.py — незалежний від Claude аналог тригера
"Каталог NexxtLevel: sync щогодини". Запускається ЛОКАЛЬНО на комп'ютері
власника (напр. через Windows Task Scheduler), одразу після update.py,
і робить те саме, що робив Claude-тригер, але напряму:

  1. Бере останній catalog_*.xlsx з локальної теки (тієї самої, куди
     update.py вже його зберігає — Google Drive тут навіть не потрібен,
     бо файл і так лежить локально ДО того, як update.py копіює його в Drive).
  2. Оновлює price/quantity вже опублікованих товарів напряму в Supabase
     через REST API (сервісний ключ, в обхід RLS).
  2b. Додає нові розміри, які з'явились у постачальника для вже опублікованого
      артикулу (копіює name/description/photos/size_chart_gender з уже
      наявного рядка того ж артикулу). НІКОЛИ не публікує товар, якого на
      сайті ще немає взагалі (жодного розміру) — це лишається ручним через
      адмінку. НЕ повертає розмір, вручну прибраний адміном (excluded_sizes).
  2c. Ціну розміру, яку адмін вручну поправив у адмінці (таблиця
      price_overrides — "Ціна з прайсу постачальника — можна змінити
      вручну"), НЕ перезаписує ціною з нового прайсу постачальника —
      залишок (quantity) для нього все одно оновлюється/обнуляється як
      завжди.
  2d. Товари, додані в адмінці кнопкою "Створити товар вручну" (мітка
      products.supplier == "manual" — таких немає в жодному прайсі
      постачальника), повністю ІГНОРУЮТЬСЯ цим скриптом: не оновлюється
      ціна/кількість, не обнуляються, і їм не додаються нові розміри з
      прайсу. Адмін керує ними сам через адмінку.
  3. Перезбирає api/_data/excel-catalog.json (каталог для пошуку в адмінці)
     і заливає його в GitHub напряму через Contents API — БЕЗ git, БЕЗ
     Claude, і тому в обхід поточного бага з git-проксі на боці Anthropic.

Налаштування — через змінні середовища (нічого не хардкодиться і нічого
секретного не потрапляє в git):

    SUPABASE_SERVICE_ROLE_KEY   сервісний ключ Supabase (Project Settings -> API)
    GITHUB_PAT                  токен з правом запису у репозиторій (той самий,
                                 що вже використовується для сайту, або новий)
    CATALOG_DIR                 тека з catalog_*.xlsx (типово: C:\\catalog_update)
    GITHUB_REPO                 "власник/репозиторій" (типово: valsidalvridagirb-stack/site)

Найпростіше — покласти ці 4 значення у файл local_sync_catalog.env поруч
зі скриптом (формат KEY=value, по одному на рядок) — скрипт підхопить
його автоматично, якщо він існує.

Встановлення залежностей (один раз):
    pip install requests openpyxl

Запуск вручну для перевірки:
    python local_sync_catalog.py

Далі — постав у Windows Task Scheduler на потрібний інтервал (наприклад,
раз на годину, чи одразу після завдання, що запускає update.py).
"""

import base64
import glob
import json
import os
import sys
from datetime import datetime, timezone

try:
    import requests
except ImportError:
    print("ERROR: не встановлено 'requests'. Виконай: pip install requests openpyxl")
    sys.exit(1)

try:
    import openpyxl
except ImportError:
    print("ERROR: не встановлено 'openpyxl'. Виконай: pip install requests openpyxl")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Конфіг
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(SCRIPT_DIR, "local_sync_catalog.env")

if os.path.exists(ENV_FILE):
    with open(ENV_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

SUPABASE_URL = "https://jkwppbriklmxbivndxeq.supabase.co"
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
GITHUB_PAT = os.environ.get("GITHUB_PAT", "")
CATALOG_DIR = os.environ.get("CATALOG_DIR", r"C:\catalog_update")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "valsidalvridagirb-stack/site")
GITHUB_BRANCH = os.environ.get("GITHUB_BRANCH", "main")
CATALOG_JSON_PATH = "api/_data/excel-catalog.json"

REQUIRED_COLUMNS = [
    "Артикул", "Назва", "Розмір", "Дроп ціна (грн)", "Роздрібна ціна (грн)", "Кількість",
    "Бренд", "Стать", "Категорія 1", "Категорія 2", "Категорія 3", "Постачальник",
]


def log(msg):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"[{ts}] {msg}")


def fail(msg):
    log(f"ПОМИЛКА: {msg}")
    sys.exit(1)


# ---------------------------------------------------------------------------
# 1. Знаходимо останній xlsx
# ---------------------------------------------------------------------------

def find_latest_catalog_file():
    pattern = os.path.join(CATALOG_DIR, "catalog_*.xlsx")
    files = glob.glob(pattern)
    if not files:
        fail(f"Не знайдено жодного файлу за шаблоном {pattern}")
    latest = max(files, key=os.path.getmtime)
    log(f"Останній файл каталогу: {latest} (змінено {datetime.fromtimestamp(os.path.getmtime(latest))})")
    return latest


def parse_catalog_xlsx(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    header = next(rows_iter)
    idx = {h: i for i, h in enumerate(header)}

    missing = [c for c in REQUIRED_COLUMNS if c not in idx]
    if missing:
        fail(f"У файлі відсутні очікувані колонки: {missing}. Наявні: {list(header)}")

    catalog_rows = []
    seen = set()
    skipped_dupe = 0
    skipped_bad = 0

    for r in rows_iter:
        art = str(r[idx["Артикул"]] or "").strip()
        size = str(r[idx["Розмір"]] or "").strip()
        if not art or not size:
            skipped_bad += 1
            continue

        name = str(r[idx["Назва"]] or "").strip()
        price_raw = r[idx["Роздрібна ціна (грн)"]]
        drop_price_raw = r[idx["Дроп ціна (грн)"]]
        qty_raw = r[idx["Кількість"]]
        brand = str(r[idx["Бренд"]] or "").strip()
        gender = str(r[idx["Стать"]] or "").strip()
        cat1 = str(r[idx["Категорія 1"]] or "").strip()
        cat2 = str(r[idx["Категорія 2"]] or "").strip()
        cat3 = str(r[idx["Категорія 3"]] or "").strip()
        supplier = str(r[idx["Постачальник"]] or "").strip()

        try:
            price_n = float(price_raw) if price_raw not in (None, "") else None
            qty_n = int(qty_raw) if qty_raw not in (None, "") else 0
        except (TypeError, ValueError):
            skipped_bad += 1
            continue

        if price_n is None:
            skipped_bad += 1
            continue

        # Дроп (закупівельна) ціна — не блокує публікацію товару, якщо
        # порожня/бита: просто не потрапить в product_costs цим рядком.
        try:
            drop_price_n = float(drop_price_raw) if drop_price_raw not in (None, "") else None
        except (TypeError, ValueError):
            drop_price_n = None

        key = (art.lower(), size)
        if key in seen:
            skipped_dupe += 1
            continue
        seen.add(key)

        catalog_rows.append([art, size, name, price_n, qty_n, brand, gender, cat1, cat2, cat3, supplier, drop_price_n])

    log(f"Розпарсено {len(catalog_rows)} рядків (пропущено {skipped_dupe} дублів, {skipped_bad} биті рядки)")
    return catalog_rows


# ---------------------------------------------------------------------------
# 2. Supabase REST (сервісний ключ, в обхід RLS)
# ---------------------------------------------------------------------------

def supa_headers(extra=None):
    h = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def fetch_current_products():
    # Повний набір полів — name/description/photos/size_chart_gender потрібні
    # як шаблон при вставці нового розміру для вже опублікованого артикулу.
    # extra_categories додано разом з gender/category_1/2/3 у шаблон нижче —
    # це ручні виправлення з адмінки (стать, тип товару, кілька категорій
    # одразу), які мають лишатись такими ж і для нових розмірів того самого
    # артикулу, а не братись заново з фіда постачальника.
    url = f"{SUPABASE_URL}/rest/v1/products"
    params = {"select": "id,articul,size,price,quantity,name,description,photos,"
                         "brand,gender,category_1,category_2,category_3,supplier,size_chart_gender,"
                         "extra_categories"}
    r = requests.get(url, headers=supa_headers(), params=params, timeout=60)
    if not r.ok:
        fail(f"Не вдалось отримати products з Supabase: {r.status_code} {r.text[:300]}")
    return r.json()


def fetch_excluded_sizes():
    url = f"{SUPABASE_URL}/rest/v1/excluded_sizes"
    params = {"select": "articul,size"}
    r = requests.get(url, headers=supa_headers(), params=params, timeout=30)
    if not r.ok:
        fail(f"Не вдалось отримати excluded_sizes з Supabase: {r.status_code} {r.text[:300]}")
    return r.json()


def fetch_price_overrides():
    url = f"{SUPABASE_URL}/rest/v1/price_overrides"
    params = {"select": "articul,size,price"}
    r = requests.get(url, headers=supa_headers(), params=params, timeout=30)
    if not r.ok:
        fail(f"Не вдалось отримати price_overrides з Supabase: {r.status_code} {r.text[:300]}")
    return r.json()


def apply_updates(updates):
    ok = 0
    for u in updates:
        url = f"{SUPABASE_URL}/rest/v1/products"
        params = {"id": f"eq.{u['id']}"}
        body = {"price": u["new_price"], "quantity": u["new_qty"]}
        r = requests.patch(
            url, headers=supa_headers({"Prefer": "return=minimal"}),
            params=params, json=body, timeout=30,
        )
        if not r.ok:
            log(f"  ! не вдалось оновити id={u['id']} ({u['articul']}/{u['size']}): {r.status_code} {r.text[:200]}")
            continue
        ok += 1
    return ok


def insert_new_sizes(rows):
    if not rows:
        return 0
    url = f"{SUPABASE_URL}/rest/v1/products"
    r = requests.post(
        url, headers=supa_headers({"Prefer": "return=minimal"}),
        json=rows, timeout=30,
    )
    if not r.ok:
        log(f"  ! не вдалось додати нові розміри: {r.status_code} {r.text[:300]}")
        return 0
    return len(rows)


def upsert_product_costs(cost_rows):
    # Дроп (закупівельна) ціна -> ОКРЕМА таблиця product_costs, не products —
    # вона недоступна анонімному ключу сайту, тільки сервісному (яким і
    # виконується цей запит). upsert по (articul, size) через
    # Prefer: resolution=merge-duplicates + on_conflict.
    if not cost_rows:
        return 0
    url = f"{SUPABASE_URL}/rest/v1/product_costs"
    params = {"on_conflict": "articul,size"}
    chunk_size = 500
    ok = 0
    for i in range(0, len(cost_rows), chunk_size):
        chunk = cost_rows[i:i + chunk_size]
        r = requests.post(
            url, headers=supa_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
            params=params, json=chunk, timeout=30,
        )
        if not r.ok:
            log(f"  ! не вдалось оновити дроп-ціни (чанк {i}-{i + len(chunk)}): {r.status_code} {r.text[:300]}")
            continue
        ok += len(chunk)
    return ok


# ---------------------------------------------------------------------------
# 3. GitHub Contents API (без git, напряму по HTTPS)
# ---------------------------------------------------------------------------

def github_headers():
    return {
        "Authorization": f"Bearer {GITHUB_PAT}",
        "Accept": "application/vnd.github+json",
    }


def push_catalog_json_to_github(catalog_json_str):
    api_url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{CATALOG_JSON_PATH}"

    r = requests.get(api_url, headers=github_headers(), params={"ref": GITHUB_BRANCH}, timeout=30)
    if not r.ok:
        fail(f"Не вдалось прочитати поточний {CATALOG_JSON_PATH} з GitHub: {r.status_code} {r.text[:300]}")
    current_sha = r.json()["sha"]

    new_content_b64 = base64.b64encode(catalog_json_str.encode("utf-8")).decode("ascii")
    body = {
        "message": f"Auto-sync catalog {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ')} (local)",
        "content": new_content_b64,
        "sha": current_sha,
        "branch": GITHUB_BRANCH,
    }
    r = requests.put(api_url, headers=github_headers(), json=body, timeout=30)
    if not r.ok:
        fail(f"Не вдалось запушити {CATALOG_JSON_PATH} у GitHub: {r.status_code} {r.text[:300]}")
    log(f"excel-catalog.json оновлено в GitHub ({GITHUB_REPO}@{GITHUB_BRANCH}). Vercel задеплоїть за 1-2 хв.")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    if not SUPABASE_SERVICE_ROLE_KEY:
        fail("SUPABASE_SERVICE_ROLE_KEY не задано (env або local_sync_catalog.env)")
    if not GITHUB_PAT:
        fail("GITHUB_PAT не задано (env або local_sync_catalog.env)")

    xlsx_path = find_latest_catalog_file()
    catalog_rows = parse_catalog_xlsx(xlsx_path)

    # УВАГА: catalog_rows тепер має 12-й елемент (drop_price) — у публічний
    # excel-catalog.json (доступний зі звичайного браузера через адмінку)
    # він потрапляти НЕ повинен, тому явно обрізаємо до перших 11 полів.
    catalog_json = {
        "cols": ["art", "size", "name", "price", "qty", "brand", "gender", "cat1", "cat2", "cat3", "supplier"],
        "rows": [row[:11] for row in catalog_rows],
    }
    catalog_json_str = json.dumps(catalog_json, ensure_ascii=False, separators=(",", ":"))

    lookup = {}
    cost_rows = []
    for row in catalog_rows:
        art, size, _name, price_n, qty_n = row[0], row[1], row[2], row[3], row[4]
        lookup[(art.lower(), str(size))] = (price_n, qty_n)
        drop_price_n = row[11]
        if drop_price_n is not None:
            cost_rows.append({"articul": art, "size": size, "drop_price": drop_price_n})

    current_products = fetch_current_products()
    log(f"У Supabase зараз опубліковано {len(current_products)} позицій")

    # Товари, додані вручну в адмінці (кнопка "Створити товар вручну", мітка
    # supplier == "manual") — їх немає в жодному прайсі постачальника за
    # визначенням, тому цей скрипт узагалі їх не розглядає: ні для оновлення
    # ціни/кількості, ні для обнулення "зниклого" товару, ні як шаблон для
    # додавання нових розмірів. Адмін керує ними сам, повністю окремо.
    manual_products = [p for p in current_products if str(p.get("supplier") or "").strip().lower() == "manual"]
    manual_ids = {p["id"] for p in manual_products}
    auto_products = [p for p in current_products if p["id"] not in manual_ids]
    if manual_products:
        log(f"Пропускаю {len(manual_products)} ручних товарів (supplier=manual) — керуються тільки через адмінку")

    price_overrides = fetch_price_overrides()
    price_override_map = {
        (str(o["articul"]).lower(), str(o["size"])): float(o["price"])
        for o in price_overrides
    }

    updates = []
    gone = []
    price_locked_qty_updates = 0
    for p in auto_products:
        key = (str(p["articul"]).lower(), str(p["size"]))
        if key not in lookup:
            gone.append(p)
            continue
        catalog_price, new_qty = lookup[key]
        old_price = float(p["price"])
        old_qty = int(p["quantity"])
        # Ціна, задана адміном вручну (price_overrides) — не перезаписуємо
        # її ціною з прайсу постачальника, лишень оновлюємо залишок.
        new_price = old_price if key in price_override_map else catalog_price
        if abs(new_price - old_price) > 0.01 or new_qty != old_qty:
            if key in price_override_map and new_qty != old_qty:
                price_locked_qty_updates += 1
            updates.append({
                "id": p["id"], "articul": p["articul"], "size": p["size"],
                "new_price": new_price, "new_qty": new_qty,
            })

    log(f"Потребують оновлення ціни/залишку: {len(updates)}")
    if price_override_map:
        log(f"{len(price_override_map)} розмір(ів) мають ручну ціну (price_overrides) — "
            f"ціна постачальника ігнорується для них, оновлюється лише залишок "
            f"({price_locked_qty_updates} з них отримали оновлення залишку цього разу)")

    zeroed = []
    if gone:
        gone_ratio = len(gone) / max(len(auto_products), 1)
        # Захист від хибного обнулення при збої парсингу фіду постачальника:
        # якщо "зниклих" забагато відносно всього каталогу — це, швидше за все,
        # проблема з фідом/файлом, а не реальне вимкнення позицій з продажу.
        safe_to_zero = len(gone) <= 50 or gone_ratio <= 0.1
        sample = ", ".join(f"{g['articul']}/{g['size']}" for g in gone[:10])
        if safe_to_zero:
            for g in gone:
                if int(g["quantity"]) != 0:
                    zeroed.append({
                        "id": g["id"], "articul": g["articul"], "size": g["size"],
                        "new_price": float(g["price"]), "new_qty": 0,
                    })
            log(f"{len(gone)} опублікованих товарів більше немає у прайсі постачальників — "
                f"обнуляю залишок (зникають з сайту, з бази не видаляю): "
                f"{sample}{'...' if len(gone) > 10 else ''}")
        else:
            log(f"УВАГА: {len(gone)} опублікованих товарів більше немає у прайсі постачальників "
                f"— це {gone_ratio:.0%} каталогу, схоже на збій парсингу файлу/фіду, тому "
                f"залишки НЕ чіпаю (перевір catalog_*.xlsx вручну): "
                f"{sample}{'...' if len(gone) > 10 else ''}")

    if updates:
        ok = apply_updates(updates)
        log(f"Оновлено в Supabase: {ok}/{len(updates)}")
    else:
        log("Оновлень ціни/залишку немає.")

    if zeroed:
        ok = apply_updates(zeroed)
        log(f"Обнулено залишок (товар зник у постачальника): {ok}/{len(zeroed)}")

    # --- нові розміри для вже опублікованих артикулів ---
    excluded_sizes = fetch_excluded_sizes()
    excluded_keys = {(str(e["articul"]).lower(), str(e["size"])) for e in excluded_sizes}

    # Тільки auto_products (не ручні) — товар, доданий вручну, ніколи не
    # використовується як шаблон і його артикул не вважається "вже
    # опублікованим" для цілей додавання нових розмірів з прайсу постачальника
    # (навіть якщо артикул випадково збігся б з чимось у прайсі).
    existing_keys = set()
    existing_articuls = set()
    template_by_articul = {}
    for p in auto_products:
        al = str(p["articul"]).lower()
        existing_keys.add((al, str(p["size"])))
        existing_articuls.add(al)
        if al not in template_by_articul:
            template_by_articul[al] = p

    new_size_rows = []
    new_size_labels = []
    skipped_excluded = []
    for row in catalog_rows:
        art, size, _name, price_n, qty_n, brand, gender, cat1, cat2, cat3, supplier, _drop_price = row
        key = (art.lower(), str(size))
        if key in existing_keys:
            continue  # вже опублікований розмір — покривається апдейтом ціни/залишку вище
        if art.lower() not in existing_articuls:
            continue  # артикулу взагалі немає на сайті — новий товар публікуємо тільки вручну
        if key in excluded_keys:
            skipped_excluded.append(f"{art}/{size}")
            continue
        t = template_by_articul[art.lower()]
        new_size_rows.append({
            "articul": t.get("articul", art),
            "name": t.get("name"),
            "size": size,
            "price": price_n,
            "quantity": qty_n,
            "brand": brand,
            # gender/category_1/2/3 — з ШАБЛОНУ (вже опублікованого рядка того ж
            # артикулу), а не з фіда постачальника: адмінка могла вручну
            # виправити помилкову стать/категорію (напр. "Черевики" замість
            # "Кросівки"), і новий розмір має лишатись консистентним з рештою
            # розмірів товару, а не відкочуватись назад до сирого значення
            # постачальника. Раніше тут помилково бралось "живе" значення з
            # фіда — виправлено разом з додаванням extra_categories нижче.
            "gender": t.get("gender", gender),
            "category_1": t.get("category_1", cat1),
            "category_2": t.get("category_2", cat2),
            "category_3": t.get("category_3", cat3),
            "description": t.get("description"),
            "photos": t.get("photos"),
            "supplier": supplier,
            "size_chart_gender": t.get("size_chart_gender"),
            "extra_categories": t.get("extra_categories"),
        })
        new_size_labels.append(f"{art}/{size}")

    if new_size_rows:
        ok = insert_new_sizes(new_size_rows)
        sample = ", ".join(new_size_labels[:10]) + ("..." if len(new_size_labels) > 10 else "")
        log(f"Додано нових розмірів: {ok}/{len(new_size_rows)} ({sample})")
    else:
        log("Нових розмірів немає.")
    if skipped_excluded:
        sample = ", ".join(skipped_excluded[:10]) + ("..." if len(skipped_excluded) > 10 else "")
        log(f"Пропущено як вручну прибрані (excluded_sizes): {len(skipped_excluded)} ({sample})")

    push_catalog_json_to_github(catalog_json_str)

    if cost_rows:
        ok = upsert_product_costs(cost_rows)
        log(f"Дроп-цін оновлено в product_costs: {ok}/{len(cost_rows)}")
    else:
        log("Дроп-цін у файлі не знайдено — product_costs не чіпаю.")

    log("Готово.")


if __name__ == "__main__":
    main()
