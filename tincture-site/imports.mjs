import { parseRecipeText, parseIngredientsText, normalizeRecipe } from './recipes.mjs';

export const MAX_RECIPE_FILE_BYTES = 10 * 1024 * 1024;
// JSON backups include embedded photographs, so their base64 form is larger than the original image files.
export const MAX_JSON_RECIPE_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_IMPORTED_RECIPES = 10000;
let xlsxLoading;
const string = value => value == null ? '' : String(value).trim();
const key = value => string(value).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
const join = (...parts) => [...new Set(parts.flat().map(string).filter(Boolean))].join('\n');
const number = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = string(value).replace(/[\s\u00a0]/g, '').replace(',', '.');
  return text && /^[-+]?\d*\.?\d+$/.test(text) && Number.isFinite(Number(text)) ? Number(text) : null;
};

const ALIASES = {
  name: ['name', 'title', 'recipename', 'recipetitle', 'название', 'наименование', 'названиетк', 'названиенастойки', 'наименованиетк', 'настойка', 'технологическаякарта', 'тк'],
  ingredients: ['ingredients', 'composition', 'состав', 'ингредиенты', 'рецептура'],
  ingredient: ['ingredient', 'ingredientname', 'ингредиент', 'наименованиеингредиента', 'названиеингредиента', 'продукт', 'сырье'],
  amount: ['amount', 'quantity', 'qty', 'количество', 'колво', 'норма', 'масса', 'вес'],
  unit: ['unit', 'units', 'едизм', 'единица', 'единицаизмерения', 'единицыизмерения', 'ед'],
  cost: ['cost', 'price', 'цена', 'стоимость', 'себестоимость'],
  process: ['process', 'method', 'preparation', 'instructions', 'steps', 'процесс', 'процессприготовления', 'технология', 'технологияприготовления', 'приготовление', 'способприготовления', 'инструкция'],
  yield: ['yield', 'volume', 'output', 'выход', 'выходл', 'объем', 'объемл', 'обьем', 'объемготовогопродукта'],
  shelfLifeDays: ['shelflifedays', 'shelflife', 'expiry', 'срокгодности', 'срокгодностидней', 'срокхранения', 'срокхранениядней'],
  category: ['category', 'alcoholcategory', 'категория', 'категорияалкоголя', 'основнойалкоголь'],
  rawText: ['rawtext', 'исходныйтекст', 'полнаятк'],
  unparsedText: ['unparsedtext', 'notes', 'примечание', 'примечания', 'нераспознано', 'дополнительно']
};
const HEADERS = new Map(Object.entries(ALIASES).flatMap(([field, aliases]) => aliases.map(alias => [key(alias), field])));

function delimiterScore(text, separator) {
  let quoted = false, count = 0, rows = 0;
  for (let i = 0; i < text.length && rows < 12; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && char === separator) count++;
    else if (!quoted && char === '\n') rows++;
  }
  return count;
}

/** RFC-style quoted CSV/TSV, including embedded newlines and Excel's sep= prefix. */
export function parseDelimitedRows(input, preferredSeparator = '') {
  let text = String(input ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const explicit = text.match(/^sep=([;,\t|])\s*\n/i);
  if (explicit) text = text.slice(explicit[0].length);
  const separator = explicit?.[1] || preferredSeparator || [';', '\t', ',', '|'].sort((a, b) => delimiterScore(text, b) - delimiterScore(text, a))[0];
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const pushRow = () => { row.push(cell); if (row.some(value => string(value))) rows.push(row); row = []; cell = ''; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else cell += char;
    } else if (char === '"' && !cell.trim() && !closed) { cell = ''; quoted = true; }
    else if (char === separator) { row.push(cell); cell = ''; closed = false; }
    else if (char === '\n') pushRow();
    else if (closed && !/\s/.test(char)) throw new Error('Не удалось прочитать CSV: после закрывающей кавычки ожидается разделитель. Проверьте строку файла.');
    else if (!closed) cell += char;
  }
  if (quoted) throw new Error('Не удалось прочитать CSV: в файле есть незакрытая кавычка. Исправьте её и повторите импорт.');
  if (cell || row.length) pushRow();
  return rows;
}

function looksLikeFullRecipe(text) {
  return /(?:^|\n)\s*(?:состав|ингредиенты|выход|процесс|приготовление|технология|название|рецепт|ingredients|yield|preparation|process)\s*[:：]/im.test(text)
    || /\d[\d.,]*\s*(?:мл|л|кг|гр?|шт|ml|kg|g|liters?)(?:\b|(?=\s|$|[,;]))/i.test(text)
    || /(?:залить|смешать|добавить|настаивать|процедить|отфильтровать|нагреть|довести|перемешать|измельчить|взбить|охладить)(?=\s|$|[.,;:])/i.test(text)
    || text.split('\n').some(line => line.length > 140);
}

