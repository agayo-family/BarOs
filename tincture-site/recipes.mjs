// Recipe helpers share the existing recipe schema. Original source text is retained
// separately so recognition never turns an uncertain line into missing data.
const ALCOHOL_RULES = [
  ['Водка', /(?:^|[^\p{L}])(?:водк[а-я]*|vodka|absolut|абсолют|finlandia|финляндия|beluga|белуга|русский\s+стандарт)(?=$|[^\p{L}])/iu],
  ['Джин', /(?:^|[^\p{L}])(?:джин(?:а|у|ом|е)?|gin|beefeater|бифитер|gordon'?s|гордонс|bombay\s+sapphire|бомбей|tanqueray|танкерей|roku)(?=$|[^\p{L}])/iu],
  ['Ром', /(?:^|[^\p{L}])(?:ром(?:а|у|ом|е)?|rum|bacardi|бакарди|havana\s+club|гавана\s+клаб|captain\s+morgan|капитан\s+морган)(?=$|[^\p{L}])/iu],
  ['Текила', /(?:^|[^\p{L}])(?:текил[а-я]*|tequila|мескал[а-я]*|mezcal|olmeca|ольмека|jose\s+cuervo|хосе\s+куэрво)(?=$|[^\p{L}])/iu],
  ['Виски', /(?:^|[^\p{L}])(?:виски|whisk[ey]+|бурбон[а-я]*|bourbon|scotch|скотч|джек\s+дэниэлс|jack\s+daniel'?s|jameson|джемесон|chivas|чивас|johnnie\s+walker|джонни\s+уокер|jim\s+beam|джим\s+бим)(?=$|[^\p{L}])/iu],
  ['Бренди / Коньяк', /(?:^|[^\p{L}])(?:бренди|коньяк[а-я]*|cognac|brandy|кальвадос[а-я]*|calvados|арманьяк[а-я]*|armagnac)(?=$|[^\p{L}])/iu],
  ['Спирт', /(?:^|[^\p{L}])(?:спирт[а-я]*|ethanol|этанол[а-я]*|дистиллят[а-я]*|самогон[а-я]*)(?=$|[^\p{L}])/iu],
  ['Вермут', /(?:^|[^\p{L}])(?:вермут[а-я]*|vermouth|martini|мартини|чинзано|cinzano)(?=$|[^\p{L}])/iu],
  ['Вино', /(?:^|[^\p{L}])(?:вин(?:о|а|ом|у|е)|wine|портвейн[а-я]*|херес[а-я]*|sherry|шампанск[а-я]*|champagne|prosecco|просекко|игрист(?:ое|ого|ым)|мадер[а-я]*|madera)(?=$|[^\p{L}])/iu],
  ['Ликёр', /(?:^|[^\p{L}])(?:лик[её]р[а-я]*|liqueur|амаретто|amaretto|лимончелло|limoncello|бейлис|baileys|куантро|cointreau|triple\s+sec|трипл\s+сек|самбук[а-я]*|sambuca|апероль|aperol|кампари|campari)(?=$|[^\p{L}])/iu],
  ['Пиво', /(?:^|[^\p{L}])(?:пив(?:о|а|ом|у)|beer|эль|эля|lager|лагер[а-я]*|стаут[а-я]*|stout)(?=$|[^\p{L}])/iu],
  ['Саке', /(?:^|[^\p{L}])(?:саке|sake)(?=$|[^\p{L}])/iu],
  ['Абсент', /(?:^|[^\p{L}])(?:абсент[а-я]*|absinthe)(?=$|[^\p{L}])/iu],
];

export const ALCOHOL_CATEGORIES = ALCOHOL_RULES.map(([category]) => category);
const UNKNOWN_ALCOHOL = /(?:^|[^\p{L}])(?:алкогол[а-я]*|настойк[а-я]*|наливк[а-я]*|основа|основы|база|базы|liquor|alcohol|spirit)(?=$|[^\p{L}])/iu;
const NON_ALCOHOLIC = /без\s*[-–—]?\s*алкогол[а-я]*|(?:^|[^\p{L}])безалк(?:ог)?\.?(?=$|[^\p{L}])|без\s+спирта|non\s*[-–—]?\s*alcoholic|alcohol\s*[-–—]?\s*free|\b0[.,]0\s*%|(?:^|\s)0\s*%|(?:^|[^\p{L}])б\s*\/\s*(?:алк|а)\.?(?=$|[^\p{L}])/iu;

const UNIT_MAP = new Map([
  ...['г','гр','грамм','грамма','граммов','g','gr','gram','grams'].map(x => [x, 'г']),
  ...['кг','килограмм','килограмма','килограммов','kg','kgs'].map(x => [x, 'кг']),
  ...['мг','миллиграмм','миллиграмма','миллиграммов','mg'].map(x => [x, 'мг']),
  ...['мл','миллилитр','миллилитра','миллилитров','ml','mls'].map(x => [x, 'мл']),
  ...['л','литр','литра','литров','l','lt','liter','litre','liters','litres'].map(x => [x, 'л']),
  ...['сл','cl'].map(x => [x, 'сл']), ...['дл','dl'].map(x => [x, 'дл']),
  ...['шт','штук','штука','штуки','pc','pcs','piece','pieces'].map(x => [x, 'шт']),
  ...['ч.л','ч. л','ч л','чл','чайная ложка','чайные ложки','чайных ложек','tsp'].map(x => [x, 'ч. л.']),
  ...['ст.л','ст. л','ст л','стл','столовая ложка','столовые ложки','столовых ложек','tbsp'].map(x => [x, 'ст. л.']),
  ...['щепотка','щепотки','щепоток'].map(x => [x, 'щепотка']),
]);
const UNIT_SOURCE = '(?:ст\\.?\\s*л\\.?|ч\\.?\\s*л\\.?|чайная\\s+ложка|чайные\\s+ложки|чайных\\s+ложек|столовая\\s+ложка|столовые\\s+ложки|столовых\\s+ложек|килограмм(?:а|ов)?|миллиграмм(?:а|ов)?|миллилитр(?:а|ов)?|грамм(?:а|ов)?|литр(?:а|ов)?|щепот(?:ка|ки|ок)|pieces?|litres?|liters?|grams?|штук[аи]?|шт\\.?|кг\\.?|мг\\.?|гр\\.?|мл\\.?|сл\\.?|дл\\.?|kg|kgs|mg|mls?|cl|dl|pcs?|tsp|tbsp|gr|lt|g|l|г\\.?|л\\.?)';
const NUMBER_SOURCE = '(?:\\d+\\s+\\d+\\s*\/\\s*\\d+|(?:\\d+(?:[ \\u00a0]\\d{3})*(?:[.,]\\d+)?|[.,]\\d+)(?:\\s*\/\\s*\\d+)?|[½¼¾])';
const QUANTITY_SOURCE = `(?<![\\p{L}\\p{N}.,/])(${NUMBER_SOURCE})\\s*(${UNIT_SOURCE})(?![\\p{L}])`;
const quantityRegex = (flags = 'giu') => new RegExp(QUANTITY_SOURCE, flags);
const clean = value => String(value ?? '').replace(/(\d)\s*([½¼¾])/g, '$1 $2').replace(/½/g, '1/2').replace(/¼/g, '1/4').replace(/¾/g, '3/4').normalize('NFKC').replace(/\u00a0/g, ' ').trim();
const normText = value => clean(value).toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');
const round = value => Math.round((Number(value) + Number.EPSILON) * 1e8) / 1e8;

function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const fractions = { '½': .5, '¼': .25, '¾': .75 };
  const source = String(value ?? '').trim();
  const unicodeMixed = source.match(/^(\d+)\s*([½¼¾])$/);
  if (unicodeMixed) return Number(unicodeMixed[1]) + fractions[unicodeMixed[2]];
  const mixed = source.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) return Number(mixed[3]) ? Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]) : null;
  const raw = source.replace(/[ \u00a0]/g, '').replace(',', '.');
  if (Object.hasOwn(fractions, raw)) return fractions[raw];
  if (/^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/.test(raw)) {
    const [top, bottom] = raw.split('/').map(Number);
    return bottom ? top / bottom : null;
  }
  if (!/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function unit(value) {
  const original = clean(value);
  const key = original.toLowerCase().replace(/\.$/, '').replace(/\s+/g, ' ');
  return UNIT_MAP.get(key) || original;
}

function appendText(a, b) {
  const parts = [clean(a), clean(b)].filter(Boolean).flatMap(value => value.split('\n'));
  return [...new Set(parts)].join('\n');
}

function stripBullet(line) {
  return clean(line).replace(/^(?:[•●▪*]+\s*|[-–—]+(?:\s+|(?=[^\d\s]))|\d+[.)]\s+(?=\D))/, '').trim();
}

function splitIngredientSegments(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split(/\n/).flatMap(line => {
    // A semicolon may be the old four-column input format; preserve that row.
    const cells = line.split(';').map(clean);
    if (cells.length >= 3 && number(cells[1]) !== null && UNIT_MAP.has(normText(cells[2]).replace(/\.$/, ''))) return [line];
    return line.split(/;|,(?!\d)/u).flatMap(segment => {
      const pieces = [];
      let start = 0;
      for (const conjunction of segment.matchAll(/\s+и\s+/giu)) {
        const left = segment.slice(start, conjunction.index);
        const right = segment.slice(conjunction.index + conjunction[0].length);
        if (quantityRegex('iu').test(left) && quantityRegex('iu').test(right)) {
          pieces.push(left); start = conjunction.index + conjunction[0].length;
        }
      }
      pieces.push(segment.slice(start));
      return pieces;
    });
  }).map(stripBullet).filter(Boolean);
}

function ingredientFromSegment(segment) {
  let line = stripBullet(segment).replace(/^(?:состав|ингредиенты|компоненты)\s*[:：]\s*/iu, '');
  if (!line) return { ingredient: null, rest: '' };
  const cells = line.split(line.includes('|') ? '|' : ';').map(clean);
  if (cells.length >= 2 && number(cells[1]) !== null) {
    if (/\//u.test(cells[2] || '')) return { ingredient: null, rest: line };
    const amount = number(cells[1]);
    const ingredient = cells[0] && amount >= 0 ? { name: cells[0], amount, unit: unit(cells[2] || 'шт'), cost: number(cells[3]) ?? 0 } : null;
    const rest = [...(cells.length > 4 ? cells.slice(4) : []), ...(cells[3] && number(cells[3]) === null ? [`Цена не распознана: ${cells[3]}`] : [])].join(' | ');
    return { ingredient, rest };
  }
  const matches = [...line.matchAll(quantityRegex())];
  if (matches.length !== 1) return { ingredient: null, rest: line };
  const match = matches[0];
  if (/(?:\d\s*[-–—]\s*|[-−])$/.test(line.slice(0, match.index))) return { ingredient: null, rest: line };
  if (/^\s*\//u.test(line.slice(match.index + match[0].length))) return { ingredient: null, rest: line };
  let before = line.slice(0, match.index).trim();
  let after = line.slice(match.index + match[0].length).trim();
  before = before.replace(/\s*[-–—:=]+\s*$/, '').replace(/^(?:примерно|около)\s+/iu, '').trim();
  after = after.replace(/^\s*[-–—:=]+\s*/, '').replace(/[.;]+$/, '').trim();
  // Only a leading quantity or a trailing quantity is unambiguous. Commentary
  // after a normal "name quantity" row remains visible for manual review.
  let name = before || after;
  let rest = '';
  if (before && after) {
    if (/^[([][^\])]*[\])]$/.test(after) && /\d\s*%|жирн|крепост/iu.test(after)) name = `${before} ${after}`;
    else rest = after;
  }
  name = name.replace(/^(?:добавить|добавьте|взять|возьмите|нужно|требуется)\s+/iu, '').replace(/\s*[-–—:,]+\s*$/, '').trim();
  if (!name || /^[-+]?\d+[.,]?\d*$/.test(name)) return { ingredient: null, rest: line };
  const amount = number(match[1]);
  if (amount === null || amount < 0) return { ingredient: null, rest: line };
  return { ingredient: { name, amount, unit: unit(match[2]), cost: 0 }, rest };
}

export function parseIngredientsText(text) {
  const ingredients = [];
  const unparsed = [];
  for (const segment of splitIngredientSegments(text)) {
    if (/^(?:состав|ингредиенты|компоненты)\s*:?$/iu.test(segment)) continue;
    const { ingredient, rest } = ingredientFromSegment(segment);
    if (ingredient) ingredients.push(ingredient);
    if (rest || !ingredient) unparsed.push(rest || segment);
  }
  return { ingredients, unparsedText: unparsed.join('\n') };
}

const INGREDIENT_HEADING = /^(?:состав|ингредиенты|компоненты|рецептура|раскладка)(?=\s|:|：|$)(?:\s+(?:на\s+.*|настойки))?\s*[:：]?\s*(.*)$/iu;
const PROCESS_HEADING = /^(?:способ\s+приготовления|процесс(?:\s+приготовления)?|приготовление|технология(?:\s+приготовления)?|этапы(?:\s+приготовления)?|инструкция)(?=\s|:|：|$)\s*[:：]?\s*(.*)$/iu;
const PROCESS_VERB = /^(?:\d+[.)]\s*)?(?:смешать|смешайте|соединить|соедините|залить|залейте|добавить|добавьте|влить|влейте|настоять|настаивать|настаивайте|процедить|процедите|фильтровать|отфильтровать|перемешать|перемешайте|измельчить|измельчите|нагревать|нагреть|довести|дать|оставить|выдержать|взболтать|разлить|разлейте|снять|удалить|охладить|вскипятить|растворить|положить|помыть|промыть|нарезать|порезать|вымыть|взбить)(?=$|[^\p{L}])/iu;

