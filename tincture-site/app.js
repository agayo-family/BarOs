import {
  aggregateIngredients, totalCost, isoWeekKey,
  consumeStock, reconcileConfirmedRequisition, expiryDate,
  expiryStatus, daysUntil, batchVelocity, round, inventoryItemKey, calculateRecipe, ingredientUnits, convertIngredientAmount, parseCalculationAmount
} from './logic.mjs';
import {parseRecipeText, parseIngredientsText, classifyRecipe, normalizeRecipe, recipeFingerprint, scaleProcess, ALCOHOL_CATEGORIES} from './recipes.mjs';
import {readRecipeFile} from './imports.mjs';

const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
const nowISO = () => new Date().toISOString();
const localDateTime = () => {const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
const fmtDate = (iso) => {const date=new Date(iso);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'short',year:'numeric'}).format(date):'дата не указана';};
const fmtNum = (n, d=2) => new Intl.NumberFormat('ru-RU',{maximumFractionDigits:d}).format(Number(n||0));
const fmtMoney = (n) => new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2}).format(Number(n||0));
const esc = (s='') => String(s).replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

const demoRecipe = {
  id:'demo-cranberry', name:'ДЕМО · Клюква / можжевельник', category:'Настойка', yield:10, shelfLifeDays:30,
  archived:false, updatedAt:nowISO(), isDemo:true,
  ingredients:[
    {name:'Основа',amount:8,unit:'л',cost:0},
    {name:'Клюква',amount:1.5,unit:'кг',cost:0},
    {name:'Сахар',amount:.8,unit:'кг',cost:0},
    {name:'Можжевельник',amount:.03,unit:'кг',cost:0}
  ]
};

const freshState = () => ({
  version:1,
  meta:{lastModified:nowISO(),lastSynced:null,dirty:false},
  recipes:[demoRecipe],
  requisitions:[],
  stock:[],
  plans:[],
  batches:[],
  stopList:[],
  stats:[],
  readNotices:[],
  settings:{supabaseUrl:'',supabaseKey:'',workspaceId:'tincture-lab-main',notifications:false}
});
let state = freshState();
let route = 'calculator';
let calcMode = 'request';
let ui = {recipeId:'',target:10,baseYield:null,basis:'yield',ingredientIndex:0,ingredientAmount:'',ingredientUnit:''};
let deferredInstallPrompt = null;
let syncTimer = null;
let stateMutationBusy = false;
let syncPullBusy = false;

const pages = {
  calculator:['Калькулятор','Заявка и постановка настоек','⌁'],
  request:['Заявка','Закупка по неделям и подтверждение склада','▤'],
  plans:['План','Стоп-лист и временные планы на производство','◎'],
  recipes:['Технологические карты','Состав, приготовление и расчёт','◇'],
  warehouse:['Остатки','Ингредиенты на складе','▦'],
  batches:['Партии и сроки','Контроль срока годности готовых продуктов','◷'],
  stats:['Статистика','Производство, скорость расхода и история технологий','↗'],
  notifications:['Уведомления','Что скоро испортится и что требует внимания','◉'],
  settings:['Настройки','Офлайн-режим, установка и синхронизация','⚙']
};

function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open('tincture-lab-db',1);
    req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('kv'))db.createObjectStore('kv',{keyPath:'key'});};
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
}
async function dbGet(key){const db=await openDB();try{return await new Promise((res,rej)=>{const r=db.transaction('kv','readonly').objectStore('kv').get(key);r.onsuccess=()=>res(r.result?.value);r.onerror=()=>rej(r.error)});}finally{db.close();}}
async function dbSet(key,value){const db=await openDB();try{return await new Promise((res,rej)=>{const tx=db.transaction('kv','readwrite');tx.objectStore('kv').put({key,value});tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error);tx.onabort=()=>rej(tx.error||Error('Сохранение отменено'));});}finally{db.close();}}
function normalizeState(saved){
  const defaults=freshState();
  if(!saved || typeof saved!=='object' || !Array.isArray(saved.recipes))throw Error('Неверная структура рабочей базы');
  for(const key of ['requisitions','stock','plans','batches','stopList','stats','readNotices'])if(saved[key]!=null&&!Array.isArray(saved[key]))throw Error(`Неверная структура: ${key}`);
  return {...defaults,...saved,recipes:saved.recipes.map(normalizeRecipe),settings:{...defaults.settings,...saved.settings},meta:{...defaults.meta,...saved.meta}};
}
async function load(){
  try{
    const saved=await dbGet('state');if(saved)state=normalizeState(saved);
    ensureCurrentRequisition();await persist(false);renderNav();setRoute('calculator');updateNetwork();checkExpiryNotifications();
  }catch(e){
    console.error('Не удалось открыть рабочую базу',e);
    $('#content').innerHTML='<section class="card"><h2>Не удалось открыть данные</h2><p>Рабочая база сохранена. Освободите место или разрешите браузеру локальное хранение и повторите открытие.</p><button class="primary" id="retryLoad">Повторить</button></section>';
    $('#retryLoad').onclick=()=>location.reload();
  }
}
async function persist(markDirty=true){
  state.meta.lastModified=nowISO(); if(markDirty) state.meta.dirty=true;
  await dbSet('state',state);
  updateNetwork();
  if(markDirty && navigator.onLine && state.settings.supabaseUrl && state.settings.supabaseKey){
    clearTimeout(syncTimer); syncTimer=setTimeout(()=>syncPush().catch(()=>{}),900);
  }
}
async function commitStateChange(mutate,errorMessage='Не удалось сохранить изменение. Данные не изменены; повторите попытку.',markDirty=true){
  if(stateMutationBusy){toast('Дождитесь завершения текущего сохранения.','error');return false;}
  stateMutationBusy=true;
  const previous=structuredClone(state),buttons=$$('button').map(button=>[button,button.disabled]);
  buttons.forEach(([button])=>button.disabled=true);
  try{mutate();await persist(markDirty);return true;}
  catch(error){state=previous;updateNetwork();toast(errorMessage,'error');return false;}
  finally{stateMutationBusy=false;buttons.forEach(([button,disabled])=>button.disabled=disabled);}
}

function toast(msg,type=''){const el=document.createElement('div');el.className=`toast ${type}`;el.textContent=msg;$('#toasts').append(el);setTimeout(()=>el.remove(),3400)}
function modal(html){
  modalAfterClose=null;
  modalReturnFocus=document.activeElement;
  $('#modal').innerHTML=html;$('#modalBackdrop').hidden=false;
  $('#modal').setAttribute('role','dialog');$('#modal').setAttribute('aria-modal','true');
  $('#modal').setAttribute('aria-label',$('#modal h2')?.textContent||'Диалог');
  $$('.field', $('#modal')).forEach(field=>{const label=$('label',field),input=$('input,textarea,select',field);if(label&&input?.id)label.htmlFor=input.id;});
  $('#modal').querySelector('input:not([type=file]),textarea,button')?.focus();
}
let modalReturnFocus=null;
let modalAfterClose=null;
function closeModal(){if(stateMutationBusy)return;const afterClose=modalAfterClose;modalAfterClose=null;$('#modalBackdrop').hidden=true;$('#modal').innerHTML='';modalReturnFocus?.focus?.();modalReturnFocus=null;afterClose?.();}
$('#modalBackdrop').addEventListener('click',e=>{if(e.target.id==='modalBackdrop')closeModal()});
document.addEventListener('keydown',e=>{
  if($('#modalBackdrop').hidden)return;
  if(e.key==='Escape'){closeModal();return;}
  if(e.key==='Tab'){
    const fields=$$('button,input,textarea,select,a[href]', $('#modal')).filter(x=>!x.disabled&&!x.hidden&&x.getClientRects().length);
    const first=fields[0],last=fields.at(-1);
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
    if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
  }
});
window.addEventListener('unhandledrejection',()=>toast('Операция не сохранена. Проверьте свободное место и повторите действие.','error'));

function renderNav(){
  $('#nav').innerHTML=Object.entries(pages).filter(([k])=>k!=='notifications').map(([k,v])=>`<button class="nav-btn ${route===k?'active':''}" data-route="${k}"><span class="nav-icon">${v[2]}</span><span>${v[0]}</span></button>`).join('');
  $$('[data-route]').forEach(b=>b.onclick=()=>setRoute(b.dataset.route));
}
function setRoute(next){route=next;const p=pages[next];$('#pageTitle').textContent=p[0];$('#pageSubtitle').textContent=p[1];renderNav();render();$('#sidebar').classList.remove('open');window.scrollTo({top:0,behavior:'smooth'});}
$('#menuBtn').onclick=()=>$('#sidebar').classList.toggle('open');
$('#notificationBtn').onclick=()=>setRoute('notifications');

function render(){
  const fn={calculator:renderCalculator,request:renderRequest,plans:renderPlans,recipes:renderRecipes,warehouse:renderWarehouse,batches:renderBatches,stats:renderStats,notifications:renderNotifications,settings:renderSettings}[route];
  fn(); updateNoticeBadge();
}