function textRecipes(text, fallbackName) {
  const clean = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!clean) return [];
  const separated = clean.split(/\n\s*(?:-{3,}|={3,})\s*\n/).filter(string);
  if (separated.length > 1) return separated.flatMap(part => textRecipes(part, fallbackName));
  if (!looksLikeFullRecipe(clean)) {
    return clean.split(/\r?\n/).map(line => line.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim())
      .filter(Boolean).filter(name => !['название', 'name', 'title', 'названиетк'].includes(key(name)))
      .map(name => normalizeRecipe({ name, rawText: name, ingredients: [], categoryMode: 'auto' }));
  }
  const parsed = parseRecipeText(clean);
  return [normalizeRecipe({ ...parsed, name: parsed.name || fallbackName })];
}

function headerIndex(rows) {
  return rows.findIndex((row, index) => {
    if (index > 14) return false;
    const fields = row.map(cell => HEADERS.get(key(cell))).filter(Boolean);
    if (!fields.length) return false;
    const singleTitleHeader = row.filter(cell => string(cell)).length === 1 && ['название', 'наименование', 'названиетк', 'name', 'title', 'recipename', 'ingredient', 'ингредиент'].includes(key(row.find(cell => string(cell))));
    return (fields.includes('name') || fields.includes('ingredient')) && (fields.length >= 2 || singleTitleHeader);
  });
}

function sourceRow(headers, row) {
  return row.map((value, column) => string(value) ? `${string(headers[column]) || `Колонка ${column + 1}`}: ${string(value)}` : '').filter(Boolean).join('\n');
}

function fieldsFromRow(headers, row) {
  const fields = {}, unknown = [];
  row.forEach((value, column) => {
    if (!string(value)) return;
    const field = HEADERS.get(key(headers[column]));
    if (field) fields[field] = fields[field] == null ? value : join(fields[field], value);
    else unknown.push(`${string(headers[column]) || `Колонка ${column + 1}`}: ${string(value)}`);
  });
  return { fields, unknown };
}

function draftFromFields(fields, raw, unknown, fallbackName) {
  const pieces = [
    `Название: ${string(fields.name) || fallbackName}`,
    fields.ingredients && `Состав:\n${fields.ingredients}`,
    fields.process && `Приготовление:\n${fields.process}`,
    fields.yield != null && `Выход: ${fields.yield}`,
    fields.shelfLifeDays != null && `Срок годности: ${fields.shelfLifeDays}`
  ].filter(Boolean).join('\n');
  const parsed = parseRecipeText(pieces);
  if (fields.rawText) {
    const original = parseRecipeText(string(fields.rawText));
    if (!fields.name && original.name) parsed.name = original.name;
    if (!fields.ingredients && original.ingredients?.length) parsed.ingredients = original.ingredients;
    if (!fields.process && original.process) parsed.process = original.process;
    if (fields.yield == null && original.yield != null) parsed.yield = original.yield;
    parsed.unparsedText = join(parsed.unparsedText, original.unparsedText);
  }
  const result = {
    ...parsed,
    name: string(fields.name) || parsed.name || fallbackName,
    process: string(fields.process) || parsed.process || '',
    rawText: join(fields.rawText, raw),
    unparsedText: join(parsed.unparsedText, fields.unparsedText, unknown),
    categoryMode: 'auto'
  };
  if (fields.yield != null && parsed.yield == null) result.unparsedText = join(result.unparsedText, `Выход: ${fields.yield}`);
  if (fields.shelfLifeDays != null && parsed.shelfLifeDays == null) result.unparsedText = join(result.unparsedText, `Срок годности: ${fields.shelfLifeDays}`);
  if (string(fields.category)) { result.category = string(fields.category); result.categoryMode = 'manual'; }
  return normalizeRecipe(result);
}

function ingredientFromFields(fields) {
  const name = string(fields.ingredient || fields.name);
  if (!name) return { ingredients: [], unparsedText: '' };
  const amount = number(fields.amount);
  const cost = number(fields.cost);
  const source = [name, string(fields.amount), string(fields.unit)].filter(Boolean).join(' — ');
  if (amount == null || amount < 0) return { ingredients: [], unparsedText: source };
  const parsed = parseIngredientsText(`${name} — ${amount} ${string(fields.unit)}`);
  const ingredients = parsed.ingredients?.length ? parsed.ingredients : [{ name, amount, unit: string(fields.unit), cost: 0 }];
  return {
    ingredients: ingredients.map(ingredient => ({ ...ingredient, cost: cost != null && cost >= 0 ? cost : 0 })),
    unparsedText: join(parsed.unparsedText, fields.cost != null && (cost == null || cost < 0) ? `Цена ${name}: ${fields.cost}` : '')
  };
}