export function parseRecipeText(text) {
  const rawText = String(text ?? '');
  const recipe = { name: '', yield: null, shelfLifeDays: null, ingredients: [], process: '', rawText, unparsedText: '', categoryMode: 'auto', primaryAlcohol: '', alcoholCandidates: [] };
  const unknown = [];
  const process = [];
  let section = '';
  let titleTaken = false;
  const lines = rawText.replace(/\r\n?/g, '\n').split('\n').map(clean).filter(Boolean);
  for (const original of lines) {
    const line = stripBullet(original);
    const explicitTitle = !section && !titleTaken && line.match(/^(?:технологическая\s+карта|техкарта|тк)(?=\s|:|：)(?:\s*[:：]\s*|\s+)(.+)$/iu);
    if (explicitTitle) {
      const title = explicitTitle[1].replace(/^(?:№|No\.?)\s*\d+\s*[.:-]?\s*/iu, '').trim();
      const withOutput = title.match(new RegExp(`^(.*?)\\s*(?:\\(\\s*)?(${NUMBER_SOURCE})\\s*(${UNIT_SOURCE})\\s*\\)?$`, 'iu'));
      const outputUnit = withOutput && unit(withOutput[3]);
      if (withOutput && clean(withOutput[1]) && ['л','мл','сл','дл'].includes(outputUnit) && !/(?:\d\s*[-–—]\s*|[-−])$/.test(withOutput[1].trim())) {
        recipe.name = withOutput[1].replace(/\s*[-–—:,]+\s*$/u, '').trim();
        const outputAmount = number(withOutput[2]);
        if (outputAmount > 0) recipe.yield = round(outputAmount * ({'л':1,'мл':.001,'сл':.01,'дл':.1}[outputUnit]));
        else unknown.push(`Выход из заголовка требует проверки: ${withOutput[2]} ${withOutput[3]}`);
      } else recipe.name = title || explicitTitle[1];
      titleTaken = true;
      continue;
    }
    const nameMatch = line.match(/^(?:название(?:\s+тк|\s+карты)?|наименование|настойка|технологическая\s+карта|техкарта|тк)\s*[:：]\s*(.+)$/iu);
    if (!section && nameMatch && !titleTaken) { recipe.name = nameMatch[1].trim(); titleTaken = true; continue; }
    const output = line.match(/^(?:базовый\s+)?(?:выход(?:\s+(?:готового\s+продукта|настойки))?|(?:общий\s+)?об[ъь][её]м(?:\s+готового\s+продукта)?|итого)(?=\s|[,，:：=–—-]|$)\s*(?:[,，]\s*(л|мл))?\s*[:：=–—-]?\s*(.*)$/iu);
    if (output) {
      const amountMatch = output[2].match(quantityRegex('iu'));
      const plain = number(output[2]);
      const amount = amountMatch ? number(amountMatch[1]) : plain;
      const amountUnit = amountMatch ? unit(amountMatch[2]) : (unit(output[1]) || 'л');
      const unsafeQuantity = amountMatch && /(?:\d\s*[-–—]\s*|[-−])$/.test(output[2].slice(0, amountMatch.index));
      if (!unsafeQuantity && amount !== null && amount >= 0 && ['л','мл','сл','дл'].includes(amountUnit)) {
        recipe.yield = amount > 0 ? round(amount * ({'л':1,'мл':.001,'сл':.01,'дл':.1}[amountUnit])) : null;
        const remainder = amountMatch ? output[2].replace(amountMatch[0], '').trim() : '';
        if (remainder) unknown.push(remainder);
      } else unknown.push(original);
      continue;
    }
    const shelf = line.match(/^срок\s*(?:годности|хранения)\s*[:：=–—-]?\s*(\d+)\s*(?:дн(?:ей|я|и)?\.?|сут(?:ок|ки)?\.?|д)?\s*$/iu);
    if (shelf) { recipe.shelfLifeDays = Number(shelf[1]); continue; }
    const processHeading = line.match(PROCESS_HEADING);
    if (processHeading) { section = 'process'; if (processHeading[1]) process.push(processHeading[1]); continue; }
    const ingredientHeading = line.match(INGREDIENT_HEADING);
    if (ingredientHeading) {
      section = 'ingredients';
      if (ingredientHeading[1]) {
        const result = parseIngredientsText(ingredientHeading[1]);
        recipe.ingredients.push(...result.ingredients);
        if (result.unparsedText) unknown.push(result.unparsedText);
      }
      continue;
    }
    if (section === 'process' || PROCESS_VERB.test(original)) {
      section = 'process'; process.push(original); continue;
    }
    const parsed = parseIngredientsText(original);
    if (parsed.ingredients.length) {
      recipe.ingredients.push(...parsed.ingredients);
      if (parsed.unparsedText) unknown.push(parsed.unparsedText);
      continue;
    }
    if (!titleTaken && !section) {
      recipe.name = line.replace(/^(?:тк|технологическая\s+карта|техкарта)\s*[-–—№]?\s*/iu, '').replace(/^(["«])(.*)(["»])$/, '$2').trim();
      titleTaken = true;
    } else unknown.push(original);
  }
  recipe.process = process.join('\n');
  recipe.unparsedText = unknown.join('\n');
  return classifyRecipe(recipe);
}

