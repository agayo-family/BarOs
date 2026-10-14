import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { MAX_RECIPE_FILE_BYTES, MAX_JSON_RECIPE_FILE_BYTES, MAX_IMPORTED_RECIPES, parseDelimitedRows, recipesFromRows, readRecipeFile } from '../tincture-site/imports.mjs';

// The browser vendor bundle is UMD. Evaluate its CommonJS branch independently
// of the application's package type so the real XLS/XLSX regression cases run.
const vendorExports = {};
const loadVendor = vm.runInThisContext('(function(exports, module) {\n' + await readFile(new URL('../tincture-site/vendor/xlsx.full.min.js', import.meta.url), 'utf8') + '\n})', { filename: 'xlsx.full.min.js' });
loadVendor(vendorExports, { exports: vendorExports });
globalThis.XLSX = vendorExports;
const file = (name, value) => {
  const data = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
  return { name, size: data.length, text: async () => data.toString('utf8'), arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
};
const excelFile = (sheets, bookType = 'xlsx') => {
  const workbook = XLSX.utils.book_new();
  sheets.forEach(([name, rows]) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name));
  return file(`карты.${bookType}`, XLSX.write(workbook, { type: 'buffer', bookType }));
};

test('quoted CSV preserves separator, quotes, and multiline process', () => {
  assert.deepEqual(parseDelimitedRows('Название;Состав;Процесс\r\n"Клюква; джин";"Джин 1 л\nКлюква 200 г";"Сказать ""готово"""'), [
    ['Название', 'Состав', 'Процесс'], ['Клюква; джин', 'Джин 1 л\nКлюква 200 г', 'Сказать "готово"']
  ]);
});

test('Excel sep marker is respected', () => {
  assert.deepEqual(parseDelimitedRows('\uFEFFsep=;\nНазвание;Выход\nКлюква;1,5'), [['Название', 'Выход'], ['Клюква', '1,5']]);
});

test('tab, pipe, comma delimiters are detected', () => {
  for (const delimiter of ['\t', '|', ',']) assert.deepEqual(parseDelimitedRows(`Название${delimiter}Состав\nВишня${delimiter}Водка`), [['Название', 'Состав'], ['Вишня', 'Водка']]);
});

test('malformed CSV quotes produce a readable error', () => {
  assert.throws(() => parseDelimitedRows('Название;Состав\n"Клюква;Водка'), /незакрытая кавычка/);
  assert.throws(() => parseDelimitedRows('"Клюква"слово;Водка'), /после закрывающей кавычки/);
});

test('names-only text imports incomplete cards without creating a header card', async () => {
  const recipes = await readRecipeFile(file('названия.txt', 'Название\nКлюква\nВишня\nЛимон'));
  assert.deepEqual(recipes.map(recipe => recipe.name), ['Клюква', 'Вишня', 'Лимон']);
  assert.ok(recipes.every(recipe => !recipe.ingredients.length && recipe.yield == null));
});

test('whole recipe text imports ingredients and process while keeping original source', async () => {
  const text = 'Название: Клюква\nСостав:\nВодка — 1 л\nКлюква — 200 г\nПриготовление:\nЗалить клюкву водкой. Настаивать 7 дней.';
  const [recipe] = await readRecipeFile(file('карта.txt', text));
  assert.equal(recipe.name, 'Клюква');
  assert.equal(recipe.ingredients.length, 2);
  assert.match(recipe.process, /Настаивать 7 дней/);
  assert.equal(recipe.rawText, text);
});

test('full text sections separated by lines import separate recipes', async () => {
  const recipes = await readRecipeFile(file('карты.txt', 'Название: Клюква\nСостав:\nВодка 1 л\n---\nНазвание: Вишня\nСостав:\nДжин 1 л'));
  assert.deepEqual(recipes.map(recipe => recipe.name), ['Клюква', 'Вишня']);
});

test('semicolon CSV supports decimal comma and explicit manual category', async () => {
  const [recipe] = await readRecipeFile(file('карты.csv', 'Название;Состав;Процесс;Выход;Категория;Срок годности, дней;Комментарий\nКлюква;"Водка 1 л\nКлюква 200 г";Настаивать 7 дней;1,5;Особая;30;Пробный розлив'));
  assert.equal(recipe.name, 'Клюква');
  assert.equal(recipe.yield, 1.5);
  assert.equal(recipe.shelfLifeDays, 30);
  assert.equal(recipe.categoryMode, 'manual');
  assert.equal(recipe.category, 'Особая');
  assert.match(recipe.unparsedText, /Комментарий: Пробный розлив/);
});

test('legacy ingredient CSV creates one recipe with filename fallback', async () => {
  const [recipe] = await readRecipeFile(file('Лимонная.csv', 'name,amount,unit,cost\nВодка,1,l,300\nЛимон,0.2,kg,100'));
  assert.equal(recipe.name, 'Лимонная');
  assert.deepEqual(recipe.ingredients.map(({ name, amount, unit, cost }) => ({ name, amount, unit, cost })), [
    { name: 'Водка', amount: 1, unit: 'л', cost: 300 }, { name: 'Лимон', amount: 0.2, unit: 'кг', cost: 100 }
  ]);
});

