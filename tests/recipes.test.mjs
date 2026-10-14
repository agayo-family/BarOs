import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIngredientsText, parseRecipeText, classifyRecipe,
  normalizeRecipe, recipeFingerprint, scaleProcess,
  ingredientStrengthInfo, recipeAlcoholStrength,
} from '../tincture-site/recipes.mjs';

test('a complete pasted recipe extracts title, decimal comma, yield, shelf life and process', () => {
  const text = 'Название: Клюквенная\nВыход: 1,5 л\nСрок годности: 30 дней\nСостав:\n• Водка 40% — 0,5 л\n- 250 г клюквы\nСахар | 100 | г | 0,08\nПриготовление:\n1. Смешать 500 мл водки с ягодами.\n2. Настаивать 7 дней при 20 °C.';
  const r = parseRecipeText(text);
  assert.equal(r.name, 'Клюквенная');
  assert.equal(r.yield, 1.5);
  assert.equal(r.shelfLifeDays, 30);
  assert.deepEqual(r.ingredients.map(x => [x.name,x.amount,x.unit]), [['Водка 40%',.5,'л'],['клюквы',250,'г'],['Сахар',100,'г']]);
  assert.equal(r.category, 'Водка');
  assert.match(r.process, /Настаивать 7 дней/);
  assert.equal(r.rawText, text);
  assert.equal(r.unparsedText, '');
});

test('ingredient prose, bullets, common unit aliases and decimal commas are understood', () => {
  const r = parseIngredientsText('Водка 0,5л, сахар 100 гр.; 1 kg ягод\n• Сок 250 ml\nВаниль — 2 шт.\nмёд;50;г;0,3');
  assert.deepEqual(r.ingredients.map(x => [x.name,x.amount,x.unit]), [['Водка',.5,'л'],['сахар',100,'г'],['ягод',1,'кг'],['Сок',250,'мл'],['Ваниль',2,'шт'],['мёд',50,'г']]);
  assert.equal(r.unparsedText, '');
});

test('unrecognized quantities, comments and OCR mistakes remain available for correction', () => {
  const text = 'Лимонная\nСостав:\nВодка 500 мл\nЛимон — по вкусу\nСахар 1O0 г\nМята 10 г (листочки оставить для украшения)\nОсобое примечание\nВыход: примерно литр';
  const r = parseRecipeText(text);
  assert.equal(r.rawText, text);
  assert.match(r.unparsedText, /Лимон — по вкусу/);
  assert.match(r.unparsedText, /Сахар 1O0 г/);
  assert.match(r.unparsedText, /листочки оставить/);
  assert.match(r.unparsedText, /Особое примечание/);
  assert.match(r.unparsedText, /Выход: примерно литр/);
  assert.equal(r.yield, null);
});

test('title-only recipe and optional output stay valid records', () => {
  const title = parseRecipeText('Облепиха / ваниль');
  assert.equal(title.name, 'Облепиха / ваниль');
  assert.equal(title.yield, null);
  assert.equal(title.category, 'Без категории');
  assert.deepEqual(title.ingredients, []);
  const full = parseRecipeText('Вишнёвая\nВодка 500 мл\nВишня 200 г');
  assert.equal(full.yield, null);
  assert.equal(full.category, 'Водка');
  assert.equal(parseRecipeText('Сироп\nВыход, мл: 750\nВода 500 мл').yield, .75);
});

test('classification is based on ingredients and never randomly chooses among multiple alcohols', () => {
  const r = parseRecipeText('Название: Джин с ягодами\nВодка 0,5 л\nРом 100 мл\nЯгоды 200 г');
  assert.equal(r.category, 'Требует уточнения');
  assert.deepEqual(r.alcoholCandidates, ['Водка','Ром']);
  const confirmed = classifyRecipe({...r, primaryAlcohol:'Ром', categoryMode:'confirmed'});
  assert.equal(confirmed.category, 'Ром');
  assert.equal(confirmed.categoryMode, 'confirmed');
  const changed = classifyRecipe({...confirmed, ingredients:[{name:'Водка',amount:1,unit:'л'}]});
  assert.equal(changed.category, 'Водка');
  assert.equal(changed.primaryAlcohol, '');
  assert.equal(classifyRecipe(confirmed,{force:true}).category, 'Требует уточнения');
});