function detectAlcohol(ingredients, unparsedText = '') {
  const candidates = new Set();
  let uncertain = false;
  const unparsedIngredients = String(unparsedText || '').split('\n').filter(line => !/^(?:категория|раздел)\s*[:：]/iu.test(line)).map(name => ({name}));
  for (const ingredient of [...(ingredients || []), ...unparsedIngredients]) {
    const name = clean(ingredient?.name);
    if (!name) continue;
    const matched = ALCOHOL_RULES.filter(([, pattern]) => pattern.test(name)).map(([category]) => category);
    if (NON_ALCOHOLIC.test(name)) {
      const clauses = name.split(/\s+(?:и|с|или)\s+|\s*\+\s*|\s+\/\s+/iu);
      const mixedBase = clauses.some(clause => !NON_ALCOHOLIC.test(clause) && ALCOHOL_RULES.some(([, pattern]) => pattern.test(clause)));
      // A qualifier in one clause cannot make another base alcohol disappear.
      // Mixed or ambiguous compound names require explicit user confirmation.
      if (!(clauses.length > 1 && mixedBase) && !(clauses.length === 1 && matched.length > 1)) continue;
      uncertain = true;
    }
    // Vermouth is a specific wine category, not two independent base alcohols.
    if (matched.includes('Вермут') && matched.includes('Вино')) matched.splice(matched.indexOf('Вино'), 1);
    for (const category of matched) candidates.add(category);
    if (!matched.length && UNKNOWN_ALCOHOL.test(name)) uncertain = true;
  }
  return { candidates: ALCOHOL_CATEGORIES.filter(x => candidates.has(x)), uncertain };
}