function activeRecipes(){return state.recipes.filter(r=>!r.archived);}
function ensureCurrentRequisition(){
  const wk=isoWeekKey(new Date());
  let req=state.requisitions.find(r=>r.week===wk);
  if(!req){req={id:uid(),week:wk,status:'draft',items:[],appliedItems:[],createdAt:nowISO(),updatedAt:nowISO()};state.requisitions.push(req);}
  return req;
}
function selectedRecipe(){const list=activeRecipes();return state.recipes.find(r=>r.id===ui.recipeId&&!r.archived)||list[0]||null;}
function calculationRecipe(){const r=selectedRecipe();return r?{...r,yield:Number(r.yield)>0?r.yield:ui.baseYield}:null;}
function calculationResult(){return calculateRecipe(calculationRecipe(),{...ui,targetYield:ui.target});}
function canCalculate(){return calculationResult().valid;}
function calcRows(){return calculationResult().rows;}
function calculationFor(recipe,values){return calculateRecipe({...recipe,yield:Number(recipe?.yield)>0?recipe.yield:values.baseYield},{...values,targetYield:values.target});}
function calculationControls(recipe,values,prefix){
  const byIngredient=values.basis==='ingredient',item=recipe.ingredients?.[Number(values.ingredientIndex??0)];
  const units=ingredientUnits(item?.unit),unit=inventoryItemKey({unit:values.ingredientUnit||item?.unit});
  return `<div class="form-grid">
    <div class="field full"><label for="${prefix}Basis">Рассчитать</label><select id="${prefix}Basis"><option value="yield" ${byIngredient?'':'selected'}>По выходу готового продукта</option><option value="ingredient" ${byIngredient?'selected':''}>По количеству ингредиента</option></select></div>
    <div class="field full" ${byIngredient?'':'hidden'}><label for="${prefix}Ingredient">Ингредиент для расчёта</label><select id="${prefix}Ingredient">${(recipe.ingredients||[]).map((i,index)=>`<option value="${index}" ${index===Number(values.ingredientIndex??0)?'selected':''}>${esc(i.name)} · ${fmtNum(i.amount,4)} ${esc(i.unit)} в ТК</option>`).join('')}</select></div>
    <div class="field" ${byIngredient?'':'hidden'}><label for="${prefix}Amount">Сколько ингредиента есть</label><input id="${prefix}Amount" type="text" inputmode="decimal" autocomplete="off" value="${esc(values.ingredientAmount??'')}" placeholder="Например, 1,100" aria-describedby="${prefix}AmountHint"><span id="${prefix}AmountHint" class="tiny muted">Точка и запятая — десятичный разделитель.</span></div>
    <div class="field" ${byIngredient?'':'hidden'}><label for="${prefix}Unit">Единица ингредиента</label><select id="${prefix}Unit">${units.map(u=>`<option value="${esc(u)}" ${inventoryItemKey({unit:u})===unit?'selected':''}>${esc(u)}</option>`).join('')}</select></div>
    <div class="field" ${byIngredient?'hidden':''}><label for="${prefix}Target">Нужный объём, л</label><input id="${prefix}Target" type="number" min=".001" step="any" inputmode="decimal" value="${esc(values.target)}"></div>
    ${Number(recipe.yield)>0?`<div class="field" ${byIngredient?'hidden':''}><label>Исходный выход всего состава</label><div class="recipe-base-value">${fmtNum(recipe.yield)} л</div></div>`:`<div class="field full"><label for="${prefix}Base">Исходный объём для этого расчёта, л</label><input id="${prefix}Base" type="number" min=".001" step="any" inputmode="decimal" value="${esc(values.baseYield??'')}" placeholder="Сколько готового продукта даёт указанный состав"><span class="tiny muted">Для расчёта состава по ингредиенту необязателен. Нужен для ожидаемого выхода, плана и партии. Не изменяет ТК.</span></div>`}
  </div>`;
}
function bindCalculationControls(recipe,values,prefix,refresh,redraw){
  const resetIngredient=(index,result)=>{
    values.ingredientIndex=index;const item=recipe.ingredients?.[index];
    values.ingredientAmount=String(result?.rows?.[index]?.amount??item?.amount??'');values.ingredientUnit=item?.unit||'';
  };
  $('#'+prefix+'Basis').onchange=e=>{
    const result=calculationFor(recipe,values);values.basis=e.target.value;
    if(values.basis==='ingredient')resetIngredient(Number(values.ingredientIndex??0),result);
    else if(result.targetYield>0)values.target=result.targetYield;
    redraw();$('#'+prefix+'Basis').focus();
  };
  $('#'+prefix+'Ingredient').onchange=e=>{const result=calculationFor(recipe,values);resetIngredient(Number(e.target.value),result);redraw();$('#'+prefix+'Ingredient').focus();};
  $('#'+prefix+'Amount').oninput=e=>{values.ingredientAmount=e.target.value;refresh();};
  $('#'+prefix+'Unit').onchange=e=>{
    const item=recipe.ingredients?.[Number(values.ingredientIndex??0)],converted=convertIngredientAmount(parseCalculationAmount(values.ingredientAmount),values.ingredientUnit||item?.unit,e.target.value);
    if(Number.isFinite(converted)){values.ingredientAmount=String(Number(converted.toPrecision(12)));$('#'+prefix+'Amount').value=values.ingredientAmount;}
    values.ingredientUnit=e.target.value;refresh();
  };
  $('#'+prefix+'Target').oninput=e=>{values.target=Number(e?.target?.value??$('#'+prefix+'Target').value);refresh();};
  if(!Number(recipe.yield))$('#'+prefix+'Base').oninput=e=>{values.baseYield=Number(e?.target?.value??$('#'+prefix+'Base').value);refresh();};
}
function calculationSummary(recipe,values,result){
  if(values.basis!=='ingredient'||!result.valid)return '';
  const item=recipe.ingredients?.[Number(values.ingredientIndex??0)];
  return `Расчёт от ${fmtNum(parseCalculationAmount(values.ingredientAmount),4)} ${esc(values.ingredientUnit||item?.unit)} «${esc(item?.name)}». ${result.targetYield>0?`Ожидаемый выход: ${fmtNum(result.targetYield,4)} л.`:'Выход в ТК не указан. Состав рассчитан; для плана и партии укажите исходный объём.'}`;
}
function recipeOptions(selected){return activeRecipes().map(r=>`<option value="${esc(r.id)}" ${r.id===selected?'selected':''}>${esc(r.name)}</option>`).join('');}

function renderCalculator(){
  const recipes=activeRecipes(); if(!ui.recipeId && recipes[0])ui.recipeId=recipes[0].id;
  const r=selectedRecipe(); const rows=calcRows(); const cost=totalCost(rows);
  const req=ensureCurrentRequisition();
  $('#content').innerHTML=`
    <div class="hero">
      <div><span class="pill olive">LOCAL-FIRST · PWA</span><h2>Одна технологичка — два разных расчёта.</h2><p>Закупочная заявка агрегирует ингредиенты на неделю. Постановка рассчитывает конкретную варку, может сохраниться в план и после приготовления запускает срок годности.</p></div>
      <div class="hero-stat"><span>Текущая неделя</span><strong>${esc(req.week)}</strong><span>${req.status==='confirmed'?'заявка подтверждена':'заявка ещё черновик'}</span></div>
    </div>
    <div style="height:18px"></div>
    <div class="segmented"><button id="modeRequest" class="${calcMode==='request'?'active':''}">В заявку</button><button id="modeProduction" class="${calcMode==='production'?'active':''}">Поставить настойку</button></div>
    <div style="height:14px"></div>
    <div class="grid two">
      <section class="card">
        <h2>${calcMode==='request'?'Расчёт закупки':'Расчёт постановки'}</h2>
        ${recipes.length?`<div class="form-grid"><div class="field full"><label for="calcRecipe">Технология</label><select id="calcRecipe">${recipeOptions(r?.id)}</select></div></div>
        ${calculationControls(r,ui,'calc')}
        <p id="calcSummary" class="tiny muted" aria-live="polite"></p>
        <div class="divider"></div>
        <div class="notice">База техкарты: ${Number(r?.yield)?fmtNum(r.yield)+' л':'выход не указан'} · срок годности: ${fmtNum(r?.shelfLifeDays,0)} дн. ${latestVersionHint(r)}</div>
        <div id="calcWarning" class="notice warn" ${canCalculate()?'hidden':''}>Укажите исходный и нужный объём; в составе должны быть ингредиенты с положительным количеством и единицей.</div>
        <div class="calc-result">${rows.map(x=>`<div class="calc-row"><span class="name">${esc(x.name)}</span><span class="qty">${fmtNum(x.amount,4)} ${esc(x.unit)}</span><span class="cost">${x.cost?fmtMoney(x.amount*x.cost):'цена не задана'}</span></div>`).join('')}</div>
        <div class="divider"></div>
        <div class="section-head"><div><div class="tiny muted">Ориентировочная стоимость</div><strong id="calcCost">${fmtMoney(cost)}</strong></div><div class="actions">${calcMode==='request'?`<button class="primary" id="addRequest">Добавить в заявку</button>`:`<button class="soft" id="savePlan">Сохранить в план</button><button class="primary" id="finishBatch">Готово — запустить срок</button>`}</div></div>`:`<div class="empty">Нет активных технологических карт. Добавьте первую во вкладке «Технологические карты».</div>`}
      </section>
      <section class="card soft-card">
        <h2>${calcMode==='request'?'Правая колонка заявки':'Что произойдёт после приготовления'}</h2>
        ${calcMode==='request'?renderMiniRequest(req):renderProductionExplanation(r,rows)}
      </section>
    </div>`;
  $('#modeRequest').onclick=()=>{calcMode='request';renderCalculator()}; $('#modeProduction').onclick=()=>{calcMode='production';renderCalculator()};
  if(!recipes.length)return;
  $('#calcRecipe').onchange=e=>{ui.recipeId=e.target.value;ui.baseYield=null;ui.ingredientIndex=0;const item=selectedRecipe()?.ingredients?.[0];ui.ingredientAmount=String(item?.amount??'');ui.ingredientUnit=item?.unit||'';renderCalculator()};
  const refreshCalculation=()=>{
    const updated=calcRows();$('.calc-result').innerHTML=updated.map(x=>`<div class="calc-row"><span class="name">${esc(x.name)}</span><span class="qty">${fmtNum(x.amount,4)} ${esc(x.unit)}</span><span class="cost">${x.cost?fmtMoney(x.amount*x.cost):'цена не задана'}</span></div>`).join('');
    const result=calculationResult();$('#calcCost').textContent=fmtMoney(totalCost(updated));$('#calcWarning').hidden=result.valid;$('#calcWarning').textContent=result.error;$('#calcSummary').innerHTML=calculationSummary(r,ui,result);
    for(const id of ['addRequest','savePlan','finishBatch'])if($('#'+id))$('#'+id).disabled=!result.valid||(id!=='addRequest'&&!(result.targetYield>0));
    if(calcMode==='production')$('.soft-card').innerHTML=`<h2>Что произойдёт после приготовления</h2>${result.valid?renderProductionExplanation(r,updated):'<div class="notice">Заполните данные для расчёта состава и проверки склада.</div>'}`;
  };
  bindCalculationControls(r,ui,'calc',refreshCalculation,renderCalculator);
  $$('[data-latest-version]').forEach(b=>b.onclick=()=>useStatVersion(b.dataset.latestVersion));
  if(calcMode==='request')$('#addRequest').onclick=addToRequest;
  else {$('#savePlan').onclick=savePlan;$('#finishBatch').onclick=()=>{if(canCalculate())openFinishBatch(calculationRecipe(),calcRows());};}
  refreshCalculation();
}
function latestVersionHint(r){
  if(!r)return'';const last=state.stats.find(s=>s.type==='production'&&s.recipeId===r.id&&s.recipeSnapshot);
  return last?`<button class="soft" data-latest-version="${esc(last.id)}" style="min-height:32px;padding:0 10px">Подставить факт от ${fmtDate(last.createdAt)}</button>`:'';
}
function renderMiniRequest(req){
  if(!req.items.length)return `<div class="empty">Пока пусто. Добавляйте расчёты слева — одинаковые ингредиенты суммируются автоматически.</div>`;
  return `<div class="list">${req.items.slice(0,8).map(i=>`<div class="list-item"><div class="list-main"><div class="list-title">${esc(i.name)}</div><div class="list-sub">${i.cost?`${fmtMoney(i.cost)} / ${esc(i.unit)}`:'стоимость не задана'}</div></div><strong>${fmtNum(i.amount,4)} ${esc(i.unit)}</strong></div>`).join('')}</div>${req.items.length>8?`<p class="tiny muted">И ещё ${req.items.length-8} поз.</p>`:''}<div class="divider"></div><div class="section-head"><span>Итого</span><strong>${fmtMoney(totalCost(req.items))}</strong></div>`;
}
function renderProductionExplanation(r,rows){
  const shortages=rows.filter(n=>{const s=state.stock.find(x=>inventoryItemKey(x)===inventoryItemKey(n));return Number(s?.amount||0)<Number(n.amount||0)});
  return `<div class="status-strip"><div class="status-item"><strong>${rows.length}</strong><span>ингредиентов</span></div><div class="status-item"><strong>${shortages.length}</strong><span>дефицитов</span></div><div class="status-item"><strong>${esc(r?.shelfLifeDays??0)}</strong><span>дней срока</span></div></div><div class="divider"></div>${shortages.length?`<div class="notice warn"><b>Склад не покрывает постановку:</b><br>${shortages.map(x=>`${esc(x.name)} — нужно ${fmtNum(x.amount,4)} ${esc(x.unit)}`).join('<br>')}</div>`:`<div class="notice">Склад покрывает расчёт. После «Готово» ингредиенты спишутся, создастся партия и запись в статистике.</div>`}`;
}
async function addToRequest(){
  if(!canCalculate()){toast('Заполните состав и исходный объём для расчёта','error');return;}
  const added=calcRows();
  const saved=await commitStateChange(()=>{const req=ensureCurrentRequisition(),old=structuredClone(req.items);req.items=aggregateIngredients([...req.items,...added]);req.updatedAt=nowISO();if(req.status==='confirmed'){state.stock=reconcileConfirmedRequisition(state.stock,req.appliedItems||old,req.items);req.appliedItems=structuredClone(req.items);}});
  if(saved){toast('Добавлено в недельную заявку');if(route==='calculator')renderCalculator();}
}
async function savePlan(){const result=calculationResult();if(!result.valid||!(result.targetYield>0)){toast('Проверьте состав и укажите исходный выход для плана','error');return;}const r=calculationRecipe(),plan={id:uid(),recipeId:r.id,name:r.name,targetYield:result.targetYield,baseYield:r.yield,ingredients:result.rows,createdAt:nowISO(),status:'planned'};if(await commitStateChange(()=>state.plans.unshift(plan)))toast('План постановки сохранён');}
function openFinishBatch(recipe,ingredients){
  const target=calculationResult().targetYield;
  if(!(target>0)){toast('Укажите исходный выход для создания партии','error');return;}
  modal(`<div class="section-head"><h2>Зафиксировать приготовление</h2><button class="icon-btn" id="closeM">×</button></div><p class="muted tiny">Проверьте фактически использованную раскладку. Именно она сохранится как последняя версия технологии и спишется со склада.</p><div class="form-grid"><div class="field"><label>Плановый объём, л</label><input id="batchTarget" type="number" value="${esc(target)}" disabled></div><div class="field"><label>Фактический выход, л</label><input id="batchActual" type="number" min="0.001" step="any" value="${esc(target)}"></div><div class="field"><label>Срок годности, дней</label><input id="batchShelf" type="number" min="0" step="1" value="${esc(recipe.shelfLifeDays??'')}"></div><div class="field"><label>Дата приготовления</label><input id="batchDate" type="datetime-local" value="${localDateTime()}"></div><div class="field full"><label>Фактическая раскладка — название | количество | единица | цена</label><textarea id="batchLines" style="min-height:180px">${esc(ingredients.map(i=>`${i.name} | ${i.amount} | ${i.unit} | ${i.cost||0}`).join('\n'))}</textarea></div><div class="field full"><label>Комментарий / изменение технологии</label><textarea id="batchNote" placeholder="Например: сахар уменьшен на 5%"></textarea></div></div><div class="divider"></div><div class="actions"><button class="primary" id="batchSave">Сохранить партию</button><button class="soft" id="closeM2">Отмена</button></div>`);
  $('#closeM').onclick=$('#closeM2').onclick=closeModal;
  $('#batchSave').onclick=async()=>{
    const date=new Date($('#batchDate').value); const actual=Number($('#batchActual').value||0); const shelf=Number($('#batchShelf').value||0); const parsed=parseIngredientsText($('#batchLines').value);const actualIngredients=parsed.ingredients;
    if(!Number.isFinite(date.getTime())||!Number.isFinite(actual)||actual<=0||!Number.isInteger(shelf)||shelf<0||!actualIngredients.length||parsed.unparsedText||actualIngredients.some(i=>!i.name||!i.unit||!Number.isFinite(i.amount)||i.amount<=0||!Number.isFinite(Number(i.cost))||Number(i.cost)<0)){toast('Проверьте дату, выход, срок и все строки состава','error');return;}
    const started=date.toISOString(),note=$('#batchNote').value.trim();let shortages=[];
    const saved=await commitStateChange(()=>{
      const consumed=consumeStock(state.stock,actualIngredients);state.stock=consumed.stock;shortages=consumed.shortages;
      const batch={id:uid(),recipeId:recipe.id,name:recipe.name,targetYield:target,actualYield:actual,remainingVolume:null,ingredients:structuredClone(actualIngredients),startedAt:started,expiresAt:expiryDate(started,shelf),shelfLifeDays:shelf,stoppedAt:null,note};
      state.batches.unshift(batch);
      state.stats.unshift({id:uid(),type:'production',recipeId:recipe.id,name:recipe.name,targetYield:target,actualYield:actual,createdAt:started,recipeSnapshot:{...structuredClone(recipe),yield:actual,shelfLifeDays:shelf,ingredients:structuredClone(actualIngredients),ingredientsText:recipeIngredientText(actualIngredients)},note});
      state.plans=state.plans.filter(p=>!(p.recipeId===recipe.id&&p.status==='planned'));state.stopList=state.stopList.filter(s=>s.recipeId!==recipe.id);
      if(shortages.length)state.readNotices=state.readNotices.filter(id=>!id.startsWith('shortage-'));
    },'Не удалось сохранить партию. Склад и история не изменены; данные остались в форме.');
    if(saved){closeModal();toast(shortages.length?`Партия создана. Дефицит по ${shortages.length} позициям`:'Партия создана, срок запущен',shortages.length?'error':'');render();checkExpiryNotifications();}
  };
}

