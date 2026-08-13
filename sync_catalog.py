#!/usr/bin/env python3
"""
sync_catalog.py — синхронізує api/_data/excel-catalog.json (каталог для пошуку
в адмінці) та готує SQL-запити для (1) оновлення price/quantity вже
опублікованих на сайті товарів і (2) додавання нових розмірів, які
з'явились у постачальника для вже опублікованого артикулу — на основі
актуального catalog_*.xlsx з Google Drive (генерується локальним update.py
на комп'ютері власника сайту).

Джерело даних (Роздрібна ціна, категорії, дедублікація) вже повністю прораховане
update.py — цей скрипт нічого не перераховує заново, тільки перекладає формат
і порівнює з тим, що вже є в Supabase.

ВАЖЛИВО (свідоме обмеження, не чіпати без окремого запиту власника):
- Скрипт НІКОЛИ не публікує товар, якого зараз немає на сайті взагалі (жодного
  розміру) — це та дія, яка вимагає фото/опису і лишається ручною через
  адмінку. Він лише додає розміри до артикулів, які вже мають хоча б один
  опублікований розмір, копіюючи їхні фото/опис/назву/перевизначення
  розмірної сітки з уже наявного рядка того ж артикулу.
- Розмір, який адмін вручну прибрав через excluded_sizes, НЕ повертається
  автоматично, навіть якщо він знов з'явився в прайсі постачальника.
- Розмір, який зник із прайсу постачальника, НЕ видаляється і не ховається —
  лишається на сайті як є (тільки попередження в підсумку).

Використання:
    python3 sync_catalog.py \
        --catalog-tool-result <path-to-download_file_content-json> \
        --repo <path-to-site-checkout> \
        --current-products-json <path-to-json-[{id,articul,size,price,quantity,name,description,photos,brand,gender,category_1,category_2,category_3,supplier,size_chart_gender}]> \
        --excluded-sizes-json <path-to-json-[{articul,size}]> \
        --sql-out <path-to-write-generated-UPDATE/INSERT-statements>

Виводить у stdout короткий текстовий підсумок (кількість рядків, кількість
оновлень, кількість доданих розмірів) — саме це агент показує користувачу.
"""

import argparse
import base64
import json
import sys
from datetime import datetime, timezone

import openpyxl

REQUIRED_COLUMNS = [
    'Артикул', 'Назва', 'Розмір', 'Роздрібна ціна (грн)', 'Кількість',
    'Бренд', 'Стать', 'Категорія 1', 'Категорія 2', 'Категорія 3', 'Постачальник',
]

# Колонки products, які беремо з ШАБЛОННОГО (вже опублікованого) рядка того ж
# артикулу при вставці нового розміру — вони мають бути однакові для всіх
# розмірів одного товару (так їх завжди писала адмінка при публікації).
# gender/category_1/2/3 тут навмисно, а не з фіда постачальника: адмінка
# дозволяє вручну виправити помилкову стать/категорію постачальника
# (напр. жіночі кросівки, позначені постачальником як чоловічі) — без цього
# новий розмір того ж артикулу, що з'явився пізніше, знову підхопив би
# помилкове значення з прайсу і розійшовся б з рештою розмірів товару.
TEMPLATE_FIELDS = ['name', 'description', 'photos', 'size_chart_gender',
                    'gender', 'category_1', 'category_2', 'category_3']


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--catalog-tool-result', required=True,
                    help='Шлях до JSON-файлу з результатом mcp__Google_Drive__download_file_content '
                         '(містить base64 вміст xlsx у полі "content")')
    p.add_argument('--repo', required=True, help='Шлях до чекауту репозиторію сайту')
    p.add_argument('--current-products-json', required=True,
                    help='Шлях до JSON-масиву поточного стану таблиці products у Supabase '
                         '(id, articul, size, price, quantity + name, description, photos, brand, '
                         'gender, category_1/2/3, supplier, size_chart_gender)')
    p.add_argument('--excluded-sizes-json', required=True,
                    help='Шлях до JSON-масиву [{"articul":.., "size":..}] — вміст таблиці excluded_sizes')
    p.add_argument('--sql-out', required=True,
                    help='Куди записати згенеровані UPDATE/INSERT-запити (порожній файл, якщо нічого робити)')
    p.add_argument('--tmp-xlsx', default='/tmp/_sync_catalog_source.xlsx')
    return p.parse_args()


def load_catalog_xlsx(tool_result_path, tmp_xlsx_path):
    with open(tool_result_path, encoding='utf-8') as f:
        d = json.load(f)
    if 'content' not in d:
        print(f'[sync] ERROR: unexpected tool-result format, keys={list(d.keys())}')
        sys.exit(1)
    data = base64.b64decode(d['content'])
    with open(tmp_xlsx_path, 'wb') as out:
        out.write(data)
    return d.get('title', '(unknown)')