export function classifyRecipe(recipe, { force = false } = {}) {
  const result = { ...recipe };
  const { candidates, uncertain } = detectAlcohol(result.ingredients, result.unparsedText);
  result.alcoholCandidates = candidates;
  if (!force && result.categoryMode === 'manual') return result;
  if (!force && result.primaryAlcohol && candidates.includes(result.primaryAlcohol)) {
    result.category = result.primaryAlcohol;
    result.categoryMode = 'confirmed';
    return result;
  }
  result.primaryAlcohol = '';
  result.categoryMode = 'auto';
  if (!(result.ingredients || []).some(x => clean(x?.name)) && !candidates.length && !uncertain) result.category = 'Без категории';
  else if (uncertain || candidates.length > 1) result.category = 'Требует уточнения';
  else if (candidates.length === 1) result.category = candidates[0];
  else result.category = 'Безалкогольные';
  return result;
}

export function normalizeRecipe(recipe) {
  const source = recipe && typeof recipe === 'object' ? recipe : {};
  const result = { ...source, name: clean(source.name), ingredients: [], rawText: String(source.rawText ?? ''), unparsedText: String(source.unparsedText ?? ''), process: String(source.process ?? ''), photos: Array.isArray(source.photos) ? source.photos : [] };
  const output = number(source.yield);
  result.yield = source.yield === null || source.yield === undefined || clean(source.yield) === '' || output === 0 ? null : (output ?? source.yield);
  if (output === null && source.yield != null && clean(source.yield)) result.unparsedText = appendText(result.unparsedText, `Нераспознанный выход: ${source.yield}`);
  const shelf = number(source.shelfLifeDays);
  result.shelfLifeDays = source.shelfLifeDays == null || clean(source.shelfLifeDays) === '' ? null : (shelf ?? source.shelfLifeDays);
  if (!Array.isArray(source.ingredients) && source.ingredients) {
    const parsed = parseIngredientsText(source.ingredients);
    result.ingredients = parsed.ingredients;
    result.unparsedText = appendText(result.unparsedText, parsed.unparsedText);
  } else {
    result.ingredients = (source.ingredients || []).map(item => {
      if (typeof item !== 'object' || !item) {
        result.unparsedText = appendText(result.unparsedText, typeof item === 'string' ? item : JSON.stringify(item));
        return null;
      }
      const amount = number(item.amount);
      const cost = number(item.cost);
      const row = { ...item, name: clean(item.name), amount: amount ?? item.amount ?? '', unit: unit(item.unit || 'шт'), cost: cost ?? item.cost ?? 0 };
      if (amount === null || amount < 0 || !row.name) result.unparsedText = appendText(result.unparsedText, `Проверьте ингредиент: ${row.name || '(без названия)'} | ${item.amount ?? ''} | ${row.unit}`);
      return row;
    }).filter(Boolean);
  }
  result.category = clean(source.category);
  result.categoryMode = ['auto','manual','confirmed'].includes(source.categoryMode) ? source.categoryMode : (result.category ? 'manual' : 'auto');
  result.primaryAlcohol = clean(source.primaryAlcohol);
  return classifyRecipe(result);
}