test('manual categorization remains until explicit automatic sorting', () => {
  const recipe = {name:'Особая', category:'Авторская', categoryMode:'manual', ingredients:[{name:'Джин',amount:1,unit:'л'}]};
  assert.equal(classifyRecipe(recipe).category, 'Авторская');
  assert.equal(classifyRecipe({...recipe,ingredients:[{name:'Ром',amount:1,unit:'л'}]}).category, 'Авторская');
  assert.equal(classifyRecipe(recipe,{force:true}).category, 'Джин');
  assert.equal(recipe.category, 'Авторская');
});

test('nonalcoholic bases and generic unknown bases are distinguished', () => {
  assert.equal(parseRecipeText('Сироп\nВода 1 л\nСахар 500 г').category, 'Безалкогольные');
  assert.equal(parseRecipeText('Джин без алкоголя\nБезалкогольный джин 500 мл\nСок 100 мл').category, 'Безалкогольные');
  assert.equal(parseRecipeText('Тоник\nGin alcohol-free 500 ml').category, 'Безалкогольные');
  assert.equal(parseRecipeText('Тоник\nДжин 0,0% 500 мл').category, 'Безалкогольные');
  assert.equal(parseRecipeText('Неизвестная\nОснова 500 мл\nЯгоды 200 г').category, 'Требует уточнения');
  assert.equal(parseRecipeText('Ромашка\nРомашка 10 г\nСироп 200 мл').category, 'Безалкогольные');
  assert.equal(parseRecipeText('Груша\nДжинджер сироп 200 мл').category, 'Безалкогольные');
});

test('known alcohol aliases classify consistently', () => {
  const cases = [['водки','Водка'],['Gin dry','Джин'],['Bacardi Carta Blanca','Ром'],['Tequila reposado','Текила'],['Bourbon','Виски'],['Коньяка','Бренди / Коньяк'],['Этиловый спирт 96%','Спирт'],['Вино белое','Вино'],['Cointreau','Ликёр'],['Мартини (вермут, вино)','Вермут']];
  for (const [name,category] of cases) assert.equal(classifyRecipe({ingredients:[{name,amount:1,unit:'л'}]}).category,category,name);
});

test('legacy recipe normalization preserves explicit category, extra data and original malformed input', () => {
  const r = normalizeRecipe({id:'old',name:' Старое ',category:'Настойка',yield:'1,5',shelfLifeDays:30,ingredients:[{name:'Водка',amount:'0,5',unit:'L',cost:'2,5',custom:'keep'},{name:'Ягоды',amount:'1O0',unit:'г'}],rawText:'ORIGINAL',unparsedText:'заметка',photos:[{dataUrl:'data:image/png;...'}],importSignatures:['old-source'],custom:'retained'});
  assert.equal(r.category,'Настойка');
  assert.equal(r.categoryMode,'manual');
  assert.equal(r.yield,1.5);
  assert.equal(r.ingredients[0].amount,.5);
  assert.equal(r.ingredients[0].unit,'л');
  assert.equal(r.ingredients[0].custom,'keep');
  assert.equal(r.ingredients[1].amount,'1O0');
  assert.match(r.unparsedText,/1O0/);
  assert.equal(r.rawText,'ORIGINAL');
  assert.equal(r.custom,'retained');
  assert.deepEqual(r.importSignatures,['old-source']);
  assert.equal(r.photos.length,1);
});

