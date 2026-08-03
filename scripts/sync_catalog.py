#!/usr/bin/env python3
"""
sync_catalog.py — синхронізує api/_data/excel-catalog.json (каталог для пошуку
в адмінці) та готує SQL-запити для оновлення price/quantity вже опублікованих
на сайті товарів, на основі актуального catalog_*.xlsx з Google Drive
(генерується локальним update.py на комп'ютері власника сайту).

Джерело даних (Роздрібна ціна, категорії, дедублікація) вже повністю прораховане
update.py — цей скрипт нічого не перераховує заново, тільки перекладає формат
і порівнює з тим, що вже є в Supabase.

Використання:
    python3 sync_catalog.py \
        --catalog-tool-result <path-to-download_file_content-json> \
        --repo <path-to-site-checkout> \
        --current-products-json <path-to-json-[{id,articul,size,price,quantity}]> \
        --sql-out <path-to-write-generated-UPDATE-statements>

Виводить у stdout короткий текстовий підсумок (кількість рядків, кількість
оновлень) — саме це агент показує користувачу.
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


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--catalog-tool-result', required=True,
                    help='Шлях до JSON-файлу з результатом mcp__Google_Drive__download_file_content '
                         '(містить base64 вміст xlsx у полі "content")')
    p.add_argument('--repo', required=True, help='Шлях до чекауту репозиторію сайту')
    p.add_argument('--current-products-json', required=True,
                    help='Шлях до JSON-масиву [{id, articul, size, price, quantity}] — '
                         'поточний стан таблиці products у Supabase')
    p.add_argument('--sql-out', required=True,
                    help='Куди записати згенеровані UPDATE-запити (порожній файл, якщо оновлень немає)')
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


def load_current_products(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


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

        catalog_rows.append([art, size, name, price_n, qty_n, brand, gender, cat1, cat2, cat3, supplier])

    print(f'[sync] Розпарсено {len(catalog_rows)} рядків каталогу '
          f'(пропущено {skipped_dupe} дублів, {skipped_bad} биті рядки)')

    # --- 1. Перезбираємо excel-catalog.json (каталог для пошуку в адмінці) ---
    catalog_json = {
        'cols': ['art', 'size', 'name', 'price', 'qty', 'brand', 'gender', 'cat1', 'cat2', 'cat3', 'supplier'],
        'rows': catalog_rows,
    }
    out_path = f'{args.repo}/api/_data/excel-catalog.json'
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(catalog_json, f, ensure_ascii=False, separators=(',', ':'))
    print(f'[sync] Записано {out_path}')

    # --- 2. Порівнюємо з уже опублікованими на сайті товарами (Supabase) ---
    current_products = load_current_products(args.current_products_json)

    lookup = {}
    for row in catalog_rows:
        art, size, _name, price_n, qty_n = row[0], row[1], row[2], row[3], row[4]
        lookup[(art.lower(), str(size))] = (price_n, qty_n)

    updates = []
    gone = []
    for p in current_products:
        key = (str(p['articul']).lower(), str(p['size']))
        if key not in lookup:
            gone.append(p)
            continue
        new_price, new_qty = lookup[key]
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

    sql_lines = [
        f"UPDATE products SET price = {u['new_price']}, quantity = {u['new_qty']} WHERE id = {u['id']};"
        for u in updates
    ]
    with open(args.sql_out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(sql_lines) + ('\n' if sql_lines else ''))
    print(f'[sync] Записано {len(sql_lines)} UPDATE-запитів у {args.sql_out}')

    summary = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'source_file': title,
        'catalog_rows': len(catalog_rows),
        'products_checked': len(current_products),
        'updates': len(updates),
        'no_longer_available': len(gone),
    }
    print('[sync] SUMMARY_JSON: ' + json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
