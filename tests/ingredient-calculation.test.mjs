import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRecipe, parseCalculationAmount, ingredientUnits, convertIngredientAmount } from '../tincture-site/logic.mjs';
import { scaleProcess } from '../tincture-site/recipes.mjs';

const recipe = { yield: 2.5, custom: 'keep', ingredients: [
  { name: 'Водка', amount: 2, unit: 'л', cost: 500, abv: 40 },
  { name: 'Нектарин', amount: .5, unit: 'кг', cost: 200, supplier: 'keep' },
  { name: 'Сахар', amount: .25, unit: 'кг', cost: 100 },
] };
const options = { basis: 'ingredient', ingredientIndex: 1, ingredientAmount: '1.100', ingredientUnit: 'кг' };

test('1.100 kg of nectarine scales the recipe, yield and quantities while keeping all metadata and source data', () => {
  const before = structuredClone(recipe), result = calculateRecipe(recipe, options);
  assert.equal(result.valid, true);assert.equal(result.factor, 2.2);assert.equal(result.targetYield, 5.5);
  assert.deepEqual(result.rows.map(i => i.amount), [4.4, 1.1, .55]);
  assert.equal(result.rows[0].abv, 40);assert.equal(result.rows[1].supplier, 'keep');assert.equal(result.rows[1].cost, 200);
  assert.deepEqual(recipe, before);assert.notEqual(result.rows[0], recipe.ingredients[0]);
});
test('decimal comma, decimal point and grams give the same recipe', () => {
  const expected = calculateRecipe(recipe, options);
  for (const [ingredientAmount, ingredientUnit] of [['1,100', 'кг'], ['1100', 'г'], ['1 100', 'g'], ['1100000', 'мг']]) {
    assert.deepEqual(calculateRecipe(recipe, { ...options, ingredientAmount, ingredientUnit }), expected);
  }
  const grams = { ...recipe, ingredients: recipe.ingredients.map((i, n) => n === 1 ? { ...i, amount: 500, unit: 'г', cost: .2 } : i) };
  const result = calculateRecipe(grams, options);
  assert.equal(result.rows[1].amount, 1100);assert.equal(result.rows[1].unit, 'г');assert.equal(result.rows[1].cost, .2);
});
test('volume conversions support litres, millilitres, centilitres and decilitres', () => {
  for (const [ingredientAmount, ingredientUnit] of [['1000', 'мл'], ['100', 'сл'], ['10', 'дл'], ['1', 'л']]) {
    const result = calculateRecipe(recipe, { ...options, ingredientIndex: 0, ingredientAmount, ingredientUnit });
    assert.equal(result.factor, .5);assert.equal(result.rows[0].amount, 1);assert.equal(result.targetYield, 1.25);
  }
  assert.deepEqual(ingredientUnits('ml'), ['мл', 'л', 'сл', 'дл']);
});
test('incompatible dimensions and unsupported conversions are rejected; matching custom units and aliases work', () => {
  assert.equal(calculateRecipe(recipe, { ...options, ingredientUnit: 'л' }).valid, false);
  assert.equal(calculateRecipe(recipe, { ...options, ingredientUnit: 'бутылка' }).valid, false);
  assert.ok(Number.isNaN(convertIngredientAmount(1, 'кг', 'л')));
  const count = { yield: 1, ingredients: [{ name: 'Лимон', amount: 2, unit: 'шт.' }] };
  assert.equal(calculateRecipe(count, { ...options, ingredientIndex: 0, ingredientAmount: 3, ingredientUnit: 'pcs' }).factor, 1.5);
  assert.equal(calculateRecipe({ yield: 1, ingredients: [{ name: 'Чай', amount: 1, unit: 'пакет' }] }, { ...options, ingredientIndex: 0, ingredientAmount: 2, ingredientUnit: 'пакет' }).factor, 2);
});
test('missing recipe yield does not prevent ingredient scaling and never invents a finished volume', () => {
  const result = calculateRecipe({ ...recipe, yield: null }, options);
  assert.equal(result.valid, true);assert.equal(result.targetYield, null);assert.deepEqual(result.rows.map(i => i.amount), [4.4, 1.1, .55]);
});
test('empty, invalid, nonpositive and nonfinite quantities and missing ingredient selection produce no result', () => {
  for (const ingredientAmount of ['', ' ', '0', '-1', 'NaN', 'Infinity', Infinity, NaN, '1..1', '1,2,3', '1kg', '1e1000']) {
    const result = calculateRecipe(recipe, { ...options, ingredientAmount });
    assert.equal(result.valid, false, String(ingredientAmount));assert.deepEqual(result.rows, []);
  }
  for (const ingredientIndex of [-1, 999, '', '1.5', NaN]) assert.equal(calculateRecipe(recipe, { ...options, ingredientIndex }).valid, false);
});
test('overflow and quantities lost at existing inventory precision are rejected instead of silently saving zero', () => {
  for (const ingredientAmount of [Number.MAX_VALUE, Number.MIN_VALUE, .000001]) {
    const result = calculateRecipe(recipe, { ...options, ingredientAmount });
    assert.equal(result.valid, false);assert.deepEqual(result.rows, []);
  }
});
test('ingredient selection uses row identity even when names repeat', () => {
  const repeated = { yield: 1, ingredients: [{ name: 'Водка', amount: 1, unit: 'л', abv: 40 }, { name: 'Водка', amount: .5, unit: 'л', abv: 96 }] };
  const result = calculateRecipe(repeated, { basis: 'ingredient', ingredientIndex: 1, ingredientAmount: 1, ingredientUnit: 'л' });
  assert.deepEqual(result.rows.map(i => i.amount), [2, 1]);assert.equal(result.rows[1].abv, 96);
});
test('existing yield calculation remains equivalent and validates its required base', () => {
  const result = calculateRecipe(recipe, { targetYield: 5 });
  assert.equal(result.valid, true);assert.equal(result.targetYield, 5);assert.deepEqual(result.rows.map(i => i.amount), [4, 1, .5]);
  assert.equal(calculateRecipe({ ...recipe, yield: null }, { targetYield: 5 }).valid, false);
  for (const targetYield of [0, -1, Infinity, '']) assert.equal(calculateRecipe(recipe, { targetYield }).valid, false);
});
test('process quantities use the ingredient factor while duration, temperature and percentages stay unchanged', () => {
  const result = calculateRecipe(recipe, options);
  assert.equal(scaleProcess('Добавить 500 г нектарина и 2 л водки. 7 дней при 20 °C, 40%.', result.factor), 'Добавить 1100 г нектарина и 4,4 л водки. 7 дней при 20 °C, 40%.');
  for (const value of ['1.100', '1,100']) assert.equal(parseCalculationAmount(value), 1.1);
});