function canonicalIngredient(item) {
  const normalizedUnit = unit(item.unit || 'шт');
  const multiplier = { 'кг': 1000, 'г': 1, 'мг': .001, 'л': 1000, 'мл': 1, 'сл': 10, 'дл': 100 }[normalizedUnit] ?? 1;
  const canonicalUnit = ['кг','г','мг'].includes(normalizedUnit) ? 'г' : (['л','мл','сл','дл'].includes(normalizedUnit) ? 'мл' : normText(normalizedUnit));
  const amount = number(item.amount);
  return [normText(item.name).replace(/\s*[-–—]\s*/g, '-'), amount === null ? normText(item.amount) : round(amount * multiplier), canonicalUnit];
}

export function recipeFingerprint(recipe) {
  const r = normalizeRecipe(recipe);
  const ingredients = r.ingredients.map(canonicalIngredient).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'ru'));
  const signature = {
    name: normText(r.name),
    ingredients,
    yield: number(r.yield),
    process: normText(r.process),
    unparsedText: normText(r.unparsedText),
  };
  // Source-only records can contain information beyond a title. Fully parsed
  // records ignore source formatting so 500 ml and 0.5 l reimports match.
  if (!ingredients.length && !signature.process && !signature.unparsedText && !signature.name) signature.rawText = normText(r.rawText);
  return `tk2:${JSON.stringify(signature)}`;
}

export function scaleProcess(text, factor) {
  const multiplier = number(factor);
  if (multiplier === null || multiplier <= 0 || multiplier === 1) return String(text ?? '');
  return String(text ?? '').replace(quantityRegex(), (match, amount, amountUnit, offset, original) => {
    const preceding = original.slice(Math.max(0, offset - 35), offset);
    const following = original.slice(offset + match.length);
    // Ranges, dimensions and concentrations are not ingredient quantities.
    if (/\d\s*(?:(?:г|кг|мл|л|шт)\.?)?\s*[-–—/]\s*$/iu.test(preceding) || /^\s*(?:[-–—]\s*\d|\/)/u.test(following) || /(?:крепост[ьи]?|жирност[ьи]?|температур[аеы]?|до)\s*[:=]?\s*$/iu.test(preceding) && /(?:°|градус|%)/iu.test(original.slice(offset, offset + match.length + 10))) return match;
    const parsed = number(amount);
    if (parsed === null) return match;
    const scaled = round(parsed * multiplier);
    return `${String(scaled).replace('.', ',')} ${amountUnit}`;
  });
}