function renderRequest(){
  const reqs=[...state.requisitions].sort((a,b)=>b.week.localeCompare(a.week));
  $('#content').innerHTML=`<div class="section-head"><div><h2>Недельные заявки</h2><p class="tiny muted">Подтверждение заявки увеличивает склад. Повторное редактирование подтверждённой заявки корректирует склад только на разницу.</p></div></div><div class="grid">${reqs.map(renderRequestCard).join('')}</div>`;
  $$('[data-confirm]').forEach(b=>b.onclick=()=>confirmRequest(b.dataset.confirm));
  $$('[data-editreq]').forEach(b=>b.onclick=()=>editRequest(b.dataset.editreq));
}
function renderRequestCard(r){return `<section class="card"><div class="section-head"><div><h2>${esc(r.week)}</h2><span class="pill ${r.status==='confirmed'?'olive':'dark'}">${r.status==='confirmed'?'Подтверждена':'Черновик'}</span></div><div class="actions"><button class="soft" data-editreq="${esc(r.id)}">Редактировать</button>${r.status!=='confirmed'?`<button class="primary" data-confirm="${esc(r.id)}">Подтвердить → склад</button>`:''}</div></div>${r.items.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Ингредиент</th><th>Кол-во</th><th>Цена / ед.</th><th>Сумма</th></tr></thead><tbody>${r.items.map(i=>`<tr><td class="row-title">${esc(i.name)}</td><td>${fmtNum(i.amount,4)} ${esc(i.unit)}</td><td>${i.cost?fmtMoney(i.cost):'—'}</td><td>${i.cost?fmtMoney(i.cost*i.amount):'—'}</td></tr>`).join('')}</tbody></table></div><div class="divider"></div><div class="section-head"><span>Общая сумма</span><strong>${fmtMoney(totalCost(r.items))}</strong></div>`:`<div class="empty">Заявка пока пустая</div>`}</section>`}
function validInventoryRows(rows){return Array.isArray(rows)&&rows.every(i=>i&&String(i.name||'').trim()&&String(i.unit||'').trim()&&Number.isFinite(Number(i.amount))&&Number(i.amount)>=0&&Number.isFinite(Number(i.cost||0))&&Number(i.cost||0)>=0);}
async function confirmRequest(id){
  const r=state.requisitions.find(x=>x.id===id);if(!r||r.status==='confirmed')return;
  if(!validInventoryRows(r.items)){toast('Проверьте строки заявки перед подтверждением.','error');return;}
  if(await commitStateChange(()=>{const request=state.requisitions.find(x=>x.id===id);if(!request||request.status==='confirmed')return;state.stock=reconcileConfirmedRequisition(state.stock,[],request.items);request.appliedItems=structuredClone(request.items);request.status='confirmed';request.confirmedAt=nowISO();})){
    toast('Заявка подтверждена, склад обновлён');render();
  }
}
function editRequest(id){
  const r=state.requisitions.find(x=>x.id===id);if(!r)return;
  modal(`<div class="section-head"><h2>Редактировать ${esc(r.week)}</h2><button class="icon-btn" id="closeM">×</button></div><p class="tiny muted">Формат строки: название | количество | единица | цена за единицу</p><div class="field full"><label for="reqLines">Состав заявки</label><textarea id="reqLines" style="min-height:280px">${esc(recipeIngredientText(r.items))}</textarea></div><div id="reqLineErrors" class="notice warn" role="alert" hidden></div><div class="divider"></div><div class="actions"><button class="primary" id="saveReq">Сохранить</button><button class="soft" id="closeM2">Отмена</button></div>`);
  $('#closeM').onclick=$('#closeM2').onclick=closeModal;
  $('#saveReq').onclick=async()=>{
    const parsed=parseIngredientsText($('#reqLines').value),items=parsed.ingredients;
    if(parsed.unparsedText||!validInventoryRows(items)){$('#reqLineErrors').hidden=false;$('#reqLineErrors').textContent='Проверьте все строки: название, количество от нуля, единица и цена от нуля. Нераспознанные строки: '+(parsed.unparsedText||'неверное количество или цена');return;}
    $('#reqLineErrors').hidden=true;
    if(await commitStateChange(()=>{const request=state.requisitions.find(x=>x.id===id);if(!request)throw Error('Заявка не найдена');if(request.status==='confirmed'){state.stock=reconcileConfirmedRequisition(state.stock,request.appliedItems||[],items);request.appliedItems=structuredClone(items);}request.items=items;request.updatedAt=nowISO();},'Не удалось сохранить заявку. Склад не изменён; данные остались в форме.')){closeModal();toast('Заявка обновлена');render();}
  };
}

function renderPlans(){
  const stops=state.stopList; const plans=state.plans.filter(p=>p.status==='planned');
  $('#content').innerHTML=`<div class="grid two"><section class="card"><div class="section-head"><h2>Стоп-лист сейчас</h2><span class="pill burg">${stops.length}</span></div>${stops.length?`<div class="list">${stops.map(s=>`<div class="list-item"><div class="list-main"><div class="list-title">${esc(s.name)}</div><div class="list-sub">в стопе с ${fmtDate(s.since)}</div></div><button class="soft" data-unstop="${esc(s.id)}">Снять со стопа</button></div>`).join('')}</div>`:`<div class="empty">Сейчас стопов нет.</div>`}</section><section class="card"><div class="section-head"><h2>Временные планы постановок</h2><span class="pill olive">${plans.length}</span></div>${plans.length?`<div class="list">${plans.map(p=>`<div class="list-item"><div class="list-main"><div class="list-title">${esc(p.name)}</div><div class="list-sub">${fmtNum(p.targetYield)} л · ${fmtDate(p.createdAt)}</div></div><div class="list-side"><button class="soft" data-openplan="${esc(p.id)}">Открыть</button><button class="icon-btn" data-delplan="${esc(p.id)}">×</button></div></div>`).join('')}</div>`:`<div class="empty">Сохранённые расчёты постановок появятся здесь.</div>`}</section></div>`;
  $$('[data-unstop]').forEach(b=>b.onclick=async()=>{if(await commitStateChange(()=>{state.stopList=state.stopList.filter(s=>s.id!==b.dataset.unstop);}))render();});
  $$('[data-delplan]').forEach(b=>b.onclick=async()=>{if(await commitStateChange(()=>{state.plans=state.plans.filter(p=>p.id!==b.dataset.delplan);}))render();});
  $$('[data-openplan]').forEach(b=>b.onclick=()=>{const p=state.plans.find(x=>x.id===b.dataset.openplan),recipe=state.recipes.find(r=>r.id===p?.recipeId);if(!p||!recipe||recipe.archived){toast(recipe?.archived?'ТК этого плана в архиве. Верните её в актуальные карты перед открытием плана.':'ТК этого плана не найдена. План сохранён; выберите или восстановите нужную карту.','error');return;}ui.recipeId=recipe.id;ui.target=p.targetYield;ui.baseYield=p.baseYield??null;ui.basis='yield';calcMode='production';setRoute('calculator');});
}

function renderRecipes(){
  const current=state.recipes.filter(r=>!r.archived), archived=state.recipes.filter(r=>r.archived);
  const groups=new Map();
  for(const recipe of current){const key=recipe.category||'Без категории';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(recipe);}
  $('#content').innerHTML=`<div class="section-head"><div><h2>Технологические карты</h2><p class="tiny muted">Вставьте готовую карту или загрузите файл. Выход и состав можно заполнить позже.</p></div><div class="actions"><button class="soft" id="importRecipe">Загрузить ТК из файла</button><button class="soft" id="exportRecipes">Выгрузить ТК</button><button class="primary" id="newRecipe">+ Добавить ТК</button></div></div>
    ${current.length?[...groups.entries()].sort(([a],[b])=>a.localeCompare(b,'ru')).map(([name,list])=>`<section class="recipe-category"><div class="section-head"><h2>${esc(name)}</h2><span class="pill olive">${list.length}</span></div>${recipeList(list,false)}</section>`).join(''):`<div class="empty">Пока нет технологических карт. Добавьте название, а остальные данные заполните позже.</div>`}
    <details class="recipe-archive"><summary>Архив <span class="pill dark">${archived.length}</span></summary><p class="tiny muted">Карты в архиве сохранены и не участвуют в производственных расчётах.</p>${recipeList(archived,true)}</details>`;
  $('#newRecipe').onclick=()=>recipeModal();$('#importRecipe').onclick=importModal;$('#exportRecipes').onclick=exportRecipes;
  $$('[data-editrecipe]').forEach(b=>b.onclick=()=>recipeModal(b.dataset.editrecipe));
  $$('[data-recipe-calc]').forEach(b=>b.onclick=()=>recipeCalculationModal(b.dataset.recipeCalc));
  $$('[data-archive]').forEach(b=>b.onclick=()=>toggleArchive(b.dataset.archive));
  $$('[data-delete-recipe]').forEach(b=>b.onclick=()=>deleteRecipe(b.dataset.deleteRecipe));
}
function recipePhotoSource(photo){const src=typeof photo==='string'?photo:photo?.dataUrl||photo?.url||'';return /^(data:image\/(?:png|jpeg|webp|gif);base64,|https?:\/\/)/i.test(src)?src:'';}
function recipeIngredientText(ingredients){return (ingredients||[]).map(i=>`${i.name} | ${i.amount??''} | ${i.unit||'шт'} | ${i.cost||0}`).join('\n');}
function recipeCompositionHTML(ingredients){return ingredients?.length?`<ul class="recipe-ingredients">${ingredients.map(i=>`<li><span>${esc(i.name)}</span><strong>${Number.isFinite(Number(i.amount))?fmtNum(i.amount,4):'—'} ${esc(i.unit||'')}</strong></li>`).join('')}</ul>`:'<p class="tiny muted">Состав ещё не заполнен.</p>';}
function recipeList(list,arch){
  if(!list.length)return '<div class="empty">Пусто</div>';
  return `<div class="recipe-grid">${[...list].sort((a,b)=>String(a.name).localeCompare(String(b.name),'ru')).map(r=>{
    const incomplete=!(r.ingredients||[]).length&&!String(r.process||'').trim();
    const photos=(r.photos||[]).map(p=>({src:recipePhotoSource(p),name:typeof p==='string'?'Фото приготовления':p?.name||'Фото приготовления'})).filter(p=>p.src);
    return `<article class="card recipe-card ${incomplete?'recipe-incomplete':''}"><details><summary><span class="recipe-card-title">${esc(r.name||'Без названия')}</span><span class="recipe-card-meta">${incomplete?'<span class="pill burg">Нужно заполнить</span>':''}${r.category==='Требует уточнения'?'<span class="pill burg">Выберите основной алкоголь</span>':''}<span>${Number(r.yield)>0?`Выход ${fmtNum(r.yield)} л`:'Выход не указан'}</span><span class="recipe-disclosure">Раскрыть карту</span></span><span class="recipe-composition-preview">${(r.ingredients||[]).length?esc(r.ingredients.map(i=>`${i.name} — ${fmtNum(i.amount,4)} ${i.unit||''}`).join(' · ')):'Состав ещё не заполнен'}</span></summary>
      <div class="recipe-card-body"><h3>Состав</h3>${recipeCompositionHTML(r.ingredients)}<h3>Процесс приготовления</h3><div class="recipe-process">${esc(r.process||'Процесс ещё не добавлен.')}</div>${photos.length?`<div class="recipe-photos">${photos.map(p=>`<img src="${esc(p.src)}" alt="${esc(p.name)}" loading="lazy">`).join('')}</div>`:''}
      ${r.unparsedText?`<div class="notice warn recipe-preserved"><b>Проверьте и дополните</b><div class="recipe-process">${esc(r.unparsedText)}</div></div>`:''}
      <p class="tiny muted">${r.shelfLifeDays!=null?`Срок годности: ${fmtNum(r.shelfLifeDays,0)} дн. · `:''}${r.categoryMode==='manual'?'Категория выбрана вручную':r.categoryMode==='confirmed'?'Основной алкоголь подтверждён':'Автоматическая категория'}</p>${r.rawText?`<details class="recipe-source"><summary>Исходный текст</summary><div class="recipe-process">${esc(r.rawText)}</div></details>`:''}</div></details>
      <div class="actions recipe-card-actions"><button class="soft" data-editrecipe="${esc(r.id)}">Редактировать</button><button class="primary" data-recipe-calc="${esc(r.id)}">Рассчитать</button><button class="ghost" data-archive="${esc(r.id)}">${arch?'Вернуть':'В архив'}</button>${r.isDemo?`<button class="icon-btn" data-delete-recipe="${esc(r.id)}" aria-label="Удалить демо-карту" title="Удалить демо">×</button>`:''}</div></article>`;
  }).join('')}</div>`;
}
function recipeModal(id){
  const existing=state.recipes.find(x=>x.id===id);
  const r=normalizeRecipe(existing?structuredClone(existing):{id:null,name:'',yield:null,shelfLifeDays:30,ingredients:[],process:'',rawText:'',unparsedText:'',categoryMode:'auto',photos:[]});
  let photos=structuredClone(r.photos||[]), categoryMode=r.categoryMode||'auto', primaryAlcohol=r.primaryAlcohol||'', parseTimer=null, lastParsed={}, lastSourceParsed=r.rawText||'', photoBusy=false;
  const manuallyChanged=new Set();
  modal(`<div class="section-head"><h2>${id?'Технологическая карта':'Добавить ТК'}</h2><button class="icon-btn" id="closeM" aria-label="Закрыть">×</button></div>
    <div class="field full"><label for="rSource">Вставить готовую ТК целиком</label><textarea id="rSource" class="recipe-source-input" placeholder="Клюквенная настойка\nВодка — 1 л\nКлюква 300 г\nСахар 100 г\nПриготовление: смешать и настоять 7 дней.">${esc(r.rawText||'')}</textarea><p class="tiny muted">Текст распознаётся автоматически. Исправленные вручную поля сохраняются. Исходный текст остаётся в карточке.</p></div>
    <div class="actions"><button class="soft" id="parseRecipeSource">Распознать текст</button><button class="ghost" id="replaceRecipeSource">Заменить поля из текста</button></div><p id="rParseStatus" class="tiny muted" role="status" aria-live="polite"></p>
    <div class="divider"></div><div class="form-grid">
      <div class="field full"><label for="rName">Название *</label><input id="rName" value="${esc(r.name)}" placeholder="Например, Облепиха / ваниль" autocomplete="off"></div>
      <div class="field"><label for="rYield">Выход, л — необязательно</label><input id="rYield" type="number" min=".001" step="any" inputmode="decimal" value="${esc(r.yield??'')}" placeholder="Можно оставить пустым"></div>
      <div class="field"><label for="rShelf">Срок годности, дней</label><input id="rShelf" type="number" min="0" step="1" inputmode="numeric" value="${esc(r.shelfLifeDays??'')}"></div>
      <div class="field full"><label for="rLines">Состав — в любом привычном формате</label><textarea id="rLines" class="recipe-lines-input" placeholder="Водка 1 л\n300 г клюквы\nСахар — 100 г">${esc(r.ingredientsText||recipeIngredientText(r.ingredients))}</textarea><span class="tiny muted">Например: «Водка 1 л», «300 г клюквы» или «Водка | 1 | л | 500». Нераспознанные строки сохранятся для исправления.</span></div>
      <div class="field full"><label for="rProcess">Процесс приготовления</label><textarea id="rProcess" class="recipe-lines-input" placeholder="Опишите все шаги приготовления">${esc(r.process||'')}</textarea></div>
      <div class="field full"><label for="rUnparsed">Дополнительный текст / требует проверки</label><textarea id="rUnparsed" placeholder="Здесь останется информация, которую не удалось распределить автоматически">${esc(r.unparsedText||'')}</textarea></div>
      <div class="field full"><label for="rCat">Категория</label><input id="rCat" list="recipeCategories" value="${esc(r.category||'Без категории')}"><datalist id="recipeCategories">${ALCOHOL_CATEGORIES.map(c=>`<option value="${esc(c)}"></option>`).join('')}</datalist><span id="rCategoryStatus" class="tiny muted"></span><div class="actions"><button class="soft" id="rAutoCategory">Повторить автоматическую сортировку</button></div></div>
      <div class="field full" id="rPrimaryField" hidden><label for="rPrimary">Подтвердите основной алкоголь</label><select id="rPrimary"></select><span class="tiny muted">В составе несколько видов алкоголя. До подтверждения карта остаётся в категории «Требует уточнения».</span></div>
      <div class="field full"><label for="rPhotos">Фотографии приготовления — необязательно</label><input id="rPhotos" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple><span class="tiny muted">До 8 фотографий, до 3 МБ каждая и 10 МБ суммарно. Фотографии хранятся вместе с картой.</span><div id="rPhotoPreview" class="recipe-editor-photos"></div></div>
    </div><div id="rSaveError" class="notice warn" role="alert" hidden></div><div class="divider"></div><div class="actions"><button class="primary" id="saveRecipe">Сохранить ТК</button><button class="soft" id="closeM2">Отмена</button></div>`);
  const modalNode=$('#modal'),editorToken=Symbol('recipe-editor');modalNode._recipeEditorToken=editorToken;
  const alive=()=>modalNode._recipeEditorToken===editorToken&&$('#rName',modalNode)!=null&&!$('#modalBackdrop').hidden;
  const fields={name:'rName',yield:'rYield',shelfLifeDays:'rShelf',ingredients:'rLines',process:'rProcess',unparsedText:'rUnparsed'};
  for(const [key,fieldId] of Object.entries(fields))$('#'+fieldId).addEventListener('input',()=>manuallyChanged.add(key));
  const readDraft=()=>{
    const parsed=parseIngredientsText($('#rLines').value);
    return {...r,name:$('#rName').value.trim(),yield:$('#rYield').value===''?null:Number($('#rYield').value),shelfLifeDays:$('#rShelf').value===''?null:Number($('#rShelf').value),ingredients:parsed.ingredients,ingredientsText:$('#rLines').value,process:$('#rProcess').value.trim(),rawText:$('#rSource').value,unparsedText:mergeRecipeNotes($('#rUnparsed').value,parsed.unparsedText),category:$('#rCat').value.trim()||'Без категории',categoryMode,primaryAlcohol,photos:structuredClone(photos)};
  };
  const updateCategory=(force=false)=>{
    const classified=classifyRecipe(readDraft(),{force});categoryMode=classified.categoryMode;primaryAlcohol=classified.primaryAlcohol||'';
    $('#rCat').value=classified.category||'Без категории';
    $('#rCategoryStatus').textContent=categoryMode==='manual'?'Выбрана вручную. Автоматическая сортировка не изменит её до вашего запроса.':categoryMode==='confirmed'?'Основной алкоголь подтверждён. Состав будет проверен при изменении.':'Категория определяется по составу при сохранении.';
    const candidates=classified.alcoholCandidates||[];
    $('#rPrimaryField').hidden=candidates.length<2||categoryMode==='manual';
    $('#rPrimary').innerHTML=`<option value="">Выберите основной алкоголь</option>${candidates.map(c=>`<option value="${esc(c)}" ${primaryAlcohol===c?'selected':''}>${esc(c)}</option>`).join('')}`;
    return classified;
  };
  const parseSource=(replace=false)=>{
    if(!alive())return;const source=$('#rSource').value;if(!source.trim()){$('#rParseStatus').textContent='Вставьте текст готовой карты.';return;}
    const parsed=parseRecipeText(source);lastSourceParsed=source;
    const values={name:parsed.name||'',yield:parsed.yield??'',shelfLifeDays:parsed.shelfLifeDays??'',ingredients:recipeIngredientText(parsed.ingredients),process:parsed.process||'',unparsedText:parsed.unparsedText||''};
    let filled=0,kept=0;
    for(const [key,value] of Object.entries(values)){
      const field=$('#'+fields[key]),current=field.value;
      const safe=!manuallyChanged.has(key)&&(current===''||current===String(lastParsed[key]??'')||(key==='shelfLifeDays'&&!existing&&current==='30'));
      if(replace||safe){field.value=value;lastParsed[key]=String(value);manuallyChanged.delete(key);filled++;}else if(String(value)&&String(value)!==current)kept++;
    }
    updateCategory();$('#rParseStatus').textContent=`Распознано ингредиентов: ${parsed.ingredients.length}.${parsed.unparsedText?' Есть текст для ручной проверки.':''}${kept?' Заполненные и исправленные поля сохранены; для полной замены нажмите «Заменить поля из текста».':''}`;
    if(!filled)$('#rParseStatus').textContent+=' Поля уже заполнены.';
  };
  $('#rSource').addEventListener('input',()=>{clearTimeout(parseTimer);parseTimer=setTimeout(()=>parseSource(false),450);});
  $('#parseRecipeSource').onclick=()=>{clearTimeout(parseTimer);parseSource(false);};
  $('#replaceRecipeSource').onclick=()=>{clearTimeout(parseTimer);parseSource(true);};
  $('#rLines').addEventListener('input',()=>updateCategory());
  $('#rName').addEventListener('input',()=>updateCategory());
  $('#rCat').addEventListener('input',()=>{categoryMode='manual';primaryAlcohol='';updateCategory();});
  $('#rAutoCategory').onclick=()=>{updateCategory(true);toast('Автоматическая категория пересчитана. Сохраните карту, чтобы применить.');};
  $('#rPrimary').onchange=()=>{primaryAlcohol=$('#rPrimary').value;categoryMode=primaryAlcohol?'confirmed':'auto';updateCategory();};
  const renderPhotos=()=>{
    $('#rPhotoPreview').innerHTML=photos.map((p,i)=>{const src=recipePhotoSource(p);return `<div class="recipe-photo-item">${src?`<img src="${esc(src)}" alt="${esc(p?.name||'Фото приготовления')}">`:'<span>Фото недоступно</span>'}<button class="danger" type="button" data-remove-photo="${i}" aria-label="Удалить фотографию ${i+1}">Удалить</button></div>`;}).join('');
    $$('[data-remove-photo]',modalNode).forEach(b=>b.onclick=()=>{photos.splice(Number(b.dataset.removePhoto),1);renderPhotos();});
  };
  $('#rPhotos').onchange=async()=>{
    const files=[...$('#rPhotos').files];if(!files.length)return;
    try{
      if(photos.length+files.length>8)throw Error('Можно добавить не больше 8 фотографий.');
      if(files.some(f=>!/^image\/(jpeg|png|webp|gif)$/i.test(f.type)))throw Error('Поддерживаются фотографии JPG, PNG, WebP и GIF.');
      if(files.some(f=>f.size>3*1024*1024))throw Error('Одна фотография должна быть не больше 3 МБ.');
      const currentBytes=photos.reduce((n,p)=>n+(Number(p?.size)||Math.ceil(recipePhotoSource(p).length*.75)),0);
      if(currentBytes+files.reduce((n,f)=>n+f.size,0)>10*1024*1024)throw Error('Общий размер фотографий превышает 10 МБ.');
      photoBusy=true;$('#saveRecipe').disabled=true;
      const added=await Promise.all(files.map(file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({id:uid(),name:file.name,size:file.size,dataUrl:String(reader.result)});reader.onerror=()=>reject(Error('Не удалось прочитать фотографию.'));reader.readAsDataURL(file);})));if(!alive())return;photos.push(...added);renderPhotos();
    }catch(err){toast(err.message,'error');}finally{photoBusy=false;if(alive()){$('#rPhotos').value='';$('#saveRecipe').disabled=false;}}
  };
  const leave=()=>{clearTimeout(parseTimer);closeModal();};$('#closeM').onclick=$('#closeM2').onclick=leave;
  $('#saveRecipe').onclick=async()=>{
    if(photoBusy)return;clearTimeout(parseTimer);if($('#rSource').value.trim()&&($('#rSource').value!==lastSourceParsed||!$('#rName').value.trim()))parseSource(false);
    let next=readDraft();
    if(!next.name){toast('Укажите название. Остальные поля можно заполнить позже.','error');$('#rName').focus();return;}
    if(next.yield!==null&&(!Number.isFinite(next.yield)||next.yield<=0)){toast('Выход должен быть больше нуля или оставлен пустым.','error');$('#rYield').focus();return;}
    if(next.shelfLifeDays!==null&&(!Number.isInteger(next.shelfLifeDays)||next.shelfLifeDays<0)){toast('Срок годности должен быть целым числом от нуля.','error');$('#rShelf').focus();return;}
    next=normalizeRecipe(classifyRecipe({...next,id:existing?.id||uid(),archived:existing?.archived||false,updatedAt:nowISO(),isDemo:false}));
    const duplicate=findRecipeDuplicate(next,state.recipes.filter(x=>x.id!==next.id));
    if(duplicate){toast(`Такая ТК уже существует: «${duplicate.name}». Карта не продублирована.`,'error');return;}
    const sourceSignatures=[...(existing?.importSignatures||[])];
    if(next.rawText.trim()){const source=parseRecipeText(next.rawText);if(source.name)sourceSignatures.push(recipeFingerprint(normalizeRecipe(source)));}
    next.importSignatures=[...new Set([...sourceSignatures,recipeFingerprint(next)])];
    $('#rSaveError').hidden=true;
    const saved=await commitStateChange(()=>{const idx=state.recipes.findIndex(x=>x.id===next.id);if(idx>=0)state.recipes[idx]=next;else state.recipes.push(next);},'Не удалось сохранить карту. Данные остались в форме; повторите попытку.');
    if(saved){if(alive())leave();toast(next.category==='Требует уточнения'?'ТК сохранена. Подтвердите основной алкоголь в редакторе.':'Технологическая карта сохранена');render();}
    else if(alive()){$('#rSaveError').hidden=false;$('#rSaveError').textContent='Карта не сохранена. Данные остались в форме. Проверьте свободное место и повторите сохранение.';}
  };
  renderPhotos();updateCategory();
}
function mergeRecipeNotes(...values){return [...new Set(values.flatMap(value=>String(value||'').split(/\r?\n/)).map(s=>s.trim()).filter(Boolean))].join('\n');}
function parseIngredientLines(text){return parseIngredientsText(text).ingredients;}
function recipeImportMetadata(recipe){return JSON.stringify({shelfLifeDays:recipe.shelfLifeDays??null,category:recipe.category||'',prices:(recipe.ingredients||[]).map(i=>[String(i.name).toLowerCase(),i.unit,Number(i.amount),Number(i.cost||0)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),photos:(recipe.photos||[]).map(p=>[recipePhotoSource(p),typeof p==='string'?'':p?.name||'']).filter(p=>p[0])});}
function recipeImportDifferences(current,incoming){
  const changes=[],add=(label,a,b)=>{if(String(a??'')!==String(b??''))changes.push({label,current:String(a??'не указано'),incoming:String(b??'не указано')});};
  if(recipeFingerprint(current)!==recipeFingerprint(incoming)){add('Название',current.name,incoming.name);add('Выход, л',current.yield,incoming.yield);add('Процесс',current.process,incoming.process);add('Дополнительный текст',current.unparsedText,incoming.unparsedText);}
  add('Состав и цены',recipeIngredientText(current.ingredients),recipeIngredientText(incoming.ingredients));add('Срок годности, дней',current.shelfLifeDays,incoming.shelfLifeDays);add('Категория',current.category,incoming.category);
  const photoKey=r=>JSON.stringify((r.photos||[]).map(p=>[recipePhotoSource(p),typeof p==='string'?'':p?.name||'']).filter(p=>p[0]));
  if(photoKey(current)!==photoKey(incoming))changes.push({label:'Фотографии',current:`${(current.photos||[]).length} шт.`,incoming:`${(incoming.photos||[]).length} шт. (существующие фотографии сохранятся)`});
  return changes;
}
function findRecipeDuplicate(recipe,list){const signatures=new Set([recipeFingerprint(recipe),...(recipe.importSignatures||[])]),matches=list.filter(r=>[recipeFingerprint(r),...(r.importSignatures||[])].some(value=>signatures.has(value)));return matches.find(r=>recipeFingerprint(r)===recipeFingerprint(recipe)&&recipeImportMetadata(r)===recipeImportMetadata(recipe))||matches[0];}
async function toggleArchive(id){
  const r=state.recipes.find(x=>x.id===id);if(!r)return;const archived=!r.archived;
  if(await commitStateChange(()=>{const recipe=state.recipes.find(x=>x.id===id);recipe.archived=archived;recipe.updatedAt=nowISO();},'Не удалось сохранить изменение архива. Повторите попытку.')){toast(archived?'Перемещено в архив':'Возвращено в актуальные');render();}
}
async function deleteRecipe(id){
  const r=state.recipes.find(x=>x.id===id);if(!r?.isDemo)return;
  if(await commitStateChange(()=>{state.recipes=state.recipes.filter(x=>x.id!==id);},'Не удалось удалить демо-карту. Повторите попытку.')){if(ui.recipeId===id)ui.recipeId='';toast('Демо-карта удалена');render();}
}
function recipeCalculationModal(id){
  const recipe=state.recipes.find(r=>r.id===id);if(!recipe)return;
  const values={basis:'yield',target:Number(recipe.yield)>0?Number(recipe.yield):1,baseYield:null,ingredientIndex:0,ingredientAmount:'',ingredientUnit:''};
  modal(`<div class="section-head"><h2>Рассчитать: ${esc(recipe.name)}</h2><button class="icon-btn" id="closeM" aria-label="Закрыть">×</button></div><p class="tiny muted">Расчёт временный. Состав, процесс и выход исходной карточки сохраняются.</p>
    <div id="recipeCalcControls">${calculationControls(recipe,values,'recipeCalc')}</div><div class="divider"></div><div id="recipeCalcResult" aria-live="polite"></div><div class="actions"><button class="soft" id="closeM2">Закрыть</button></div>`);
  const calculate=()=>{
    const result=calculationFor(recipe,values);
    if(!result.valid){$('#recipeCalcResult').innerHTML=`<div class="notice warn">${esc(result.error)}</div>`;return;}
    const {rows,factor,targetYield:target}=result;
    $('#recipeCalcResult').innerHTML=`<p class="tiny muted">${calculationSummary(recipe,values,result)}</p><h3>${target>0?`Состав на ${fmtNum(target,4)} л`:'Состав по количеству ингредиента'}</h3>${recipeCompositionHTML(rows)}<h3>Процесс приготовления</h3><div class="recipe-process">${esc(scaleProcess(recipe.process||'',factor)||'Процесс ещё не добавлен.')}</div>${recipe.unparsedText?`<div class="notice warn"><b>Дополнительный текст не пересчитан — проверьте вручную</b><div class="recipe-process">${esc(recipe.unparsedText)}</div></div>`:''}<p class="tiny muted">Количество масштабировано в ${fmtNum(factor,4)} раза. Время, температура и проценты остаются прежними.</p>`;
  };
  const renderControls=()=>{$('#recipeCalcControls').innerHTML=calculationControls(recipe,values,'recipeCalc');bindCalculationControls(recipe,values,'recipeCalc',calculate,renderControls);calculate();};
  $('#closeM').onclick=$('#closeM2').onclick=closeModal;renderControls();
}
function exportRecipes(){
  const blob=new Blob([JSON.stringify({format:'tincture-lab-recipes',version:2,exportedAt:nowISO(),recipes:state.recipes},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`tincture-lab-recipes-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast(`Выгружено ТК: ${state.recipes.length}, включая архив и незаполненные карты`);
}
function importModal(){
  let pending=[],busy=false;const selectedUpdates=new Set(),selectedCategories=new Set();
  modal(`<div class="section-head"><h2>Загрузить ТК из файла</h2><button class="icon-btn" id="closeM" aria-label="Закрыть">×</button></div><div class="notice">Excel (.xlsx / .xls), CSV, TSV, JSON или текст (.txt). Можно загрузить одну карту, несколько карт или список названий. Перед сохранением появится предварительный просмотр.</div><div class="form-grid recipe-import-form"><div class="field full"><label for="recipeFile">Файл</label><input id="recipeFile" type="file" accept=".xlsx,.xls,.csv,.tsv,.json,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/tab-separated-values,application/json,text/plain"></div><div class="field full"><label for="csvName">Название для файла с составом одной карты — необязательно</label><input id="csvName" placeholder="Если название отсутствует в файле"></div></div><div class="actions"><button class="primary" id="doImport">Прочитать файл</button></div><div id="recipeImportPreview" class="recipe-import-preview" aria-live="polite"></div><div id="recipeImportError" class="notice warn" role="alert" hidden></div><div class="actions"><button class="primary" id="saveRecipeImport" hidden>Сохранить карты</button><button class="soft" id="closeM2">Отмена</button></div>`);
  const modalNode=$('#modal'),importToken=Symbol('recipe-import');modalNode._recipeImportToken=importToken;
  const alive=()=>modalNode._recipeImportToken===importToken&&!!$('#recipeFile')&&!$('#modalBackdrop').hidden;
  $('#closeM').onclick=$('#closeM2').onclick=()=>{if(!busy)closeModal();};
  const preview=()=>{
    const seen=[...state.recipes];let duplicates=0;
    pending=pending.map(recipe=>{const duplicate=findRecipeDuplicate(recipe,seen);if(duplicate)duplicates++;else seen.push(recipe);return {...recipe,_duplicate:!!duplicate,_changes:duplicate?recipeImportDifferences(duplicate,recipe):[],_manualCategory:duplicate?.categoryMode==='manual'};});
    $('#recipeImportPreview').innerHTML=`<div class="divider"></div><h3>Предварительный просмотр</h3><p class="tiny muted">Карт в файле: ${pending.length}. Новых: ${pending.length-duplicates}. Повторных: ${duplicates}. Повторные карты пропускаются. Если данные отличаются, их можно проверить и явно обновить существующую ТК.</p><div class="recipe-import-list">${pending.map((r,index)=>`<div class="recipe-import-row"><div><strong>${esc(r.name)}</strong><div class="tiny muted">${esc(r.category||'Без категории')} · ${(r.ingredients||[]).length} ингредиентов · ${r.yield?`${fmtNum(r.yield)} л`:'без выхода'}${r.unparsedText?' · есть текст для проверки':''}</div>${r.category==='Требует уточнения'?'<div class="tiny danger-text">После импорта подтвердите основной алкоголь в редакторе.</div>':''}${r._changes.length?`<details><summary class="tiny danger-text">Данные отличаются — сравнить (${r._changes.length})</summary>${r._changes.map(change=>`<div class="notice"><b>${esc(change.label)}</b><div class="recipe-process">Сейчас: ${esc(change.current)}\nВ файле: ${esc(change.incoming)}</div></div>`).join('')}<label class="tiny"><input type="checkbox" data-import-update="${index}"> Обновить существующую ТК из файла</label>${r._manualCategory?`<p class="tiny muted">Ручная категория сохранится.</p><label class="tiny"><input type="checkbox" data-import-category="${index}"> Также заменить ручную категорию значением из файла</label>`:''}</details>`:''}</div><span class="pill ${r._duplicate?'dark':!(r.ingredients||[]).length&&!r.process?'burg':'olive'}">${r._changes.length?'Есть отличия':r._duplicate?'Уже есть':!(r.ingredients||[]).length&&!r.process?'Нужно заполнить':'Новая'}</span></div>`).join('')}</div>`;
    const refreshSave=()=>{$('#saveRecipeImport').hidden=pending.length===duplicates&&!selectedUpdates.size;$('#saveRecipeImport').textContent=`Сохранить: новых ${pending.length-duplicates}, обновлений ${selectedUpdates.size}`;};
    $$('[data-import-update]').forEach(input=>input.onchange=()=>{const index=Number(input.dataset.importUpdate);if(input.checked)selectedUpdates.add(index);else selectedUpdates.delete(index);refreshSave();});$$('[data-import-category]').forEach(input=>input.onchange=()=>{const index=Number(input.dataset.importCategory);if(input.checked)selectedCategories.add(index);else selectedCategories.delete(index);});refreshSave();
  };
  $('#recipeFile').onchange=()=>{pending=[];selectedUpdates.clear();selectedCategories.clear();$('#recipeImportPreview').innerHTML='';$('#saveRecipeImport').hidden=true;$('#recipeImportError').hidden=true;};
  $('#doImport').onclick=async()=>{
    const file=$('#recipeFile').files[0];if(!file){toast('Выберите файл','error');return;}if(busy)return;busy=true;selectedUpdates.clear();selectedCategories.clear();$('#doImport').disabled=true;$('#recipeImportError').hidden=true;
    try{const recipes=await readRecipeFile(file,$('#csvName').value.trim());if(!alive())return;if(!recipes.length)throw Error('В файле не найдено ни одной карты.');pending=recipes.map(raw=>{const recipe=normalizeRecipe(classifyRecipe({...raw,id:uid(),updatedAt:nowISO(),archived:!!raw.archived}));return {...recipe,importSignatures:[...new Set([...(raw.importSignatures||[]),recipeFingerprint(recipe)])]};});preview();}
    catch(err){if(alive()){$('#recipeImportError').hidden=false;$('#recipeImportError').textContent=`Не удалось прочитать файл: ${err.message}. Исходный файл не изменён.`;}}
    finally{busy=false;if(alive())$('#doImport').disabled=false;}
  };
  $('#saveRecipeImport').onclick=async()=>{
    if(busy||!pending.length)return;busy=true;$('#saveRecipeImport').disabled=true;$('#doImport').disabled=true;
    let added=0,skipped=0,updated=0;
    const saved=await commitStateChange(()=>{pending.forEach((raw,index)=>{const {_duplicate,_changes,_manualCategory,...recipe}=raw,duplicate=findRecipeDuplicate(recipe,state.recipes);if(duplicate){if(!selectedUpdates.has(index)||!recipeImportDifferences(duplicate,recipe).length){skipped++;return;}const category=duplicate.categoryMode==='manual'&&!selectedCategories.has(index)?{category:duplicate.category,categoryMode:duplicate.categoryMode,primaryAlcohol:duplicate.primaryAlcohol}:{};const photoMap=new Map([...(duplicate.photos||[]),...(recipe.photos||[])].map(photo=>[recipePhotoSource(photo)||JSON.stringify(photo),photo]));Object.assign(duplicate,normalizeRecipe({...recipe,id:duplicate.id,archived:duplicate.archived,photos:[...photoMap.values()],rawText:mergeRecipeNotes(duplicate.rawText,recipe.rawText),importSignatures:[...new Set([...(duplicate.importSignatures||[]),...(recipe.importSignatures||[]),recipeFingerprint(duplicate),recipeFingerprint(recipe)])],...category,updatedAt:nowISO()}));updated++;return;}state.recipes.push(classifyRecipe({...recipe,updatedAt:nowISO()}));added++;});},'Не удалось сохранить импорт. База не изменена; просмотр остался в форме.');
    busy=false;if(saved){if(alive())closeModal();toast(`Добавлено ТК: ${added}. Обновлено: ${updated}${skipped?`. Повторных пропущено: ${skipped}`:''}`);render();}else if(alive()){$('#recipeImportError').hidden=false;$('#recipeImportError').textContent='Не удалось сохранить импорт. База не изменена. Просмотр и исходный файл сохранены; повторите попытку.';$('#saveRecipeImport').disabled=false;$('#doImport').disabled=false;}
  };
}