/** Tabular recipes: one row per card, or one ingredient per row, with optional continued recipe names. */
export function recipesFromRows(inputRows, fallbackName = 'Импортированная ТК') {
  const rows = (inputRows || []).map(row => Array.from(row || [])).filter(row => row.some(value => string(value)));
  if (!rows.length) return [];
  const headerAt = headerIndex(rows);
  if (headerAt < 0) {
    if (rows.every(row => row.filter(value => string(value)).length === 1)) {
      const values = rows.map(row => string(row.find(value => string(value))));
      if (values.every(value => value.includes('\n') && looksLikeFullRecipe(value))) return values.flatMap(value => textRecipes(value, fallbackName));
      return textRecipes(values.join('\n'), fallbackName);
    }
    return textRecipes(rows.map(row => row.map(string).filter(Boolean).join(' — ')).join('\n'), fallbackName);
  }
  const headers = rows[headerAt];
  const headerFields = headers.map(header => HEADERS.get(key(header)));
  const legacyIngredients = headerFields.includes('name') && !headerFields.includes('ingredient') && headerFields.includes('amount') && headerFields.includes('unit') && !headerFields.some(field => ['ingredients', 'process', 'yield', 'category'].includes(field));
  const ingredientRows = legacyIngredients || headerFields.includes('ingredient');
  const results = [], grouped = new Map();
  let previousName = '';
  const preamble = rows.slice(0, headerAt).map(row => row.map(string).filter(Boolean).join(' | ')).join('\n');
  for (const row of rows.slice(headerAt + 1)) {
    if (row.every((value, column) => key(value) === key(headers[column]))) continue;
    const { fields, unknown } = fieldsFromRow(headers, row);
    const raw = sourceRow(headers, row);
    if (legacyIngredients) fields.ingredient = fields.name;
    let name = legacyIngredients ? fallbackName : string(fields.name);
    if (ingredientRows) {
      if (!name) name = previousName || fallbackName;
      else previousName = name;
      let draft = grouped.get(key(name));
      if (!draft) {
        draft = draftFromFields({ ...fields, name }, raw, join(preamble, unknown), fallbackName);
        draft.ingredients = draft.ingredients || [];
        grouped.set(key(name), draft); results.push(draft);
      } else {
        const partial = draftFromFields({ ...fields, name }, raw, unknown, fallbackName);
        draft.rawText = join(draft.rawText, partial.rawText);
        draft.unparsedText = join(draft.unparsedText, partial.unparsedText);
        draft.process = join(draft.process, partial.process);
        if (!draft.yield && partial.yield) draft.yield = partial.yield;
        if (!draft.shelfLifeDays && partial.shelfLifeDays) draft.shelfLifeDays = partial.shelfLifeDays;
        if (partial.categoryMode === 'manual') { draft.category = partial.category; draft.categoryMode = 'manual'; }
        draft.ingredients.push(...(partial.ingredients || []));
      }
      const ingredient = ingredientFromFields(fields);
      draft.ingredients.push(...ingredient.ingredients);
      draft.unparsedText = join(draft.unparsedText, ingredient.unparsedText);
    } else if (name || fields.rawText || fields.ingredients || fields.process) {
      results.push(draftFromFields(fields, raw, join(preamble, unknown), fallbackName));
    } else if (results.length) {
      const last = results[results.length - 1];
      last.unparsedText = join(last.unparsedText, raw);
      last.rawText = join(last.rawText, raw);
    } else {
      results.push(normalizeRecipe({ name: fallbackName, ingredients: [], categoryMode: 'auto', rawText: raw, unparsedText: join(preamble, raw) }));
    }
  }
  return results.map(recipe => normalizeRecipe(recipe));
}

async function getXlsx() {
  if (globalThis.XLSX) return globalThis.XLSX;
  if (!globalThis.document) throw new Error('Модуль чтения Excel недоступен. Обновите страницу и повторите импорт.');
  if (!xlsxLoading) xlsxLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('./vendor/xlsx.full.min.js', import.meta.url).href;
    script.onload = () => globalThis.XLSX ? resolve(globalThis.XLSX) : reject(new Error('Не удалось запустить модуль чтения Excel. Обновите страницу.'));
    script.onerror = () => reject(new Error('Не удалось загрузить модуль чтения Excel. Подключитесь к интернету и обновите страницу.'));
    document.head.appendChild(script);
  }).catch(error => { xlsxLoading = undefined; throw error; });
  return xlsxLoading;
}