def load_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def sql_str(v):
    """SQL-літерал для text/nullable-text колонки: NULL або 'екрановане значення'."""
    if v is None:
        return 'NULL'
    s = str(v)
    if s == '':
        return 'NULL' if s is None else "''"
    return "'" + s.replace("'", "''") + "'"


def main():
    args = parse_args()

    title = load_catalog_xlsx(args.catalog_tool_result, args.tmp_xlsx)
    print(f'[sync] Джерело: {title}')

    wb = openpyxl.load_workbook(args.tmp_xlsx, read_only=True, data_only=True)
    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    header = next(rows_iter)
    idx = {h: i for i, h in enumerate(header)}

    missing = [c for c in REQUIRED_COLUMNS if c not in idx]
    if missing:
        print(f'[sync] ERROR: у файлі відсутні очікувані колонки: {missing}')
        print(f'[sync]        наявні колонки: {list(header)}')
        sys.exit(1)

    catalog_rows = []
    seen = set()
    skipped_dupe = 0
    skipped_bad = 0

    for r in rows_iter:
        art = str(r[idx['Артикул']] or '').strip()
        size = str(r[idx['Розмір']] or '').strip()
        if not art or not size:
            skipped_bad += 1
            continue

        name = str(r[idx['Назва']] or '').strip()
        price_raw = r[idx['Роздрібна ціна (грн)']]
        qty_raw = r[idx['Кількість']]
        brand = str(r[idx['Бренд']] or '').strip()
        gender = str(r[idx['Стать']] or '').strip()
        cat1 = str(r[idx['Категорія 1']] or '').strip()
        cat2 = str(r[idx['Категорія 2']] or '').strip()
        cat3 = str(r[idx['Категорія 3']] or '').strip()
        supplier = str(r[idx['Постачальник']] or '').strip()

        try:
            price_n = float(price_raw) if price_raw not in (None, '') else None
            qty_n = int(qty_raw) if qty_raw not in (None, '') else 0
        except (TypeError, ValueError):
            skipped_bad += 1
            continue

        if price_n is None:
            skipped_bad += 1
            continue

        key = (art.lower(), size)
        if key in seen:
            skipped_dupe += 1
            continue
        seen.add(key)

        catalog_rows.append({
            'art': art, 'size': size, 'name': name, 'price': price_n, 'qty': qty_n,
            'brand': brand, 'gender': gender, 'cat1': cat1, 'cat2': cat2, 'cat3': cat3,
            'supplier': supplier,
        })

    print(f'[sync] Розпарсено {len(catalog_rows)} рядків каталогу '
          f'(пропущено {skipped_dupe} дублів, {skipped_bad} биті рядки)')

    # --- 1. Перезбираємо excel-catalog.json (каталог для пошуку в адмінці) ---
    catalog_json = {
        'cols': ['art', 'size', 'name', 'price', 'qty', 'brand', 'gender', 'cat1', 'cat2', 'cat3', 'supplier'],
        'rows': [[c['art'], c['size'], c['name'], c['price'], c['qty'], c['brand'], c['gender'],
                  c['cat1'], c['cat2'], c['cat3'], c['supplier']] for c in catalog_rows],
    }
    out_path = f'{args.repo}/api/_data/excel-catalog.json'
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(catalog_json, f, ensure_ascii=False, separators=(',', ':'))
    print(f'[sync] Записано {out_path}')

    # --- 2. Порівнюємо з уже опублікованими на сайті товарами (Supabase) ---
    current_products = load_json(args.current_products_json)
    excluded_sizes = load_json(args.excluded_sizes_json)

    lookup = {(c['art'].lower(), str(c['size'])): c for c in catalog_rows}

    existing_keys = set()
    existing_articuls = set()
    template_by_articul = {}
    for p in current_products:
        art_l = str(p['articul']).lower()
        existing_keys.add((art_l, str(p['size'])))
        existing_articuls.add(art_l)
        if art_l not in template_by_articul:
            template_by_articul[art_l] = p

    excluded_keys = {(str(e['articul']).lower(), str(e['size'])) for e in excluded_sizes}

    # --- 2a. Ціна/залишок для розмірів, які вже опубліковані ---
    updates = []
    gone = []
    for p in current_products:
        key = (str(p['articul']).lower(), str(p['size']))
        c = lookup.get(key)
        if c is None:
            gone.append(p)
            continue
        new_price, new_qty = c['price'], c['qty']
        old_price = float(p['price'])
        old_qty = int(p['quantity'])
        if abs(new_price - old_price) > 0.01 or new_qty != old_qty:
            updates.append({
                'id': p['id'], 'articul': p['articul'], 'size': p['size'],
                'old_price': old_price, 'new_price': new_price,
                'old_qty': old_qty, 'new_qty': new_qty,
            })

    print(f'[sync] {len(updates)} товарів потребують оновлення ціни/залишку '
          f'з {len(current_products)} опублікованих')
    if gone:
        print(f'[sync] УВАГА: {len(gone)} опублікованих товарів більше немає в каталозі '
              f'постачальників (ціну/залишок НЕ чіпаємо, товар лишається на сайті як є): '
              + ', '.join(f"{g['articul']}/{g['size']}" for g in gone[:20])
              + ('...' if len(gone) > 20 else ''))

    # --- 2b. Нові розміри для вже опублікованих артикулів ---
    new_sizes = []
    skipped_excluded = []
    for c in catalog_rows:
        key = (c['art'].lower(), c['size'])
        if key in existing_keys:
            continue  # вже опублікований розмір — покривається апдейтом ціни/залишку вище
        if c['art'].lower() not in existing_articuls:
            continue  # артикулу взагалі немає на сайті — новий товар публікуємо тільки вручну
        if key in excluded_keys:
            skipped_excluded.append(c)
            continue
        template = template_by_articul[c['art'].lower()]
        new_sizes.append({'catalog': c, 'template': template})

    print(f'[sync] {len(new_sizes)} нових розмірів з\'явилось у вже опублікованих товарів')
    if skipped_excluded:
        print(f'[sync] {len(skipped_excluded)} розмірів пропущено — вручну прибрані адміном '
              f'(excluded_sizes), не повертаємо автоматично: '
              + ', '.join(f"{s['art']}/{s['size']}" for s in skipped_excluded[:20])
              + ('...' if len(skipped_excluded) > 20 else ''))

    # --- 3. Формуємо SQL ---
    sql_lines = []

    if updates:
        sql_lines.append('-- оновлення ціни/залишку вже опублікованих розмірів')
        for u in updates:
            sql_lines.append(
                f"UPDATE products SET price = {u['new_price']}, quantity = {u['new_qty']} "
                f"WHERE id = {u['id']};"
            )

    if new_sizes:
        sql_lines.append('-- нові розміри вже опублікованих товарів')
        cols = ['articul', 'name', 'size', 'price', 'quantity', 'brand', 'gender',
                'category_1', 'category_2', 'category_3', 'description', 'photos',
                'supplier', 'size_chart_gender']
        for item in new_sizes:
            c, t = item['catalog'], item['template']
            values = {
                'articul': sql_str(t.get('articul', c['art'])),
                'name': sql_str(t.get('name')),
                'size': sql_str(c['size']),
                'price': c['price'],
                'quantity': c['qty'],
                'brand': sql_str(c['brand']),
                # gender/category_1/2/3 — з ШАБЛОНУ (вже опублікованого рядка
                # цього ж артикулу), а не з фіда постачальника: адмінка могла
                # вручну виправити помилкову стать/категорію, і новий розмір
                # має лишатись консистентним з рештою розмірів товару.
                'gender': sql_str(t.get('gender', c['gender'])),
                'category_1': sql_str(t.get('category_1', c['cat1'])),
                'category_2': sql_str(t.get('category_2', c['cat2'])),
                'category_3': sql_str(t.get('category_3', c['cat3'])),
                'description': sql_str(t.get('description')),
                'photos': sql_str(t.get('photos')),
                'supplier': sql_str(c['supplier']),
                'size_chart_gender': sql_str(t.get('size_chart_gender')),
            }
            row_sql = ', '.join(str(values[col]) for col in cols)
            sql_lines.append(
                f"INSERT INTO products ({', '.join(cols)}) VALUES ({row_sql});"
            )

    with open(args.sql_out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(sql_lines) + ('\n' if sql_lines else ''))
    print(f'[sync] Записано {len(sql_lines)} SQL-рядків (запитів + коментарів) у {args.sql_out}')

    summary = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'source_file': title,
        'catalog_rows': len(catalog_rows),
        'products_checked': len(current_products),
        'updates': len(updates),
        'new_sizes_added': len(new_sizes),
        'skipped_excluded': len(skipped_excluded),
        'no_longer_available': len(gone),
    }
    print('[sync] SUMMARY_JSON: ' + json.dumps(summary, ensure_ascii=False))
    if new_sizes:
        sample = ', '.join(f"{i['catalog']['art']}/{i['catalog']['size']}" for i in new_sizes[:20])
        print(f'[sync] Додані розміри: {sample}' + ('...' if len(new_sizes) > 20 else ''))


if __name__ == '__main__':
    main()
