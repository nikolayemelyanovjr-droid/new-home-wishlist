// Дополнительная функция; основной вишлист работает без автозагрузки.
// Секретные ключи и cookies магазинов не используются.
import { storeURL, parseProduct } from './parse.js';

const sbURL = Deno.env.get('SUPABASE_URL');
const sbKey = Deno.env.get('SUPABASE_ANON_KEY');
const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean);

Deno.serve(async request => {
  const origin = request.headers.get('Origin') || '';
  const cors = {
    'Access-Control-Allow-Origin': allowedOrigins.length ? allowedOrigins.includes(origin) ? origin : allowedOrigins[0] : '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type':'application/json; charset=utf-8' } });
  if (request.method === 'OPTIONS') return new Response(null,{ status:204,headers:cors });
  if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) return json({ error:'Недопустимый источник запроса.' },403);
  if (request.method !== 'POST') return json({ error:'Используйте POST.' },405);
  try {
    const auth = request.headers.get('Authorization') || '';
    if (!auth.startsWith('Bearer ')) return json({ error:'Сначала войдите как хозяин вишлиста.' },401);
    const headers = { Authorization:auth, apikey:sbKey, 'Content-Type':'application/json' };
    const check = await fetch(`${sbURL}/auth/v1/user`, { headers, signal:AbortSignal.timeout(8000) });
    if (!check.ok || !(await check.json()).id) return json({ error:'Сессия недействительна. Войдите снова.' },401);
    const admin = await fetch(`${sbURL}/rest/v1/rpc/is_wishlist_admin`, { method:'POST', headers, body:'{}', signal:AbortSignal.timeout(8000) });
    if (!admin.ok || await admin.json() !== true) return json({ error:'Автозагрузка доступна только хозяину вишлиста.' },403);
    const contentLength = Number(request.headers.get('Content-Length') || 0);
    if (contentLength > 8192) return json({ error:'Слишком большой запрос.' },413);
    const payload = await request.text();
    if (payload.length > 8192) return json({ error:'Слишком большой запрос.' },413);
    const body = JSON.parse(payload);
    if (typeof body.url !== 'string' || body.url.length > 4096) return json({ error:'Укажите ссылку на товар.' },400);
    let target = storeURL(body.url);
    let response;
    for (let redirect = 0; redirect <= 5; redirect++) {
      if (/showcaptcha|captcha\.yandex/i.test(target.href)) throw new Error('Магазин просит пройти проверку. Добавьте фото и цену вручную.');
      response = await fetch(target.href, { redirect:'manual', signal:AbortSignal.timeout(8000), headers:{ Accept:'text/html' } });
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('Location');
        await response.body?.cancel();
        if (!location || redirect === 5) throw new Error('Не удалось открыть конечную страницу магазина.');
        target = storeURL(new URL(location,target).href);
        continue;
      }
      break;
    }
    if (!response?.ok) throw new Error('Магазин не предоставил страницу товара. Добавьте данные вручную.');
    if (!response.headers.get('Content-Type')?.toLowerCase().includes('text/html')) throw new Error('Эта ссылка не ведёт на HTML-карточку товара.');
    const reader=response.body?.getReader();
    if (!reader) throw new Error('Страница магазина пуста.');
    let size=0;const chunks=[];
    while(true) {
      const {done,value}=await reader.read();if(done) break;
      size+=value.byteLength;
      if(size>2*1024*1024) { await reader.cancel(); throw new Error('Страница слишком большая для автозагрузки. Добавьте фото и цену вручную.'); }
      chunks.push(value);
    }
    const buffer=new Uint8Array(size);let offset=0;
    for(const chunk of chunks) {buffer.set(chunk,offset);offset+=chunk.byteLength;}
    const result=parseProduct(new TextDecoder().decode(buffer),target.href);
    if (!result.title && !result.image_url && result.unit_price === null) throw new Error('Магазин не отдал данные товара. Добавьте фото и цену вручную.');
    return json({ ...result, source_url:target.href, fetched_at:new Date().toISOString() });
  } catch (error) {
    return json({ error:error instanceof Error ? error.message : 'Не удалось загрузить данные магазина.' },422);
  }
});