test('fingerprints normalize unit aliases, row order and cosmetic source differences', () => {
  const a = {name:'  Лимонная  ',yield:null,ingredients:[{name:'Водка',amount:.5,unit:'л'},{name:'Сахар',amount:.1,unit:'кг'}],rawText:'first format',category:'Водка'};
  const b = {name:'лимонная',ingredients:[{name:'сахар',amount:100,unit:'g'},{name:'водка',amount:500,unit:'ml'}],rawText:'other format',category:'Авторская',categoryMode:'manual',photos:['photo']};
  assert.equal(recipeFingerprint(a),recipeFingerprint(b));
  assert.notEqual(recipeFingerprint(a),recipeFingerprint({...b,yield:1}));
  assert.notEqual(recipeFingerprint(a),recipeFingerprint({...b,process:'Настаивать 7 дней'}));
  assert.notEqual(recipeFingerprint(a),recipeFingerprint({...b,unparsedText:'Важная пометка'}));
  assert.notEqual(recipeFingerprint(a),recipeFingerprint({name:a.name}));
});

test('process calculation scales mass, volume and pieces while preserving time, temperature and strength', () => {
  const text = '1. Влить 500 мл водки 40%, добавить 0,1 кг сахара и 2 шт. лимона.\n2. Настаивать 7 дней при 20 °C, перемешивать 3 раза.\n3. Добавить 50 г ягод.';
  const result = scaleProcess(text,2);
  assert.match(result,/1000 мл/);
  assert.match(result,/0,2 кг/);
  assert.match(result,/4 шт\./);
  assert.match(result,/100 г/);
  assert.match(result,/40%/);
  assert.match(result,/7 дней при 20 °C/);
  assert.match(result,/3 раза/);
  assert.equal(text.includes('500 мл'),true);
  assert.equal(scaleProcess(text,0),text);
});

test('ambiguous amount ranges are retained for manual recognition, not partially interpreted', () => {
  const r = parseIngredientsText('Сахар 100–200 г\nМята по вкусу');
  assert.deepEqual(r.ingredients,[]);
  assert.match(r.unparsedText,/100–200 г/);
  assert.match(r.unparsedText,/Мята по вкусу/);
});

test('normalization is idempotent and does not mutate the input', () => {
  const input = {name:'ТК',ingredients:[{name:'Основа',amount:'неизвестно',unit:'ml'}],photos:['photo']};
  const before = structuredClone(input);
  const once = normalizeRecipe(input);
  assert.deepEqual(normalizeRecipe(once),once);
  assert.deepEqual(input,before);
});

test('negative amounts are preserved for correction and leading decimals/fractions stay accurate', () => {
  const invalid = parseIngredientsText('-1 л водки\nВодка -1 л\nСахар -100 г');
  assert.deepEqual(invalid.ingredients,[]);
  assert.match(invalid.unparsedText,/-1 л водки/);
  const valid = parseIngredientsText('Водка .5 л\nСироп ,25 л\n½ л сока\n1½ кг ягод\nСахар 1 1/4 кг');
  assert.deepEqual(valid.ingredients.map(x => x.amount),[.5,.25,.5,1.5,1.25]);
  assert.equal(valid.unparsedText,'');
});

test('process verbs without a heading do not become spurious ingredient names', () => {
  const r = parseRecipeText('Лимонная\nВодка 500 мл\nСахар 100 г\nСмешать водку с сахаром.\nДобавить 100 мл воды.\nНастаивать 3 дня.');
  assert.equal(r.ingredients.length,2);
  assert.match(r.process,/Добавить 100 мл воды/);
  assert.equal(r.unparsedText,'');
});

test('process ranges and concentration ratios are not partly recalculated', () => {
  const text = 'Добавить 100–200 г сахара. Использовать 100 г–200 г ягод. Концентрация 10 г/л. Настаивать 7 дней.';
  assert.equal(scaleProcess(text,2),text);
});

