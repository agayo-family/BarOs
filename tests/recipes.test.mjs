import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIngredientsText, parseRecipeText, classifyRecipe,
  normalizeRecipe, recipeFingerprint, scaleProcess,
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