function renderWarehouse(){
  const total=state.stock.length;
  $('#content').innerHTML=`<div class="grid four"><div class="card metric"><span class="label">Позиций</span><div class="value">${total}</div><div class="sub">учитывается на складе</div></div><div class="card metric"><span class="label">Отрицательные</span><div class="value danger-text">${state.stock.filter(x=>x.amount<0).length}</div><div class="sub">требуют корректировки</div></div><div class="card metric"><span class="label">Себестоимость остатков</span><div class="value">${fmtMoney(state.stock.reduce((s,x)=>s+Math.max(0,x.amount)*Number(x.cost||0),0))}</div><div class="sub">по указанным ценам</div></div><div class="card metric"><span class="label">Источник</span><div class="value">${state.requisitions.filter(r=>r.status==='confirmed').length}</div><div class="sub">подтверждённых заявок</div></div></div><div style="height:18px"></div><section class="card"><div class="section-head"><div><h2>Остатки ингредиентов</h2><p class="tiny muted">Плюс — подтверждённые заявки. Минус — фактические постановки.</p></div><button class="primary" id="stockAdjust">Ручная корректировка</button></div>${state.stock.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Ингредиент</th><th>Остаток</th><th>Цена</th><th>Оценка</th></tr></thead><tbody>${[...state.stock].sort((a,b)=>a.name.localeCompare(b.name,'ru')).map(x=>`<tr><td class="row-title">${esc(x.name)}</td><td class="${x.amount<0?'danger-text':''}">${fmtNum(x.amount,4)} ${esc(x.unit)}</td><td>${x.cost?fmtMoney(x.cost):'—'}</td><td>${x.cost?fmtMoney(x.amount*x.cost):'—'}</td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">Склад появится после подтверждения первой заявки.</div>`}</section>`;
  $('#stockAdjust').onclick=stockAdjustModal;
}
function stockAdjustModal(){modal(`<div class="section-head"><h2>Ручная корректировка</h2><button class="icon-btn" id="closeM">×</button></div><div class="form-grid"><div class="field"><label>Ингредиент</label><input id="sName"></div><div class="field"><label>Единица</label><input id="sUnit" value="кг"></div><div class="field"><label>Изменить на (+/−)</label><input id="sAmount" type="number" step="any"></div><div class="field"><label>Цена за единицу</label><input id="sCost" type="number" min="0" step="any"></div></div><div class="actions" style="margin-top:16px"><button class="primary" id="saveStock">Применить</button></div>`);$('#closeM').onclick=closeModal;$('#saveStock').onclick=async()=>{const name=$('#sName').value.trim(),unit=$('#sUnit').value.trim(),amount=Number($('#sAmount').value),costText=$('#sCost').value,cost=Number(costText||0);if(!name||!unit||!Number.isFinite(amount)||amount===0||!Number.isFinite(cost)||cost<0){toast('Проверьте название, единицу, изменение и цену от нуля.','error');return;}if(await commitStateChange(()=>{const idx=state.stock.findIndex(x=>inventoryItemKey(x)===inventoryItemKey({name,unit}));if(idx>=0){state.stock[idx].amount=round(Number(state.stock[idx].amount)+amount,4);if(costText!=='')state.stock[idx].cost=cost;}else state.stock.push({name,unit,amount,cost});},'Не удалось сохранить корректировку. Склад не изменён; данные остались в форме.')){closeModal();toast('Склад скорректирован');render();}};}

