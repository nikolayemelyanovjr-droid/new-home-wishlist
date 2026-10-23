-- Сначала войдите на сайте через письмо. Затем замените адрес ниже своим.
-- Никто не получает права владельца автоматически, в том числе первый посетитель.
insert into private.wishlist_admins(user_id)
select id from auth.users where lower(email) = lower('ЗАМЕНИТЕ_НА_ВАШ_EMAIL')
  and email_confirmed_at is not null
on conflict do nothing;

-- Здесь должен появиться ваш адрес. Пустой ответ означает, что права не выданы.
select u.email from private.wishlist_admins a join auth.users u on u.id = a.user_id;
