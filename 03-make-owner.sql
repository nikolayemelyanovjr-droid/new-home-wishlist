-- Выполните один раз в SQL Editor своего проекта Supabase.
-- Брони и список администраторов находятся в закрытой схеме.
begin;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.wishlist_items (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('hall','kitchen','bath','ksyusha','living','kolya','wardrobe','bedroom','custom')),
  title text not null check (char_length(btrim(title)) between 1 and 180),
  quantity integer not null default 1 check (quantity between 1 and 100),
  unit_price numeric(12,2) check (unit_price between 0 and 100000000),
  price_mode text not null default 'unit' check (price_mode in ('unit','total')),
  product_url text not null default '' check (char_length(product_url) <= 4096 and (product_url = '' or product_url ~ '^https://[^/@[:space:]]+([/:?][^[:space:]]*)?$')),
  image_url text not null default '' check (char_length(image_url) <= 4096 and (image_url = '' or image_url ~ '^https://[^/@[:space:]]+([/:?][^[:space:]]*)?$')),
  note text not null default '' check (char_length(note) <= 2000),
  sort_order integer not null default 0,
  is_reserved boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);
create table private.wishlist_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table private.wishlist_reservations (
  item_id uuid primary key references public.wishlist_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index wishlist_reservations_user on private.wishlist_reservations(user_id);
create index wishlist_items_order on public.wishlist_items(category, sort_order);

alter table public.wishlist_items enable row level security;
alter table private.wishlist_admins enable row level security;
alter table private.wishlist_reservations enable row level security;
revoke all on public.wishlist_items from public, anon, authenticated;
grant select on public.wishlist_items to anon, authenticated;
create policy "Public gift list contains no identities" on public.wishlist_items for select to anon, authenticated using (true);
revoke all on private.wishlist_admins, private.wishlist_reservations from public, anon, authenticated;

create function private.touch_wishlist_item() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := clock_timestamp(); return new; end;
$$;
create trigger wishlist_item_updated before update on public.wishlist_items
for each row execute function private.touch_wishlist_item();

create function private.sync_reservation_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    update public.wishlist_items set is_reserved = false where id = old.item_id;
    return old;
  end if;
  update public.wishlist_items set is_reserved = true where id = new.item_id;
  return new;
end;
$$;
create trigger wishlist_reservation_status after insert or delete on private.wishlist_reservations
for each row execute function private.sync_reservation_status();

create function public.is_wishlist_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from private.wishlist_admins a where a.user_id = (select auth.uid()));
$$;

create function public.get_wishlist() returns table (
  id uuid, category text, title text, quantity integer, unit_price numeric,
  price_mode text, product_url text, image_url text, note text, sort_order integer,
  is_reserved boolean, updated_at timestamptz, is_mine boolean
)
language sql stable security definer set search_path = '' as $$
  select i.id, i.category, i.title, i.quantity, i.unit_price, i.price_mode,
    i.product_url, i.image_url, i.note, i.sort_order, i.is_reserved, i.updated_at,
    coalesce(r.user_id = (select auth.uid()), false)
  from public.wishlist_items i left join private.wishlist_reservations r on r.item_id = i.id
  order by i.sort_order, i.id;
$$;

create function public.reserve_wishlist_item(p_item_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_owner uuid;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  -- Все изменения брони берут блокировки в одном порядке: позиция, затем бронь.
  perform 1 from public.wishlist_items where id = p_item_id for update;
  if not found then raise exception 'ITEM_NOT_FOUND' using errcode = 'P0002'; end if;
  select user_id into v_owner from private.wishlist_reservations where item_id = p_item_id;
  if v_owner is not null then return v_owner = v_user; end if;
  insert into private.wishlist_reservations(item_id, user_id) values(p_item_id, v_user);
  return true;
end;
$$;

create function public.release_wishlist_item(p_item_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  perform 1 from public.wishlist_items where id = p_item_id for update;
  delete from private.wishlist_reservations where item_id = p_item_id and user_id = auth.uid();
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

create function public.save_wishlist_item(p_item jsonb, p_expected_updated_at timestamptz default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_current timestamptz;
begin
  if not public.is_wishlist_admin() then raise exception 'ADMIN_REQUIRED' using errcode = '42501'; end if;
  v_id := nullif(p_item->>'id','')::uuid;
  if v_id is not null then
    select updated_at into v_current from public.wishlist_items where id = v_id for update;
    if not found then raise exception 'ITEM_NOT_FOUND' using errcode = 'P0002'; end if;
    if p_expected_updated_at is null or v_current <> p_expected_updated_at then
      raise exception 'EDIT_CONFLICT' using errcode = '40001';
    end if;
    update public.wishlist_items set
      title = btrim(p_item->>'title'), category = p_item->>'category',
      quantity = (p_item->>'quantity')::integer,
      unit_price = nullif(p_item->>'unit_price','')::numeric,
      price_mode = p_item->>'price_mode',
      product_url = coalesce(p_item->>'product_url',''), image_url = coalesce(p_item->>'image_url',''),
      note = coalesce(p_item->>'note',''), sort_order = coalesce((p_item->>'sort_order')::integer,0)
    where id = v_id;
  else
    insert into public.wishlist_items(title, category, quantity, unit_price, price_mode, product_url, image_url, note, sort_order)
    values(btrim(p_item->>'title'), p_item->>'category', (p_item->>'quantity')::integer,
      nullif(p_item->>'unit_price','')::numeric, p_item->>'price_mode',
      coalesce(p_item->>'product_url',''), coalesce(p_item->>'image_url',''), coalesce(p_item->>'note',''),
      coalesce((p_item->>'sort_order')::integer,0)) returning id into v_id;
  end if;
  return v_id;
end;
$$;

create function public.delete_wishlist_item(p_item_id uuid, p_expected_updated_at timestamptz) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_current timestamptz;
begin
  if not public.is_wishlist_admin() then raise exception 'ADMIN_REQUIRED' using errcode = '42501'; end if;
  select updated_at into v_current from public.wishlist_items where id = p_item_id for update;
  if not found then return false; end if;
  if p_expected_updated_at is null or v_current <> p_expected_updated_at then
    raise exception 'EDIT_CONFLICT' using errcode = '40001';
  end if;
  delete from public.wishlist_items where id = p_item_id;
  return true;
end;
$$;

revoke all on function private.touch_wishlist_item(), private.sync_reservation_status() from public, anon, authenticated;
revoke all on function public.get_wishlist(), public.is_wishlist_admin(), public.reserve_wishlist_item(uuid),
  public.release_wishlist_item(uuid), public.save_wishlist_item(jsonb,timestamptz), public.delete_wishlist_item(uuid,timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_wishlist() to anon, authenticated;
grant execute on function public.is_wishlist_admin(), public.reserve_wishlist_item(uuid),
  public.release_wishlist_item(uuid), public.save_wishlist_item(jsonb,timestamptz), public.delete_wishlist_item(uuid,timestamptz)
  to authenticated;

-- Публичные realtime-события содержат только карточки и флаг занятости.
-- Имена, email и идентификаторы дарителей не транслируются.
do $$ begin
  if exists(select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists(select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'wishlist_items') then
    alter publication supabase_realtime add table public.wishlist_items;
  end if;
end $$;
commit;
