import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cost, summarise, selectItems, safeURL, normaliseItem, escapeHTML } from '../js/core.js';
import { DemoRepository } from '../js/repository.js';

const seed = JSON.parse(await readFile(new URL('../data/items.json',import.meta.url),'utf8'));
const base = { id: 'item', category:'kitchen', title:'Стулья', quantity:4, unit_price:2499.9, price_mode:'unit', sort_order:0, is_reserved:false, is_mine:false };

test('Весь исходный список: 90 позиций, 35 точных ссылок, 105 штук', () => {
  assert.equal(seed.items.length,90);
  assert.equal(new Set(seed.items.map(item=>item.id)).size,90);
  assert.equal(seed.items.filter(item=>item.product_url).length,35);
  assert.equal(seed.items.reduce((n,item)=>n+item.quantity,0),105);
  assert.equal(seed.categories.length,9);
  assert.equal(seed.items.find(item=>item.category==='ksyusha' && item.title==='Матрас').note,'Размер: 90 × 200 см.');
  assert.equal(seed.items.find(item=>item.title==='Венчик').product_url,'https://market.yandex.ru/cc/BMQNbX');
  assert.ok(seed.items.every(item=>item.unit_price === null));
});
test('Стоимость учитывает четыре штуки и цену целого комплекта', () => {
  assert.equal(cost(base),9999.6);
  assert.equal(cost({...base,price_mode:'total'}),2499.9);
  assert.equal(cost({...base,unit_price:0}),0);
});
test('Неизвестные цены не становятся нулями и отдельно входят в остаток', () => {
  const s = summarise([base,{...base,id:'two',unit_price:null},{...base,id:'three',unit_price:125.15,quantity:1,is_reserved:true}]);
  assert.equal(s.total,3);assert.equal(s.unknown,1);assert.equal(s.unknownRemaining,1);
  assert.equal(s.amount,10124.75);assert.equal(s.reservedAmount,125.15);assert.equal(s.remainingAmount,9999.6);
  assert.equal(s.reserved,1);
});
test('Пустая категория и нулевой бюджет не дают NaN', () => {
  assert.equal(summarise([]).itemPercent,0);
  assert.equal(summarise([]).moneyPercent,0);
  assert.equal(summarise([{...base,unit_price:0}]).moneyPercent,0);
  assert.equal(cost({...base,unit_price:''}),null);
  assert.equal(cost({...base,unit_price:NaN}),null);
});
test('Несколько комнат объединяются; поиск и статус пересекаются с ними', () => {
  const rows=[base,{...base,id:'two',category:'hall',title:'Стулья для прихожей',is_mine:true,is_reserved:true},{...base,id:'three',category:'bath',title:'Стакан'}];
  assert.equal(selectItems(rows,{categories:new Set(['kitchen','hall'])}).length,2);
  assert.deepEqual(selectItems(rows,{categories:new Set(['kitchen','hall']),query:'СТУЛЬЯ',status:'available'}).map(i=>i.id),['item']);
  assert.deepEqual(selectItems(rows,{status:'mine'}).map(i=>i.id),['two']);
});
test('Обе сортировки по цене оставляют неизвестную цену в конце', () => {
  const items=[{...base,id:'unknown',unit_price:null},{...base,id:'cheap',quantity:1,unit_price:10},{...base,id:'expensive',quantity:1,unit_price:100}];
  assert.deepEqual(selectItems(items,{sort:'price-desc'}).map(i=>i.id),['expensive','cheap','unknown']);
  assert.deepEqual(selectItems(items,{sort:'price-asc'}).map(i=>i.id),['cheap','expensive','unknown']);
});
test('Недоверенные ссылки не превращаются в исполняемый HTML', () => {
  assert.equal(safeURL('javascript:alert(1)'), '');
  assert.equal(safeURL('data:text/html,hello'), '');
  assert.equal(safeURL('https://user:pass@example.com/x'),'');
  assert.equal(safeURL('https://example.com/x'),'https://example.com/x');
  assert.equal(escapeHTML('<img src=x onerror="alert(1)">'),'&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});
test('Редактор сохраняет неизвестную цену, ограничения и комплект', () => {
  const item = normaliseItem({...base,unit_price:'',product_url:'',image_url:'',note:''},seed.categories);
  assert.equal(item.unit_price,null);
  assert.throws(()=>normaliseItem({...base,quantity:0},seed.categories));
  assert.throws(()=>normaliseItem({...base,category:'missing'},seed.categories));
  assert.throws(()=>normaliseItem({...base,product_url:'javascript:alert(1)'},seed.categories));
});

class MemoryStorage {
  #data = new Map();
  getItem(key) { return this.#data.get(key) ?? null; }
  setItem(key,value) { this.#data.set(key,String(value)); }
}
test('Демо: свои брони, чужая бронь, отмена и повторное бронирование',async()=>{
  const storage=new MemoryStorage(), a=new DemoRepository(seed,storage), b=new DemoRepository(seed,storage);
  b.user={id:'another-user'};
  const first=seed.items[0].id, second=seed.items[1].id;
  await a.reserve(first);await a.reserve(second);
  assert.equal((await a.getItems()).filter(i=>i.is_mine).length,2);
  await assert.rejects(b.reserve(first),/BOOKING_CONFLICT/);
  await b.release(first);
  assert.equal((await a.getItems()).find(i=>i.id===first).is_mine,true);
  await a.release(first);await b.reserve(first);
  assert.equal((await b.getItems()).find(i=>i.id===first).is_mine,true);
  assert.equal((await a.getItems()).find(i=>i.id===first).is_mine,false);
});
test('Демо: редактирование требует локального режима хозяев и свежей версии',async()=>{
  const repo=new DemoRepository(seed,new MemoryStorage());
  const item={...seed.items[0],title:'Новая банкетка'};
  await assert.rejects(repo.save(item,null),/ADMIN_REQUIRED/);
  repo.demoAdmin=true;await repo.save(item,null);
  await assert.rejects(repo.save({...item,title:'Перезапись'},null),/EDIT_CONFLICT/);
  const fresh=(await repo.getItems())[0];
  await repo.remove(fresh.id,fresh.updated_at);
  assert.equal((await repo.getItems()).length,89);
});