test('ingredient rows group cards and carry forward blank recipe names', async () => {
  const recipes = await readRecipeFile(file('карты.csv', 'recipeName;ingredient;amount;unit;cost;Комментарий\nКлюква;Водка;1,5;л;300;Без косточек\n;Клюква;200;г;100;\nВишня;Джин;1;л;400;'));
  assert.equal(recipes.length, 2);
  assert.equal(recipes[0].ingredients.length, 2);
  assert.equal(recipes[0].ingredients[0].amount, 1.5);
  assert.equal(recipes[1].name, 'Вишня');
  assert.match(recipes[0].unparsedText, /Без косточек/);
});

test('bad ingredient quantity is preserved for manual correction', async () => {
  const [recipe] = await readRecipeFile(file('карты.csv', 'Название;Ингредиент;Количество;Ед. изм.\nКлюква;Водка;один;л'));
  assert.equal(recipe.ingredients.length, 0);
  assert.match(recipe.unparsedText, /Водка.*один.*л/);
});

test('repeated table headers do not become cards', () => {
  const recipes = recipesFromRows([['Название', 'Состав'], ['Вишня', 'Водка 1 л'], ['Название', 'Состав'], ['Клюква', 'Джин 1 л']]);
  assert.deepEqual(recipes.map(recipe => recipe.name), ['Вишня', 'Клюква']);
});

test('unknown rows and preamble remain available', () => {
  const [recipe] = recipesFromRows([['База цеха, октябрь'], ['Название', 'Состав', 'Упаковка'], ['Клюква', 'Водка 1 л', 'Стекло'], ['', '', 'Наклейка красная']]);
  assert.match(recipe.unparsedText, /База цеха/);
  assert.match(recipe.unparsedText, /Упаковка: Стекло/);
  assert.match(recipe.unparsedText, /Наклейка красная/);
});

test('unheaded names sheet keeps first row and generic tincture name', () => {
  assert.deepEqual(recipesFromRows([['Настойка'], ['Клюква'], ['Вишня']]).map(recipe => recipe.name), ['Настойка', 'Клюква', 'Вишня']);
});

test('JSON accepts one recipe, array, and backup recipes array', async () => {
  for (const data of [{ name: 'Клюква', ingredients: [] }, [{ name: 'Клюква' }], { recipes: [{ name: 'Клюква' }] }]) {
    const [recipe] = await readRecipeFile(file('карты.json', JSON.stringify(data)));
    assert.equal(recipe.name, 'Клюква');
    assert.equal(recipe.yield, null);
  }
});

test('JSON explicit manual category and metadata are preserved', async () => {
  const [recipe] = await readRecipeFile(file('карты.json', JSON.stringify({ name: 'Клюква', category: 'Моя категория', photos: ['data:image/png;base64,abc'], custom: 'Не терять', rawText: 'Оригинал', unparsedText: 'Проверить' })));
  assert.equal(recipe.categoryMode, 'manual');
  assert.equal(recipe.category, 'Моя категория');
  assert.equal(recipe.custom, 'Не терять');
  assert.deepEqual(recipe.photos, ['data:image/png;base64,abc']);
  assert.match(recipe.unparsedText, /Проверить/);
});

test('JSON photograph backups larger than the spreadsheet limit can be reimported', async () => {
  const photos = [
    { id: 'photo-one', name: 'ягоды.jpg', type: 'image/jpeg', data: 'data:image/jpeg;base64,YWJj', caption: 'Перед настаиванием' },
    'data:image/png;base64,ZGVm'
  ];
  const source = { recipes: [
    { id: 'recipe-one', name: 'Клюква', photos, ingredients: [], categoryMode: 'manual', category: 'Моя категория', updatedAt: '2026-10-12T12:00:00.000Z', importSignatures: ['tk2:original'] },
    { id: 'recipe-two', name: 'Вишня', photos: ['data:image/webp;base64,eHl6'], archived: true, ingredients: [] }
  ] };
  const backup = { ...file('экспорт.json', JSON.stringify(source)), size: MAX_RECIPE_FILE_BYTES + 4 * 1024 * 1024 };
  const restored = await readRecipeFile(backup);
  assert.deepEqual(restored[0].photos, photos);
  assert.deepEqual(restored[0].importSignatures, ['tk2:original']);
  assert.equal(restored[0].id, 'recipe-one');
  assert.equal(restored[0].categoryMode, 'manual');
  assert.equal(restored[0].updatedAt, source.recipes[0].updatedAt);
  assert.equal(restored[1].archived, true);
  assert.deepEqual(restored[1].photos, source.recipes[1].photos);
});