function renderBatches(){
  const batches=[...state.batches].filter(b=>!b.stoppedAt).sort((a,b)=>new Date(a.expiresAt)-new Date(b.expiresAt));
  const soon=batches.filter(b=>expiryStatus(b.expiresAt).key==='soon').length,expired=batches.filter(b=>expiryStatus(b.expiresAt).key==='expired').length;
  $('#content').innerHTML=`<div class="grid three"><div class="card metric"><span class="label">Активных партий</span><div class="value">${batches.length}</div></div><div class="card metric"><span class="label">До 3 дней</span><div class="value ${soon?'danger-text':''}">${soon}</div></div><div class="card metric"><span class="label">Просрочено</span><div class="value danger-text">${expired}</div></div></div><div style="height:18px"></div><section class="card"><div class="section-head"><h2>Готовые настойки и кордиалы</h2><button class="soft" id="goCalc">+ Новая постановка</button></div>${batches.length?`<div class="list">${batches.map(b=>batchRow(b)).join('')}</div>`:`<div class="empty">Активных партий пока нет.</div>`}</section>`;
  $('#goCalc').onclick=()=>{calcMode='production';setRoute('calculator')};$$('[data-stop]').forEach(b=>b.onclick=()=>stopBatch(b.dataset.stop));
}
function batchRow(b){const st=expiryStatus(b.expiresAt);const left=daysUntil(b.expiresAt);return `<div class="list-item"><div class="list-main"><div class="list-title">${esc(b.name)}</div><div class="list-sub">готово ${fmtDate(b.startedAt)} · ${fmtNum(b.actualYield)} л · годно до ${fmtDate(b.expiresAt)}</div></div><div class="list-side"><span class="pill ${st.key==='ok'?'olive':'burg'}">${st.key==='expired'?'просрочено':left===0?'сегодня':`${left} дн.`}</span><button class="danger" data-stop="${esc(b.id)}">В стоп-лист</button></div></div>`}
function stopBatch(id){
  const b=state.batches.find(x=>x.id===id);if(!b||b.stoppedAt)return;
  modal(`<div class="section-head"><h2>Поместить в стоп-лист</h2><button class="icon-btn" id="closeM">×</button></div><p class="tiny muted">Укажите остаток готового продукта на момент стопа — так статистика посчитает реально израсходованный объём и скорость расхода.</p><div class="form-grid"><div class="field"><label>Приготовлено, л</label><input value="${esc(b.actualYield)}" disabled></div><div class="field"><label>Остаток, л</label><input id="stopRemain" type="number" min="0" max="${esc(b.actualYield)}" step="any" value="0"></div></div><div class="actions" style="margin-top:16px"><button class="danger" id="confirmStop">В стоп-лист</button><button class="soft" id="closeM2">Отмена</button></div>`);
  $('#closeM').onclick=$('#closeM2').onclick=closeModal;
  $('#confirmStop').onclick=async()=>{const remaining=Number($('#stopRemain').value),batch=state.batches.find(x=>x.id===id);if(!batch||batch.stoppedAt)return;if(!Number.isFinite(remaining)||remaining<0||remaining>Number(batch.actualYield)){toast('Остаток должен быть от нуля до приготовленного объёма.','error');return;}if(await commitStateChange(()=>{const current=state.batches.find(x=>x.id===id);if(!current||current.stoppedAt)return;current.remainingVolume=remaining;current.stoppedAt=nowISO();const vel=batchVelocity(current);state.stopList.unshift({id:uid(),recipeId:current.recipeId,name:current.name,since:nowISO(),batchId:current.id});state.stats.unshift({id:uid(),type:'stop',recipeId:current.recipeId,name:current.name,createdAt:nowISO(),batchId:current.id,actualYield:current.actualYield,remainingVolume:remaining,consumedVolume:vel?.consumed||0,daysToStop:vel?.days||null,perDay:vel?.perDay||null});},'Не удалось сохранить стоп. Партия и статистика не изменены.')){closeModal();toast('Добавлено в стоп-лист');render();}};
}

