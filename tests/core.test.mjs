import test from 'node:test';
import assert from 'node:assert/strict';
import {scaleRecipe,aggregateIngredients,consumeStock,reconcileConfirmedRequisition,totalCost,expiryStatus,expiryDate,isoWeekKey,batchVelocity,inventoryUnitKey} from '../tincture-site/logic.mjs';
import {normalizeRecipe} from '../tincture-site/recipes.mjs';
test('Scaling preserves recipe and item metadata',()=>{const r={yield:2,ingredients:[{name:'Водка',amount:1.5,unit:'л',cost:500}]};const before=structuredClone(r);assert.deepEqual(scaleRecipe(r,10),[{name:'Водка',amount:7.5,unit:'л',cost:500}]);assert.deepEqual(r,before);assert.deepEqual(scaleRecipe({...r,yield:null},10),[]);});
test('Confirmed requisition applies only difference, no double stock',()=>{const initial=[{name:'Водка',unit:'л',amount:3,cost:500}];const old=[{name:'Водка',unit:'л',amount:2,cost:500}];const updated=[{name:'Водка',unit:'л',amount:5,cost:500}];const next=reconcileConfirmedRequisition(initial,old,updated);assert.equal(next[0].amount,6);assert.deepEqual(reconcileConfirmedRequisition(next,updated,updated),next);assert.equal(initial[0].amount,3);});
test('Production consumes stock and records shortage without input mutation',()=>{const stock=[{name:'Водка',unit:'л',amount:2,cost:500}];const result=consumeStock(stock,[{name:'Водка',unit:'л',amount:3}]);assert.equal(result.stock[0].amount,-1);assert.deepEqual(result.shortages,[{name:'Водка',unit:'л',need:3,have:2}]);assert.equal(stock[0].amount,2);});
test('Aggregation and money retain fractional quantities',()=>{const rows=[{name:'Сахар',unit:'кг',amount:.3,cost:100},{name:'сахар',unit:'кг',amount:.2,cost:100}];assert.equal(aggregateIngredients(rows)[0].amount,.5);assert.equal(totalCost(aggregateIngredients(rows)),50);});
test('Shelf expiry boundaries and week cross-year',()=>{assert.equal(expiryDate('2026-10-12T12:00:00Z',30),'2026-11-11T12:00:00.000Z');const now=new Date('2026-10-12T12:00:00Z');assert.equal(expiryStatus('2026-10-11T12:00:00Z',now).key,'expired');assert.equal(expiryStatus('2026-10-15T12:00:00Z',now).key,'soon');assert.equal(expiryStatus('2026-10-16T12:00:00Z',now).key,'ok');assert.equal(isoWeekKey(new Date(2027,0,1)),'2026-W53');});
test('Stop-list velocity uses actual remaining volume',()=>{assert.deepEqual(batchVelocity({startedAt:'2026-10-10T12:00:00Z',stoppedAt:'2026-10-12T12:00:00Z',actualYield:10,remainingVolume:2}),{days:2,consumed:8,perDay:4});});
test('normalized legacy recipes consume and receive stock under equivalent historic unit spellings',()=>{
  const legacy={name:'Сахарная',category:'Настойка',yield:1,ingredients:[{name:'Сахар',amount:1,unit:'kg',cost:100}]};
  const recipe=normalizeRecipe(legacy),stock=[{name:'Сахар',amount:5,unit:'kg',cost:100,batch:'historic'}];
  const before=structuredClone(stock),result=consumeStock(stock,recipe.ingredients);
  assert.equal(recipe.ingredients[0].unit,'кг');
  assert.deepEqual(result.shortages,[]);
  assert.deepEqual(result.stock,[{...stock[0],amount:4}]);
  assert.deepEqual(reconcileConfirmedRequisition(stock,[],recipe.ingredients),[{...stock[0],amount:6}]);
  assert.deepEqual(stock,before);
  assert.equal(legacy.ingredients[0].unit,'kg');
});
test('editing a legacy confirmed request with a unit alias applies only its actual quantity delta',()=>{
  const stock=[{name:'Сахар',amount:5,unit:'kg',cost:100}],old=[{name:'Сахар',amount:2,unit:'kg',cost:100}];
  const changed=[{name:'сахар',amount:3,unit:'кг',cost:100}];
  assert.deepEqual(reconcileConfirmedRequisition(stock,old,changed),[{...stock[0],amount:6}]);
  assert.deepEqual(reconcileConfirmedRequisition(stock,old,[{...old[0],unit:'кг'}]),stock);
  assert.deepEqual(aggregateIngredients([...old,{name:'Сахар',amount:1,unit:'кг',cost:100}]),[{name:'Сахар',amount:3,unit:'kg',cost:100}]);
});
test('inventory unit aliases preserve physical scales and custom units',()=>{
  for(const pair of [['kg','кг'],['ml','мл'],['L','л'],['g','гр.'],['pcs','шт.'],['tbsp','ст. л.'],['tsp','ч. л.']])assert.equal(inventoryUnitKey(pair[0]),inventoryUnitKey(pair[1]));
  assert.notEqual(inventoryUnitKey('г'),inventoryUnitKey('кг'));
  assert.notEqual(inventoryUnitKey('мл'),inventoryUnitKey('л'));
  assert.equal(inventoryUnitKey('бутылка'),'бутылка');
});
