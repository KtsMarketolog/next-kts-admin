#!/usr/bin/env python3
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / ".strapi-export" / "strapi.sqlite"
OUT_PATH = ROOT / "catalog-import.sql"


def sql(value):
  if value is None:
    return "null"
  if isinstance(value, bool):
    return "true" if value else "false"
  if isinstance(value, (int, float)):
    return str(int(value))
  return "'" + str(value).replace("'", "''") + "'"


def upload_url(strapi_url):
  if not strapi_url:
    return None
  return "/uploads/catalog/" + Path(strapi_url).name


def rows(cur, table, where="1=1"):
  return [dict(row) for row in cur.execute(f"select * from {table} where {where}")]


def published_by_doc(records):
  return {row["document_id"]: row for row in records if row["published_at"] is not None}


def id_to_published_id(records, published):
  result = {}
  for row in records:
    published_row = published.get(row["document_id"])
    if published_row:
      result[row["id"]] = published_row["id"]
  return result


def media_by_doc(cur, entity_table, related_type, field):
  result = {}
  query = """
    select e.document_id, f.url
    from files_related_mph r
    inner join files f on f.id = r.file_id
    inner join {entity_table} e on e.id = r.related_id
    where r.related_type = ?
      and r.field = ?
      and f.url is not null
    order by r."order" asc, f.id asc
  """.format(entity_table=entity_table)
  for row in cur.execute(query, [related_type, field]):
    if row["document_id"] not in result:
      result[row["document_id"]] = upload_url(row["url"])
  return result