function renderStats(){
  const prod=state.stats.filter(s=>s.type==='production'), stops=state.stats.filter(s=>s.type==='stop');
  const grouped=Object.create(null);for(const s of stops){(grouped[s.name]??=[]).push(s)}
  const speed=Object.entries(grouped).map(([name,arr])=>({name,count:arr.length,avgDays:round(arr.reduce((a,x)=>a+Number(x.daysToStop||0),0)/arr.length,1),avgPerDay:round(arr.reduce((a,x)=>a+Number(x.perDay||0),0)/arr.length,2)})).sort((a,b)=>a.avgDays-b.avgDays);
  const recent=prod.slice(0,7).reverse(); const max=Math.max(1,...recent.map(x=>Number(x.actualYield||0)));
  $('#content').innerHTML=`<div class="grid four"><div class="card metric"><span class="label">Постановок</span><div class="value">${prod.length}</div></div><div class="card metric"><span class="label">Произведено</span><div class="value">${fmtNum(prod.reduce((s,x)=>s+Number(x.actualYield||0),0))} л</div></div><div class="card metric"><span class="label">Стопов</span><div class="value">${stops.length}</div></div><div class="card metric"><span class="label">Технологий</span><div class="value">${state.recipes.length}</div></div></div><div style="height:18px"></div><div class="grid two"><section class="card"><h2>Последние объёмы</h2>${recent.length?`<div class="chart-bars">${recent.map(x=>`<div class="chart-bar" style="height:${Math.max(4,Number(x.actualYield||0)/max*100)}%" title="${esc(x.name)} — ${fmtNum(x.actualYield)} л"><span>${fmtDate(x.createdAt).slice(0,6)}</span></div>`).join('')}</div>`:`<div class="empty">Нет данных</div>`}</section><section class="card"><h2>Как быстро заканчивается</h2>${speed.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Настойка</th><th>Стопов</th><th>Среднее</th><th>Темп</th></tr></thead><tbody>${speed.map(x=>`<tr><td class="row-title">${esc(x.name)}</td><td>${x.count}</td><td>${fmtNum(x.avgDays,1)} дн.</td><td>${fmtNum(x.avgPerDay,2)} л/день</td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">Темп появится после первых стопов.</div>`}</section></div><div style="height:18px"></div><section class="card"><h2>История производства</h2>${prod.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Дата</th><th>Продукт</th><th>План</th><th>Факт</th><th>Версия</th></tr></thead><tbody>${prod.map(x=>`<tr><td>${fmtDate(x.createdAt)}</td><td class="row-title">${esc(x.name)}</td><td>${fmtNum(x.targetYield)} л</td><td>${fmtNum(x.actualYield)} л</td><td><button class="soft" data-use-version="${esc(x.id)}">Использовать</button></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">История заполнится после первого приготовления.</div>`}</section>`;
  $$('[data-use-version]').forEach(b=>b.onclick=()=>useStatVersion(b.dataset.useVersion));
}
async function useStatVersion(id){const s=state.stats.find(x=>x.id===id);if(!s?.recipeSnapshot)return;const r=state.recipes.find(x=>x.id===s.recipeId);if(!r||r.archived){toast('Сначала верните технологическую карту из архива.','error');return;}if(await commitStateChange(()=>{const recipe=state.recipes.find(x=>x.id===s.recipeId);recipe.ingredients=structuredClone(s.recipeSnapshot.ingredients||[]);recipe.ingredientsText=recipeIngredientText(recipe.ingredients);recipe.yield=s.recipeSnapshot.yield??recipe.yield;recipe.shelfLifeDays=s.recipeSnapshot.shelfLifeDays??recipe.shelfLifeDays;Object.assign(recipe,classifyRecipe(recipe));recipe.updatedAt=nowISO();},'Не удалось подставить фактическую версию. Карта не изменена.')){ui.recipeId=r.id;ui.baseYield=null;ui.basis='yield';calcMode='production';toast('Последняя фактическая версия подставлена');setRoute('calculator');}}