function jsonRecipes(value, fallbackName) {
  const list = Array.isArray(value) ? value : value && Array.isArray(value.recipes) ? value.recipes : [value];
  if (!list.length) return [];
  if (list.length > MAX_IMPORTED_RECIPES) throw new Error('В одном файле можно импортировать не более 10 000 ТК. Разделите коллекцию на несколько файлов.');
  return list.map((entry, index) => {
    if (typeof entry === 'string') return normalizeRecipe({ name: entry.trim(), ingredients: [], rawText: entry, categoryMode: 'auto' });
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Некорректная ТК №${index + 1} в JSON: ожидается объект с названием.`);
    if (!string(entry.name) && !string(entry.title)) throw new Error(`В ТК №${index + 1} в JSON отсутствует название. Добавьте поле name.`);
    if (entry.ingredients != null && !Array.isArray(entry.ingredients) && typeof entry.ingredients !== 'string') throw new Error(`Некорректный состав ТК №${index + 1} в JSON: ingredients должен быть списком ингредиентов или текстом. Исправьте структуру файла.`);
    if (entry.photos != null && !Array.isArray(entry.photos)) throw new Error(`Некорректные фотографии ТК №${index + 1} в JSON: photos должен быть списком. Исправьте структуру файла.`);
    const recipe = { ...entry, name: string(entry.name || entry.title) || fallbackName };
    if (typeof recipe.ingredients === 'string') {
      const parsed = parseIngredientsText(recipe.ingredients);
      recipe.rawText = join(recipe.rawText, recipe.ingredients);
      recipe.unparsedText = join(recipe.unparsedText, parsed.unparsedText);
      recipe.ingredients = parsed.ingredients;
    }
    if (!recipe.categoryMode) recipe.categoryMode = string(recipe.category) ? 'manual' : 'auto';
    return normalizeRecipe(recipe);
  }).filter(recipe => string(recipe.name));
}

async function readText(file) {
  if (typeof file.arrayBuffer !== 'function') return file.text();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1251').decode(bytes); }
}

/** Read local files without uploading them or changing stored cards. The caller previews/saves the returned recipes. */
export async function readRecipeFile(file, fallbackName = '') {
  if (!file || typeof file !== 'object') throw new Error('Выберите файл с технологическими картами.');
  const extension = string(file.name).split('.').pop().toLowerCase();
  const maxBytes = extension === 'json' ? MAX_JSON_RECIPE_FILE_BYTES : MAX_RECIPE_FILE_BYTES;
  if (Number(file.size) > maxBytes) throw new Error(extension === 'json'
    ? 'Файл JSON слишком большой. Максимальный размер — 100 МБ. Разделите коллекцию ТК на несколько файлов.'
    : 'Файл слишком большой. Максимальный размер Excel, CSV и TXT — 10 МБ. Разделите его на несколько файлов.');
  if (Number(file.size) === 0) throw new Error('Файл пуст. Добавьте названия или состав технологических карт.');
  const name = fallbackName || string(file.name).replace(/\.[^.]+$/, '') || 'Импортированная ТК';
  let recipes;
  if (extension === 'xlsx' || extension === 'xls') {
    const XLSX = await getXlsx();
    let workbook;
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const zip = data[0] === 0x50 && data[1] === 0x4b;
      const ole = data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0;
      const xml = /^\s*(?:<\?xml[^>]*>\s*)?<(?:\w+:)?Workbook\b/i.test(new TextDecoder().decode(data.slice(0, 1000)));
      if (!(zip || extension === 'xls' && (ole || xml))) throw new Error('Неверный формат Excel.');
      workbook = XLSX.read(data, { type: 'array', cellDates: false });
    } catch { throw new Error('Не удалось прочитать Excel. Файл повреждён, защищён паролем или имеет другой формат. Сохраните его как .xlsx и повторите импорт.'); }
    recipes = workbook.SheetNames.flatMap(sheetName => recipesFromRows(XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '', blankrows: false }), name));
  } else if (['json', 'txt', 'csv', 'tsv'].includes(extension)) {
    let text;
    try { text = await readText(file); } catch { throw new Error('Не удалось открыть файл. Выберите его ещё раз.'); }
    if (extension === 'json') {
      let data;
      try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('Не удалось прочитать JSON: проверьте кавычки, запятые и структуру файла.'); }
      recipes = jsonRecipes(data, name);
    } else if (extension === 'txt') recipes = textRecipes(text, name);
    else recipes = recipesFromRows(parseDelimitedRows(text, extension === 'tsv' ? '\t' : ''), name);
  } else throw new Error('Этот формат не поддерживается. Выберите Excel (.xlsx, .xls), CSV, TXT или JSON.');
  if (!recipes?.length) throw new Error('В файле не найдены технологические карты. Добавьте хотя бы одно название.');
  if (recipes.length > MAX_IMPORTED_RECIPES) throw new Error('В одном файле можно импортировать не более 10 000 ТК. Разделите коллекцию на несколько файлов.');
  return recipes;
}