def main():
  if not DB_PATH.exists():
    raise SystemExit(f"Strapi SQLite not found: {DB_PATH}")

  conn = sqlite3.connect(DB_PATH)
  conn.row_factory = sqlite3.Row
  cur = conn.cursor()

  all_categories = rows(cur, "categories")
  all_subcategories = rows(cur, "subcategories")
  all_brands = rows(cur, "brands")
  all_products = rows(cur, "products")

  categories = published_by_doc(all_categories)
  subcategories = published_by_doc(all_subcategories)
  brands = published_by_doc(all_brands)
  products = published_by_doc(all_products)

  category_id = id_to_published_id(all_categories, categories)
  subcategory_id = id_to_published_id(all_subcategories, subcategories)
  brand_id = id_to_published_id(all_brands, brands)
  product_id = id_to_published_id(all_products, products)

  category_icons = media_by_doc(cur, "categories", "api::category.category", "icon")
  category_images = media_by_doc(cur, "categories", "api::category.category", "image")
  brand_logos = media_by_doc(cur, "brands", "api::brand.brand", "logo")

  product_brand = {}
  product_category = {}
  product_subcategory = {}

  for row in rows(cur, "products_brand_lnk"):
    pid = product_id.get(row["product_id"])
    bid = brand_id.get(row["brand_id"])
    if pid and bid and pid not in product_brand:
      product_brand[pid] = bid

  for row in rows(cur, "products_category_lnk"):
    pid = product_id.get(row["product_id"])
    cid = category_id.get(row["category_id"])
    if pid and cid and pid not in product_category:
      product_category[pid] = cid

  for row in rows(cur, "products_subcategory_lnk"):
    pid = product_id.get(row["product_id"])
    sid = subcategory_id.get(row["subcategory_id"])
    if pid and sid and pid not in product_subcategory:
      product_subcategory[pid] = sid

  category_subcategory_links = []
  seen_category_subcategory = set()
  for row in rows(cur, "categories_subcategories_lnk"):
    cid = category_id.get(row["category_id"])
    sid = subcategory_id.get(row["subcategory_id"])
    if not cid or not sid or (cid, sid) in seen_category_subcategory:
      continue
    seen_category_subcategory.add((cid, sid))
    category_subcategory_links.append((cid, sid, int(row["subcategory_ord"] or 0)))

  brand_category_links = []
  seen_brand_category = set()
  for row in rows(cur, "brands_categories_lnk"):
    bid = brand_id.get(row["brand_id"])
    cid = category_id.get(row["category_id"])
    if not bid or not cid or (bid, cid) in seen_brand_category:
      continue
    seen_brand_category.add((bid, cid))
    brand_category_links.append((bid, cid, int(row["brand_ord"] or 0)))

  brand_subcategory_links = []
  seen_brand_subcategory = set()
  for row in rows(cur, "brands_subcategories_lnk"):
    bid = brand_id.get(row["brand_id"])
    sid = subcategory_id.get(row["subcategory_id"])
    if not bid or not sid or (bid, sid) in seen_brand_subcategory:
      continue
    seen_brand_subcategory.add((bid, sid))
    brand_subcategory_links.append((bid, sid, int(row["brand_ord"] or 0)))

  lines = [
    "begin;",
    """
create table if not exists catalog_categories (
  id bigserial primary key,
  strapi_id integer unique,
  document_id text,
  slug text not null unique,
  title text not null,
  subtitle text,
  sort_order integer not null default 0,
  icon_url text,
  image_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists catalog_subcategories (
  id bigserial primary key,
  strapi_id integer unique,
  document_id text,
  slug text not null unique,
  title text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists catalog_category_subcategories (
  category_id bigint not null references catalog_categories(id) on delete cascade,
  subcategory_id bigint not null references catalog_subcategories(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (category_id, subcategory_id)
);

create table if not exists catalog_brands (
  id bigserial primary key,
  strapi_id integer unique,
  document_id text,
  slug text not null unique,
  title text not null,
  popular boolean not null default false,
  logo_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists catalog_brand_categories (
  brand_id bigint not null references catalog_brands(id) on delete cascade,
  category_id bigint not null references catalog_categories(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (brand_id, category_id)
);

create table if not exists catalog_brand_subcategories (
  brand_id bigint not null references catalog_brands(id) on delete cascade,
  subcategory_id bigint not null references catalog_subcategories(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (brand_id, subcategory_id)
);

create table if not exists catalog_products (
  id bigserial primary key,
  strapi_id integer unique,
  document_id text,
  slug text not null unique,
  title text not null,
  article text,
  promo boolean not null default false,
  brand_id bigint references catalog_brands(id) on delete set null,
  category_id bigint references catalog_categories(id) on delete set null,
  subcategory_id bigint references catalog_subcategories(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
""",
    "truncate catalog_category_subcategories, catalog_brand_categories, catalog_brand_subcategories, catalog_products, catalog_brands, catalog_subcategories, catalog_categories restart identity cascade;",
  ]

  for row in sorted(categories.values(), key=lambda item: (item["sort_order"] or 0, item["id"])):
    lines.append(
      "insert into catalog_categories (id, strapi_id, document_id, slug, title, subtitle, sort_order, icon_url, image_url, is_active) values "
      f"({sql(row['id'])}, {sql(row['id'])}, {sql(row['document_id'])}, {sql(row['slug'])}, {sql(row['title'])}, {sql(row['subtitle'])}, {sql(row['sort_order'] or 0)}, {sql(category_icons.get(row['document_id']))}, {sql(category_images.get(row['document_id']))}, true);"
    )

  for row in sorted(subcategories.values(), key=lambda item: (item["sort_order"] or 0, item["id"])):
    lines.append(
      "insert into catalog_subcategories (id, strapi_id, document_id, slug, title, sort_order, is_active) values "
      f"({sql(row['id'])}, {sql(row['id'])}, {sql(row['document_id'])}, {sql(row['slug'])}, {sql(row['title'])}, {sql(row['sort_order'] or 0)}, true);"
    )

  for row in sorted(brands.values(), key=lambda item: (item["title"] or "", item["id"])):
    lines.append(
      "insert into catalog_brands (id, strapi_id, document_id, slug, title, popular, logo_url, is_active) values "
      f"({sql(row['id'])}, {sql(row['id'])}, {sql(row['document_id'])}, {sql(row['slug'])}, {sql(row['title'])}, {sql(bool(row['popular']))}, {sql(brand_logos.get(row['document_id']))}, true);"
    )

  for cid, sid, order in sorted(category_subcategory_links, key=lambda item: (item[0], item[2], item[1])):
    lines.append(
      "insert into catalog_category_subcategories (category_id, subcategory_id, sort_order) values "
      f"({sql(cid)}, {sql(sid)}, {sql(order)}) on conflict do nothing;"
    )

  for bid, cid, order in sorted(brand_category_links, key=lambda item: (item[0], item[2], item[1])):
    lines.append(
      "insert into catalog_brand_categories (brand_id, category_id, sort_order) values "
      f"({sql(bid)}, {sql(cid)}, {sql(order)}) on conflict do nothing;"
    )

  for bid, sid, order in sorted(brand_subcategory_links, key=lambda item: (item[0], item[2], item[1])):
    lines.append(
      "insert into catalog_brand_subcategories (brand_id, subcategory_id, sort_order) values "
      f"({sql(bid)}, {sql(sid)}, {sql(order)}) on conflict do nothing;"
    )

  for row in sorted(products.values(), key=lambda item: (item["title"] or "", item["id"])):
    pid = row["id"]
    lines.append(
      "insert into catalog_products (id, strapi_id, document_id, slug, title, article, promo, brand_id, category_id, subcategory_id, is_active) values "
      f"({sql(pid)}, {sql(pid)}, {sql(row['document_id'])}, {sql(row['slug'])}, {sql(row['title'])}, {sql(row['article'])}, {sql(bool(row['promo']))}, {sql(product_brand.get(pid))}, {sql(product_category.get(pid))}, {sql(product_subcategory.get(pid))}, true);"
    )

  lines.extend([
    "select setval(pg_get_serial_sequence('catalog_categories', 'id'), coalesce((select max(id) from catalog_categories), 1), true);",
    "select setval(pg_get_serial_sequence('catalog_subcategories', 'id'), coalesce((select max(id) from catalog_subcategories), 1), true);",
    "select setval(pg_get_serial_sequence('catalog_brands', 'id'), coalesce((select max(id) from catalog_brands), 1), true);",
    "select setval(pg_get_serial_sequence('catalog_products', 'id'), coalesce((select max(id) from catalog_products), 1), true);",
    "commit;",
  ])

  OUT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
  print(f"SQL: {OUT_PATH}")
  print(f"categories: {len(categories)}")
  print(f"subcategories: {len(subcategories)}")
  print(f"brands: {len(brands)}")
  print(f"products: {len(products)}")
  print(f"category-subcategory links: {len(category_subcategory_links)}")
  print(f"brand-category links: {len(brand_category_links)}")
  print(f"brand-subcategory links: {len(brand_subcategory_links)}")
  print(f"products with brand: {sum(1 for value in product_brand.values() if value)}")
  print(f"products with category: {sum(1 for value in product_category.values() if value)}")
  print(f"products with subcategory: {sum(1 for value in product_subcategory.values() if value)}")


if __name__ == "__main__":
  main()