function noticeRows(){
  const rows=[];for(const b of state.batches.filter(x=>!x.stoppedAt)){const st=expiryStatus(b.expiresAt);if(st.key!=='ok')rows.push({id:`expiry-${b.id}`,type:st.key,title:b.name,sub:st.key==='expired'?`Срок истёк ${fmtDate(b.expiresAt)}`:`До окончания ${Math.max(0,st.days)} дн. · ${fmtDate(b.expiresAt)}`,date:b.expiresAt});}
  for(const s of state.stock.filter(x=>x.amount<0))rows.push({id:`stock-${s.name}-${s.unit}`,type:'shortage',title:`Дефицит: ${s.name}`,sub:`Баланс ${fmtNum(s.amount,4)} ${s.unit}`,date:nowISO()});
  return rows.sort((a,b)=>new Date(a.date)-new Date(b.date));
}
function updateNoticeBadge(){const n=noticeRows().filter(x=>!state.readNotices.includes(x.id)).length;$('#notificationBadge').hidden=!n;$('#notificationBadge').textContent=n>99?'99+':n;}
function renderNotifications(){const rows=noticeRows();$('#content').innerHTML=`<div class="section-head"><div><h2>Центр уведомлений</h2><p class="tiny muted">Партии попадают сюда за 3 дня до конца срока и остаются до стопа/списания.</p></div><button class="soft" id="markRead">Отметить просмотренными</button></div>${rows.length?`<div class="list">${rows.map(n=>`<div class="list-item"><div class="list-main"><div class="list-title ${n.type==='expired'||n.type==='shortage'?'danger-text':''}">${esc(n.title)}</div><div class="list-sub">${esc(n.sub)}</div></div><span class="pill ${n.type==='soon'?'burg':'dark'}">${n.type==='soon'?'срок':n.type==='expired'?'просрочено':'склад'}</span></div>`).join('')}</div>`:`<div class="empty">Сейчас критичных уведомлений нет.</div>`}`;$('#markRead').onclick=async()=>{if(await commitStateChange(()=>{state.readNotices=[...new Set([...state.readNotices,...rows.map(x=>x.id)])];},'Не удалось сохранить отметки уведомлений.',false)){updateNoticeBadge();toast('Уведомления отмечены просмотренными');}};}
async function checkExpiryNotifications(){
  const soon=noticeRows().filter(x=>x.type==='soon'&&!state.readNotices.includes(x.id));
  updateNoticeBadge();
  if(soon.length && state.settings.notifications && 'Notification'in window && Notification.permission==='granted'){
    const reg=await navigator.serviceWorker?.ready; reg?.showNotification('Tincture Lab: срок годности',{body:`${soon.length} партий испортятся в течение 3 дней`,icon:'icon.svg',tag:'expiry'}).catch(()=>{});
  }
}