test('prose conjunctions separate multiple measured ingredients without splitting ingredient names', () => {
  const r = parseIngredientsText('500 мл водки и 100 г сахара\nСок лимона и апельсина 200 мл и сироп 50 мл');
  assert.deepEqual(r.ingredients.map(x => [x.name,x.amount]),[['водки',500],['сахара',100],['Сок лимона и апельсина',200],['сироп',50]]);
  assert.equal(r.unparsedText,'');
});

test('uncertain alcohol quantities still participate in category conflict detection', () => {
  const r = parseRecipeText('Клюквенная\nВодка 1 л\nДжин по вкусу');
  assert.equal(r.category,'Требует уточнения');
  assert.deepEqual(r.alcoholCandidates,['Водка','Джин']);
  assert.match(r.unparsedText,/Джин по вкусу/);
  const unknownBase = parseRecipeText('Особая\nВодка 1 л\nОснова 500 мл');
  assert.equal(unknownBase.category,'Требует уточнения');
  assert.equal(classifyRecipe({...unknownBase,primaryAlcohol:'Водка',categoryMode:'confirmed'}).category,'Водка');
});

test('negative or ranged output is retained rather than silently made positive', () => {
  for (const output of ['-1 л','100–200 мл']) {
    const r = parseRecipeText(`Лимонная\nВыход: ${output}\nВодка 500 мл`);
    assert.equal(r.yield,null);
    assert.match(r.unparsedText,/Выход:/);
  }
});

test('common nonalcoholic abbreviations with punctuation classify separately from alcohol', () => {
  for (const name of ['Джин б/а.', 'Безалк. джин', 'Джин Б/А', 'Безалког. gin', 'Джин б/алк.']) {
    const r = parseRecipeText(`Напиток\n${name} 500 мл`);
    assert.equal(r.category,'Безалкогольные',name);
    assert.deepEqual(r.alcoholCandidates,[],name);
  }
});

test('a nonalcoholic qualifier never hides another alcohol in a compound ingredient', () => {
  for (const name of ['Безалкогольный джин и водка', 'Джин б/а. + водка', 'Безалк. джин с водкой', 'Безалкогольный джин / водка']) {
    const r = parseRecipeText(`Напиток\n${name} 500 мл`);
    assert.equal(r.category,'Требует уточнения',name);
    assert.deepEqual(r.alcoholCandidates,['Водка','Джин'],name);
    assert.equal(r.primaryAlcohol,'');
  }
  assert.equal(parseRecipeText('Напиток\nБезалкогольный джин и безалкогольная водка 500 мл').category,'Безалкогольные');
});