test('JSON size limit is 100 MiB while large Excel and text retain the 10 MiB bound', async () => {
  const backup = { ...file('экспорт.json', '[{"name":"Клюква","photos":[]}]'), size: MAX_JSON_RECIPE_FILE_BYTES };
  assert.equal((await readRecipeFile(backup))[0].name, 'Клюква');
  await assert.rejects(readRecipeFile({ ...backup, size: MAX_JSON_RECIPE_FILE_BYTES + 1 }), /100 МБ/);
  for (const name of ['большой.xlsx', 'большой.xls', 'большой.csv', 'большой.txt']) {
    await assert.rejects(readRecipeFile({ name, size: MAX_RECIPE_FILE_BYTES + 1 }), /10 МБ/);
  }
});

test('oversized card collections fail atomically with an instruction to split the file', async () => {
  const large = Array.from({ length: MAX_IMPORTED_RECIPES + 1 }, (_, index) => ({ name: `ТК ${index}` }));
  await assert.rejects(readRecipeFile(file('коллекция.json', JSON.stringify(large))), /не более 10 000 ТК/);
  await assert.rejects(readRecipeFile(file('названия.txt', large.map(recipe => recipe.name).join('\n'))), /не более 10 000 ТК/);
});

test('JSON string composition uses the common ingredient parser', async () => {
  const [recipe] = await readRecipeFile(file('карты.json', JSON.stringify({ name: 'Клюква', ingredients: 'Водка 1 л\nКлюква 200 г\nпроверить качество' })));
  assert.equal(recipe.ingredients.length, 2);
  assert.match(recipe.unparsedText, /проверить качество/);
});

test('JSON invalid structure is rejected instead of silently losing records', async () => {
  await assert.rejects(readRecipeFile(file('карты.json', '{broken')), /Не удалось прочитать JSON/);
  await assert.rejects(readRecipeFile(file('карты.json', '[{"name":"Клюква"},42]')), /ТК №2/);
  await assert.rejects(readRecipeFile(file('карты.json', '{"ingredients":[]}')), /отсутствует название/);
  await assert.rejects(readRecipeFile(file('карты.json', '{"name":"Клюква","ingredients":{"Водка":"1 л"}}')), /Некорректный состав/);
  await assert.rejects(readRecipeFile(file('карты.json', '{"name":"Клюква","photos":{"data":"data:image/png;base64,abc"}}')), /Некорректные фотографии/);
});

test('size, empty files, unsupported formats have readable errors', async () => {
  await assert.rejects(readRecipeFile({ name: 'large.csv', size: MAX_RECIPE_FILE_BYTES + 1 }), /10 МБ/);
  await assert.rejects(readRecipeFile(file('пусто.txt', '')), /Файл пуст/);
  await assert.rejects(readRecipeFile(file('пусто.csv', 'Название;Состав')), /не найдены/);
  await assert.rejects(readRecipeFile(file('карта.pdf', 'PDF')), /не поддерживается/);
});

test('Excel XLSX imports multiple sheets including names-only and unknown columns', async () => {
  const recipes = await readRecipeFile(excelFile([
    ['Названия', [['Название'], ['Клюква'], ['Вишня']]],
    ['Рецепты', [['Название', 'Состав', 'Выход', 'Комментарий'], ['Лимон', 'Водка 1 л\nЛимон 100 г', 1.2, 'Без кожуры']]]
  ]));
  assert.deepEqual(recipes.map(recipe => recipe.name), ['Клюква', 'Вишня', 'Лимон']);
  assert.equal(recipes[2].yield, 1.2);
  assert.equal(recipes[2].ingredients.length, 2);
  assert.match(recipes[2].unparsedText, /Комментарий: Без кожуры/);
});

test('legacy binary XLS is supported with Cyrillic ingredient rows', async () => {
  const [recipe] = await readRecipeFile(excelFile([['Карта', [['Название', 'Ингредиент', 'Количество', 'Ед. изм.'], ['Вишня', 'Водка', 1, 'л'], ['', 'Вишня', 0.2, 'кг']]]], 'xls'));
  assert.equal(recipe.name, 'Вишня');
  assert.equal(recipe.ingredients.length, 2);
  assert.equal(recipe.ingredients[1].name, 'Вишня');
});

test('corrupted Excel file is rejected with repair instructions', async () => {
  await assert.rejects(readRecipeFile(file('карта.xlsx', 'Название;Состав')), /повреждён.*\.xlsx/);
});

test('UTF-16 Excel text export and Windows-1251 names are recognized', async () => {
  const [utf16] = await readRecipeFile(file('экспорт.csv', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Название;Выход\nКлюква;1,2', 'utf16le')])));
  assert.equal(utf16.name, 'Клюква');
  assert.equal(utf16.yield, 1.2);
  const [cp1251] = await readRecipeFile(file('список.txt', Buffer.from([0xca, 0xeb, 0xfe, 0xea, 0xe2, 0xe0])));
  assert.equal(cp1251.name, 'Клюква');
});