function renderSettings(){
  $('#content').innerHTML=`<div class="grid two"><section class="card"><h2>Установка и офлайн</h2><div class="notice">Приложение кэширует интерфейс и хранит рабочие данные в IndexedDB. После первого открытия его можно использовать без интернета.</div><div class="divider"></div><div class="actions"><button class="primary" id="installSettings">Установить на устройство</button><button class="soft" id="notifySettings">${state.settings.notifications?'Уведомления включены':'Включить уведомления'}</button></div><div class="divider"></div><p class="tiny muted">На iPhone установка выполняется через Safari → «Поделиться» → «На экран Домой». Фоновая доставка системных уведомлений зависит от браузера; внутренний центр сроков работает всегда.</p></section><section class="card"><h2>Синхронизация с Supabase</h2><div class="form-grid"><div class="field full"><label>Project URL</label><input id="supUrl" value="${esc(state.settings.supabaseUrl||'')}" placeholder="https://xxxx.supabase.co"></div><div class="field full"><label>Anon key</label><input id="supKey" type="password" value="${esc(state.settings.supabaseKey||'')}" placeholder="eyJ..."></div><div class="field full"><label>Workspace ID</label><input id="workspaceId" value="${esc(state.settings.workspaceId||'tincture-lab-main')}"></div></div><div class="divider"></div><div class="actions"><button class="primary" id="saveSync">Сохранить и синхронизировать</button><button class="soft" id="pullSync">Загрузить из облака</button></div><p class="tiny muted">Перед подключением выполните <b>setup.sql</b> в Supabase. Текущая схема рассчитана на один цех/MVP; для нескольких сотрудников лучше добавить авторизацию и RLS.</p></section></div><div style="height:18px"></div><section class="card"><h2>Резервная копия</h2><div class="actions"><button class="soft" id="exportData">Скачать JSON</button><label class="soft" style="display:inline-flex;align-items:center;padding:0 14px"><input id="importData" type="file" accept="application/json" hidden>Загрузить JSON</label></div></section>`;
  $('#installSettings').onclick=triggerInstall;$('#notifySettings').onclick=enableNotifications;$('#saveSync').onclick=async()=>{const settings={supabaseUrl:$('#supUrl').value.trim().replace(/\/$/,''),supabaseKey:$('#supKey').value.trim(),workspaceId:$('#workspaceId').value.trim()||'tincture-lab-main'};if(await commitStateChange(()=>Object.assign(state.settings,settings),'Не удалось сохранить настройки. Данные остались в форме.')){await syncPush(true);render();}};$('#pullSync').onclick=()=>syncPull(true);$('#exportData').onclick=exportData;$('#importData').onchange=importData;
}
function exportData(){const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`tincture-lab-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
async function importData(e){const f=e.target.files[0];if(!f)return;try{const data=JSON.parse(await f.text());if(!data.recipes||!data.settings)throw Error('неверная структура');const restored=normalizeState(data);if(await commitStateChange(()=>{state=restored;},'Не удалось сохранить резервную копию. Текущая база не изменена.')){toast('Резервная копия загружена');render();}}catch(err){toast('Ошибка импорта: '+err.message,'error')}}

async function syncPush(manual=false){
  const {supabaseUrl:url,supabaseKey:key,workspaceId:id}=state.settings;if(!url||!key||!id){if(manual)toast('Сначала заполните настройки Supabase','error');return false}if(!navigator.onLine){if(manual)toast('Нет интернета — изменения останутся в очереди','error');return false}
  updateNetwork('syncing');
  const payload=structuredClone(state);payload.meta={...payload.meta,dirty:false,lastSynced:nowISO()};
  try{const r=await fetch(`${url}/rest/v1/tincture_workspaces`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({id,data:payload,updated_at:nowISO()})});if(!r.ok)throw Error(`${r.status} ${await r.text()}`);state.meta.dirty=state.meta.lastModified!==payload.meta.lastModified;state.meta.lastSynced=nowISO();await dbSet('state',state);updateNetwork();if(state.meta.dirty){clearTimeout(syncTimer);syncTimer=setTimeout(()=>syncPush().catch(()=>{}),900);}if(manual)toast('Синхронизация выполнена');return true;}catch(e){updateNetwork('error');if(manual)toast('Ошибка синхронизации: '+e.message,'error');return false;}
}
async function syncPull(manual=false){
  const {supabaseUrl:url,supabaseKey:key,workspaceId:id}=state.settings;if(!url||!key||!id){if(manual)toast('Заполните настройки Supabase','error');return false}
  if(syncPullBusy||stateMutationBusy){if(manual)toast('Дождитесь завершения текущего сохранения.','error');return false;}
  syncPullBusy=true;const localWasDirty=state.meta.dirty,localModifiedAt=state.meta.lastModified;clearTimeout(syncTimer);
  const resumePush=()=>{if(state.meta.dirty&&navigator.onLine&&state.settings.supabaseUrl&&state.settings.supabaseKey){clearTimeout(syncTimer);syncTimer=setTimeout(()=>syncPush().catch(()=>{}),900);}};
  let conflictOpen=false;
  try{
    const response=await fetch(`${url}/rest/v1/tincture_workspaces?id=eq.${encodeURIComponent(id)}&select=data,updated_at`,{headers:{apikey:key,Authorization:`Bearer ${key}`}});if(!response.ok)throw Error(`${response.status}`);const rows=await response.json();
    if(!rows.length){if(manual)toast('Облачной копии пока нет');return false;}
    const remote=normalizeState(rows[0].data);remote.settings={...remote.settings,...state.settings};remote.meta={...remote.meta,dirty:false,lastSynced:nowISO()};
    const applyRemote=async()=>{const saved=await commitStateChange(()=>{state=structuredClone(remote);},'Не удалось сохранить облачную копию на устройстве. Текущая локальная база сохранена.',false);if(saved){if(conflictOpen)closeModal();toast('Облачные данные загружены');render();updateNetwork();}return saved;};
    if(localWasDirty||state.meta.dirty||state.meta.lastModified!==localModifiedAt){
      conflictOpen=true;
      modal(`<div class="section-head"><h2>На устройстве есть свои изменения</h2><button class="icon-btn" id="closeCloudConflict" aria-label="Закрыть">×</button></div><div class="notice warn">Загрузка облачной копии заменит текущую базу на этом устройстве. Сначала можно выгрузить её резервную копию.</div><p class="tiny muted">Локально: ${state.recipes.length} ТК. В облаке: ${remote.recipes.length} ТК. Состав, заявки, склад, партии и история будут взяты из облачной копии.</p><div class="actions"><button class="soft" id="exportBeforeCloud">Выгрузить текущую копию</button><button class="danger" id="applyCloudCopy">Загрузить облачную копию и заменить локальную</button><button class="soft" id="cancelCloudCopy">Оставить текущую базу</button></div>`);
      modalAfterClose=resumePush;$('#exportBeforeCloud').onclick=exportData;$('#closeCloudConflict').onclick=$('#cancelCloudCopy').onclick=closeModal;$('#applyCloudCopy').onclick=applyRemote;return false;
    }
    return await applyRemote();
  }catch(error){if(manual)toast('Не удалось загрузить облачные данные. Текущая база сохранена.','error');return false;}
  finally{syncPullBusy=false;if(!conflictOpen)resumePush();}
}
function updateNetwork(mode){const dot=$('#syncDot'),label=$('#syncLabel');dot.className='sync-dot';if(mode==='syncing'){dot.classList.add('warn');label.textContent='Синхронизация…';return}if(mode==='error'){dot.classList.add('warn');label.textContent='Ошибка синхронизации';return}if(navigator.onLine){dot.classList.add('online');label.textContent=state.settings.supabaseUrl?(state.meta.dirty?'Есть несинхр. изменения':'Синхронизировано'):'Онлайн · локально';}else{dot.classList.add('warn');label.textContent='Офлайн · данные сохранены';}}
window.addEventListener('online',()=>{updateNetwork();if(state.meta.dirty)syncPush().catch(()=>{});checkExpiryNotifications()});window.addEventListener('offline',()=>updateNetwork());

async function enableNotifications(){if(!('Notification'in window)){toast('Системные уведомления не поддерживаются','error');return}const p=await Notification.requestPermission();if(!await commitStateChange(()=>{state.settings.notifications=p==='granted';},'Не удалось сохранить настройку уведомлений.',false))return;if(p==='granted'){toast('Уведомления включены');try{const reg=await navigator.serviceWorker.ready;if('periodicSync'in reg)await reg.periodicSync.register('expiry-check',{minInterval:12*60*60*1000});}catch(e){}}else toast('Разрешение на уведомления не выдано','error');render();}
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;$('#installBtn').hidden=false;});$('#installBtn').onclick=triggerInstall;
async function triggerInstall(){if(deferredInstallPrompt){deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;$('#installBtn').hidden=true;}else toast('Если кнопка установки не появилась, используйте меню браузера → «Установить приложение»');}

if('serviceWorker'in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.warn));}
setInterval(checkExpiryNotifications,60*60*1000);
load();