test('concentrations remain wholly unresolved instead of becoming absolute quantities', () => {
  for (const line of ['Сахар 100 г/л', 'Сахар 100 g / l', 'Сахар | 100 | г/л | 0', 'Сахар;100;г/л;0']) {
    const r = parseIngredientsText(line);
    assert.deepEqual(r.ingredients,[],line);
    assert.match(r.unparsedText,/100/,line);
    assert.match(r.unparsedText,/[гg].*\//,line);
  }
});

test('an explicit TK title with a trailing volume has priority over ingredient recognition', () => {
  for (const title of ['ТК Лимонная 0,5 л', 'ТК Лимонная0,5л', 'Технологическая карта: Лимонная (500 мл)', 'ТК №12 Лимонная 500 ml']) {
    const r = parseRecipeText(`${title}\nВодка 500 мл\nСахар 100 г`);
    assert.equal(r.name,'Лимонная',title);
    assert.equal(r.yield,.5,title);
    assert.equal(r.ingredients.length,2,title);
    assert.equal(r.unparsedText,'',title);
  }
  for (const title of ['ТК Лимонная -1 л', 'ТК Лимонная 100–200 мл']) {
    const r = parseRecipeText(`${title}\nВодка 500 мл`);
    assert.equal(r.yield,null,title);
    assert.equal(r.ingredients.length,1,title);
    assert.ok(r.name,title);
  }
});

test('alcohol strength balances all alcoholic bases against the actual batch yield', () => {
  const recipe = { yield: 2, ingredients: [
    { name: 'Водка 40%', amount: 1, unit: 'л' },
    { name: 'Ром', amount: .5, unit: 'л', abv: 60 },
    { name: 'Сахар', amount: 200, unit: 'г' },
  ] };
  const result = recipeAlcoholStrength(recipe);
  assert.equal(result.status, 'ready');
  assert.equal(result.value, 35);
  assert.equal(result.ethanolLitres, .7);
  assert.deepEqual(result.missing, []);
  assert.match(result.message, /Расчётная/);
  assert.match(result.message, /без учёта потерь/);
  assert.deepEqual(recipe.ingredients[0], { name: 'Водка 40%', amount: 1, unit: 'л' });
});

test('strength recognizes decimal comma, compact names, percentages after quantities and volume aliases', () => {
  for (const line of ['Водка40% 2 л', 'Водка 2л 40%', 'Водка 2 л (40%)']) {
    const parsed = parseIngredientsText(line);
    assert.equal(parsed.unparsedText, '', line);
    assert.equal(parsed.ingredients.length, 1, line);
    assert.equal(recipeAlcoholStrength({ yield: 4, ingredients: parsed.ingredients }).value, 20, line);
  }
  const result = recipeAlcoholStrength({ yield: '1,5', ingredients: [
    { name: 'Водка (37,5%)', amount: '1/2', unit: 'litre' },
    { name: 'Спирт 96%', amount: 125, unit: 'mls' },
    { name: 'Джин', amount: '2,5', unit: 'cl', abv: '40' },
    { name: 'Ром', amount: .5, unit: 'dl', abv: '40,5' },
  ] });
  assert.equal(result.status, 'ready');
  assert.equal(result.value, 22.51666667);
  assert.equal(result.ethanolLitres, .33775);
});

test('explicit strength wins over labels and preserves an explicit zero', () => {
  assert.equal(ingredientStrengthInfo({ name: 'Водка 40%', unit: 'л', abv: '37,5' }).abv, 37.5);
  assert.equal(ingredientStrengthInfo({ name: 'Сливки с ромом 33%', unit: 'мл', abv: 17 }).abv, 17);
  const result = recipeAlcoholStrength({ yield: 1, ingredients: [{ name: 'Водка 40%', amount: 1, unit: 'л', abv: 0 }] });
  assert.equal(result.status, 'ready');
  assert.equal(result.value, 0);
  assert.equal(recipeAlcoholStrength({ yield: 1, ingredients: [{ name: 'Brand X', amount: 250, unit: 'ml', abv: 50 }] }).value, 12.5);
  assert.equal(recipeAlcoholStrength({ yield: 1, ingredients: [{ name: 'Brand X', amount: 250, unit: 'ml', abv: '0' }] }).value, 0);
});

test('missing or ambiguous strength never produces a partial result or a default alcohol strength', () => {
  for (const name of ['Водка', 'Bacardi Carta Blanca', 'Основа', 'Алкогольная база', 'Ром 40–45%', 'Ром 40-45%', 'Ром 40 -45%', 'Ром от 40 до 45%', 'Rum 40 to 45%', 'Ром 40/45%', 'Ром 40%–45%', 'Водка и ром 40%', 'Brand X']) {
    const result = recipeAlcoholStrength({ yield: 2, ingredients: [
      { name: 'Водка 40%', amount: 1, unit: 'л' }, { name, amount: 500, unit: 'мл' },
    ] });
    assert.equal(result.status, 'missing', name);
    assert.equal(result.value, null, name);
    assert.ok(result.missing.some(x => x.includes(name)), name);
    assert.equal(Object.hasOwn(result, 'ethanolLitres'), false, name);
  }
  assert.equal(ingredientStrengthInfo({ name: 'Водка', unit: 'л' }).abv, null);
  assert.equal(ingredientStrengthInfo({ name: 'Brand X', unit: 'ml' }).requiresStrength, true);
});

test('fat and concentration percentages are not mistaken for alcoholic strength', () => {
  for (const name of ['Сливки 33%', 'Молоко 3,2%', 'Milk 3.2%', 'Шоколад 70%']) {
    const info = ingredientStrengthInfo({ name, unit: 'г' });
    assert.equal(info.alcoholic, false, name);
    assert.equal(info.abv, 0, name);
  }
  for (const name of ['Сливки с ромом 33%', 'Ликёр с молоком 3,2%', 'Ром концентрация 40%', 'Ликёр шоколад 70%', 'Gin cream 33%']) {
    const info = ingredientStrengthInfo({ name, unit: 'л' });
    assert.equal(info.abv, null, name);
    assert.equal(info.requiresStrength, true, name);
  }
  const result = recipeAlcoholStrength({ yield: 1, ingredients: [
    { name: 'Ликёр', amount: 250, unit: 'ml', abv: 20 },
    { name: 'Сливки 33%', amount: 300, unit: 'ml' },
    { name: 'Молоко 3,2%', amount: 450, unit: 'ml' },
  ] });
  assert.equal(result.status, 'ready');
  assert.equal(result.value, 5);
});

test('clear nonalcoholic ingredients return zero only when the recipe has an output', () => {
  for (const name of ['Вода', 'Сок лимона', 'Сироп', 'Чай', 'Coffee', 'Безалкогольный джин', 'Gin alcohol-free', 'Джин 0,0%', 'Джин б/а.']) {
    assert.equal(ingredientStrengthInfo({ name, unit: 'л' }).abv, 0, name);
    assert.equal(recipeAlcoholStrength({ yield: 1, ingredients: [{ name, amount: 1, unit: 'л' }] }).value, 0, name);
  }
  assert.equal(recipeAlcoholStrength({ ingredients: [{ name: 'Вода', amount: 1, unit: 'л' }] }).status, 'missing');
  assert.equal(recipeAlcoholStrength({ yield: 1, ingredients: [] }).status, 'missing');
  for (const name of ['Безалкогольный джин и водка', 'Джин 0% + водка']) {
    assert.equal(recipeAlcoholStrength({ yield: 1, ingredients: [{ name, amount: 1, unit: 'л' }] }).status, 'missing', name);
  }
});

test('alcohol entered by mass requires a volume without guessing density', () => {
  const info = ingredientStrengthInfo({ name: 'Спирт 96%', amount: .5, unit: 'кг' });
  assert.equal(info.needsVolume, true);
  const result = recipeAlcoholStrength({ yield: 2, ingredients: [{ name: 'Спирт 96%', amount: .5, unit: 'кг' }] });
  assert.equal(result.status, 'missing');
  assert.equal(result.value, null);
  assert.match(result.missing.join('; '), /объём/);
  assert.equal(recipeAlcoholStrength({ yield: 2, ingredients: [{ name: 'Сахар', amount: .5, unit: 'кг' }] }).value, 0);
});

test('invalid strength, amounts, output and impossible totals do not receive a percentage', () => {
  for (const abv of [-1, 101, Infinity, NaN, 'неизвестно']) {
    assert.equal(ingredientStrengthInfo({ name: 'Водка', unit: 'л', abv }).invalid, true, String(abv));
    const result = recipeAlcoholStrength({ yield: 1, ingredients: [{ name: 'Водка', amount: 1, unit: 'л', abv }] });
    assert.equal(result.status, 'invalid', String(abv));
    assert.equal(result.value, null, String(abv));
  }
  for (const name of ['Спирт 101%', 'Водка -40%']) assert.equal(ingredientStrengthInfo({ name, unit: 'л' }).invalid, true, name);
  for (const amount of [-1, Infinity, NaN, '1O0', '']) assert.equal(recipeAlcoholStrength({ yield: 1, ingredients: [{ name: 'Сахар', amount, unit: 'г' }] }).status, 'invalid', String(amount));
  for (const output of [-1, Infinity, NaN, 'неизвестно']) assert.equal(recipeAlcoholStrength({ yield: output, ingredients: [{ name: 'Водка 40%', amount: 1, unit: 'л' }] }).status, 'invalid', String(output));
  for (const output of [null, undefined, '', 0]) assert.equal(recipeAlcoholStrength({ yield: output, ingredients: [{ name: 'Водка 40%', amount: 1, unit: 'л' }] }).status, 'missing', String(output));
  assert.equal(recipeAlcoholStrength({ yield: .1, ingredients: [{ name: 'Водка 40%', amount: 1, unit: 'л' }] }).status, 'invalid');
  assert.equal(recipeAlcoholStrength({ yield: 1, ingredients: [{ name: 'Спирт 100%', amount: 1, unit: 'л' }] }).value, 100);
});

test('unresolved alcoholic lines block a confident or partial strength', () => {
  for (const unparsedText of ['Джин по вкусу', 'Основа 100–200 мл', 'Brand X 100–200 ml']) {
    const result = recipeAlcoholStrength({ yield: 2, ingredients: [{ name: 'Водка 40%', amount: 1, unit: 'л' }], unparsedText });
    assert.equal(result.status, 'missing', unparsedText);
    assert.equal(result.value, null, unparsedText);
    assert.ok(result.missing.some(x => x.includes(unparsedText)), unparsedText);
  }
  assert.equal(recipeAlcoholStrength({ yield: 1, ingredients: 'Вода 1 л\nВодка по вкусу' }).status, 'missing');
  assert.equal(recipeAlcoholStrength({ yield: 1, ingredients: [{ name: 'Водка 40%', amount: 1, unit: 'л' }], unparsedText: 'Категория: Водка' }).status, 'ready');
});

test('strength is invariant when a recipe is scaled and remains explicitly theoretical after heating', () => {
  const recipe = { yield: 2, ingredients: [{ name: 'Водка 40%', amount: 1, unit: 'л' }, { name: 'Ром', amount: .5, unit: 'л', abv: 60 }], process: 'Нагреть, затем отфильтровать.' };
  for (const factor of [.25, .5, 2, 4]) {
    const scaled = { ...recipe, yield: recipe.yield * factor, ingredients: recipe.ingredients.map(x => ({ ...x, amount: x.amount * factor })) };
    assert.equal(recipeAlcoholStrength(scaled).value, 35, String(factor));
    assert.match(recipeAlcoholStrength(scaled).message, /без учёта потерь/);
  }
});

test('strength survives normalization and differentiates imported records without changing legacy fingerprints', () => {
  const base = { name: 'Настойка', yield: 1, ingredients: [{ name: 'Водка', amount: 1, unit: 'л' }] };
  const legacy = 'tk2:{"name":"настойка","ingredients":[["водка",1000,"мл"]],"yield":1,"process":"","unparsedText":""}';
  assert.equal(recipeFingerprint(base), legacy);
  assert.equal(recipeFingerprint({ ...base, ingredients: [{ ...base.ingredients[0], abv: '' }] }), legacy);
  const withStrength = { ...base, ingredients: [{ ...base.ingredients[0], abv: '37,5' }] };
  assert.equal(normalizeRecipe(withStrength).ingredients[0].abv, '37,5');
  assert.equal(recipeAlcoholStrength(normalizeRecipe(withStrength)).value, 37.5);
  assert.equal(recipeFingerprint(withStrength), recipeFingerprint({ ...base, ingredients: [{ ...base.ingredients[0], abv: 37.5 }] }));
  assert.notEqual(recipeFingerprint(withStrength), recipeFingerprint(base));
  assert.notEqual(recipeFingerprint(withStrength), recipeFingerprint({ ...base, ingredients: [{ ...base.ingredients[0], abv: 40 }] }));
  assert.notEqual(recipeFingerprint({ ...base, ingredients: [{ ...base.ingredients[0], abv: 0 }] }), legacy);
});
