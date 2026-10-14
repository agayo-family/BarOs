import {
  scaleRecipe, aggregateIngredients, totalCost, isoWeekKey,
  consumeStock, reconcileConfirmedRequisition, expiryDate,
  expiryStatus, daysUntil, batchVelocity, round, inventoryItemKey
} from './logic.mjs';
import {parseRecipeText, parseIngredientsText, classifyRecipe, normalizeRecipe, recipeFingerprint, scaleProcess, ingredientStrengthInfo, recipeAlcoholStrength, ALCOHOL_CATEGORIES} from './recipes.mjs';
import {readRecipeFile} from './imports.mjs';

const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const uid = () => {
  if(crypto.randomUUID)return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};
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
  recipes:[],
  requisitions:[],
  stock:[],
  plans:[],
  batches:[],
  stopList:[],
  stats:[],
  readNotices:[],
  settings:{notifications:false}
});
let state = freshState();
let route = 'calculator';
let calcMode = 'request';
let ui = {recipeId:'',target:10,baseYield:null};
let deferredInstallPrompt = null;
let stateMutationBusy = false;
let session = {authenticated:false,role:null,csrfToken:null,initialized:true};
let stateReady = false;
let serverRevision = 0;
let remotePending = false;
let formDirty = false;
let formVersion = 0;
let refreshBusy = false;
let revisionCheckBusy = false;
let uncertainSave = null;
let networkIssue = false;
let authGeneration = 0;
let logoutPending = false;
let logoutBusy = false;
try{logoutPending=localStorage.getItem('tincture-lab-logout-pending')==='1';}catch(error){}

const pages = {
  calculator:['Калькулятор','Заявка и постановка настоек','⌁'],
  request:['Заявка','Закупка по неделям и подтверждение склада','▤'],
  plans:['План','Стоп-лист и временные планы на производство','◎'],
  recipes:['Технологические карты','Состав, приготовление и расчёт','◇'],
  warehouse:['Остатки','Ингредиенты на складе','▦'],
  batches:['Партии и сроки','Контроль срока годности готовых продуктов','◷'],
  stats:['Статистика','Производство, скорость расхода и история технологий','↗'],
  notifications:['Уведомления','Что скоро испортится и что требует внимания','◉'],
  settings:['Настройки','Общая база, доступ и установка','⚙']
};

function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open('tincture-lab-db',1);
    // Read the previous installation only. Never create or modify a local base.
    req.onupgradeneeded=()=>req.transaction.abort();
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
}
async function dbGet(key){const db=await openDB();try{return await new Promise((res,rej)=>{const r=db.transaction('kv','readonly').objectStore('kv').get(key);r.onsuccess=()=>res(r.result?.value);r.onerror=()=>rej(r.error)});}finally{db.close();}}
function normalizeState(saved){
  const defaults=freshState();
  if(!saved || typeof saved!=='object' || !Array.isArray(saved.recipes))throw Error('Неверная структура рабочей базы');
  for(const key of ['requisitions','stock','plans','batches','stopList','stats','readNotices'])if(saved[key]!=null&&!Array.isArray(saved[key]))throw Error(`Неверная структура: ${key}`);
  return {...defaults,...saved,recipes:saved.recipes.map(normalizeRecipe),settings:{...defaults.settings,...saved.settings},meta:{...defaults.meta,...saved.meta}};
}
async function load(){
  if(logoutPending){await completeLogout();return;}
  try{
    const current=await api('/api/session');session=current;
    if(!session.authenticated){renderAuth();return;}
    await loadSharedState();
  }catch(e){
    if(e.status===401)return;
    showConnectionGate('Не удалось связаться с сервером. Проверьте интернет и повторите открытие.');
  }
}
async function persist(markDirty=true){
  const candidate=sharedStateCopy(state);
  candidate.meta={...candidate.meta,lastModified:nowISO(),lastSynced:nowISO(),dirty:false};
  const pending={state:candidate,revision:serverRevision,mutationId:uid()};
  pending.body=JSON.stringify({state:pending.state,revision:pending.revision,mutationId:pending.mutationId});
  try{
    const result=await sendState(pending);
    serverRevision=result.revision;state=normalizeState(candidate);remotePending=false;formDirty=false;
    updateNetwork();updateSharedBanner();
  }catch(error){
    if(error.status===409){remotePending=true;updateSharedBanner();}
    if(error.uncertain&&session.authenticated){uncertainSave=pending;updateSharedBanner();}
    throw error;
  }
}
async function commitStateChange(mutate,errorMessage='Не удалось сохранить изменение. Данные не изменены; повторите попытку.',markDirty=true){
  if(!session.authenticated||!stateReady){toast('Сначала войдите и откройте общую базу.','error');return false;}
  if(uncertainSave){toast('Сервер ещё проверяет предыдущее сохранение. Нажмите «Проверить сохранение» вверху страницы.','error');return false;}
  if(remotePending||refreshBusy){toast('Общая база изменилась. Сохраните текст формы, закройте её и обновите данные.','error');return false;}
  if(stateMutationBusy){toast('Дождитесь завершения текущего сохранения.','error');return false;}
  stateMutationBusy=true;
  const generation=authGeneration;
  const previous=structuredClone(state),buttons=$$('button').map(button=>[button,button.disabled]);
  buttons.forEach(([button])=>button.disabled=true);
  updateNetwork('syncing');
  try{mutate();await persist(markDirty);return true;}
  catch(error){
    if(generation===authGeneration)state=previous;
    if(error.status!==401)toast(error.status===409?'На сервере уже есть новые изменения. Форма сохранена на экране: скопируйте её текст, закройте и обновите общую базу.':error.uncertain?'Ответ о сохранении не получен. Форма осталась открыта; проверьте результат вверху страницы перед повторной записью.':error.status===413?'База превышает 100 МБ. Уменьшите размер фотографий и повторите сохранение.':errorMessage,'error');
    updateNetwork();return false;
  }
  finally{stateMutationBusy=false;buttons.forEach(([button,disabled])=>button.disabled=disabled);updateNetwork();updateSharedBanner();}
}

function sharedStateCopy(value){
  const copy=structuredClone(value);
  copy.settings={...(copy.settings||{})};
  delete copy.settings.supabaseUrl;delete copy.settings.supabaseKey;delete copy.settings.workspaceId;
  return copy;
}
async function api(path,options={}){
  const generation=authGeneration;
  const headers={'Accept':'application/json',...(options.headers||{})};
  if(options.body)headers['Content-Type']='application/json';
  if(options.method&&options.method!=='GET'&&session.csrfToken)headers['X-CSRF-Token']=session.csrfToken;
  let response;
  try{response=await fetch(path,{...options,headers,credentials:'same-origin',cache:'no-store'});}
  catch(cause){networkIssue=true;updateNetwork();const error=Error('Нет связи с сервером');error.network=true;throw error;}
  if(generation!==authGeneration){const error=Error('Сессия изменена');error.status=401;throw error;}
  let data={};try{data=await response.json();}catch(error){if(response.ok){const failure=Error('Не удалось прочитать ответ сервера');failure.network=true;throw failure;}}
  if(generation!==authGeneration){const error=Error('Сессия изменена');error.status=401;throw error;}
  networkIssue=false;
  if(!response.ok){
    const messages={invalid_password:'Пароль должен содержать минимум 12 символов и не быть слишком длинным.',same_password:'Пароли владельца и сотрудников должны различаться.',setup_token:'Неверный код первоначальной настройки.',already_initialized:'Доступ уже настроен. Обновите страницу и войдите по паролю.',invalid_login:'Проверьте пароль и выбранный доступ.',invalid_credentials:'Неверный пароль.',unauthorized:'Войдите по паролю, чтобы продолжить.',owner_required:'Это действие доступно владельцу.',csrf:'Обновите страницу и войдите снова.',origin:'Откройте приложение по его основному адресу и повторите действие.',rate_limited:'Слишком много попыток. Повторите через 15 минут.',body_too_large:'База больше 100 МБ. Уменьшите размер фотографий.',invalid_state:'Неверная структура рабочей базы.',revision_conflict:'Общая база изменилась. Обновите её перед сохранением.',server_error:'Сервер временно недоступен. Повторите позже.'};
    const error=Error(messages[data.code]||'Сервер не выполнил запрос. Повторите действие.');error.status=response.status;error.code=data.code;
    if(path==='/api/password'&&data.code==='invalid_credentials')error.message='Текущий пароль владельца указан неверно.';
    if(response.status===401&&!['/api/login','/api/setup'].includes(path)&&!(path==='/api/password'&&data.code==='invalid_credentials')){
      clearPrivateState();session={authenticated:false,role:null,csrfToken:null,initialized:true};
      if(logoutPending)showLogoutGate('Подтверждаем выход из общей базы…');else renderAuth('Сессия закончилась. Войдите снова.');
    }
    throw error;
  }
  return data;
}
async function sendState(pending){
  for(let attempt=0;attempt<2;attempt++){
    try{return await api('/api/state',{method:'PUT',body:pending.body});}
    catch(error){
      const ambiguous=error.network||error.status>=500;
      if(ambiguous&&attempt===0)continue;
      if(ambiguous)error.uncertain=true;
      throw error;
    }
  }
}
function clearPrivateState(){
  authGeneration++;state=freshState();stateReady=false;serverRevision=0;remotePending=false;uncertainSave=null;formDirty=false;refreshBusy=false;
  ui={recipeId:'',target:10,baseYield:null};route='calculator';calcMode='request';
  modalAfterClose=null;modalReturnFocus=null;
  $('#modalBackdrop').hidden=true;$('#modal').innerHTML='';$('#content').innerHTML='';$('#nav').innerHTML='';
  $('#notificationBadge').hidden=true;$('#sharedBanner').hidden=true;$('#appShell').hidden=true;
  $('#toasts').innerHTML='';
}
function showConnectionGate(message){
  $('#appShell').hidden=true;$('#authPanel').hidden=false;
  $('#authPanel').innerHTML=`<section class="card auth-card"><div class="brand-mark">TL</div><h1>Tincture Lab</h1><p class="notice warn" role="alert">${esc(message)}</p><button class="primary full" id="retryConnection">Повторить</button></section>`;
  $('#retryConnection').onclick=load;
}
function renderAuth(message=''){
  $('#appShell').hidden=true;$('#authPanel').hidden=false;
  const setup=!session.initialized;
  $('#authPanel').innerHTML=`<section class="card auth-card"><div class="brand-mark">TL</div><h1>Tincture Lab</h1><p class="muted">${setup?'Настройте доступ к общей базе цеха.':'Войдите в общую базу цеха.'}</p><form id="authForm" class="grid" autocomplete="on">${setup?`<div class="field full"><label for="setupToken">Код первоначальной настройки</label><input id="setupToken" type="password" autocomplete="off" required></div><div class="field full"><label for="ownerPassword">Ваш пароль владельца</label><input id="ownerPassword" type="password" autocomplete="new-password" minlength="12" required><span class="tiny muted">Минимум 12 символов. Владелец переносит базу и меняет пароли.</span></div><div class="field full"><label for="staffPassword">Пароль сотрудников</label><input id="staffPassword" type="password" autocomplete="new-password" minlength="12" required><span class="tiny muted">Минимум 12 символов, отличается от пароля владельца. Сотрудники работают с общей базой.</span></div>`:`<div class="field full"><label for="loginRole">Доступ</label><select id="loginRole"><option value="staff">Сотрудник</option><option value="owner">Владелец</option></select></div><div class="field full"><label for="loginPassword">Пароль</label><input id="loginPassword" type="password" autocomplete="current-password" required></div>`}<p id="authError" class="notice warn" role="alert" ${message?'':'hidden'}>${esc(message)}</p><button class="primary full" id="authSubmit" type="submit">${setup?'Настроить доступ':'Войти'}</button></form><p class="tiny muted auth-foot">Рабочие данные хранятся на сервере. Для входа и сохранения нужен интернет.</p></section>`;
  $('#authForm').onsubmit=async event=>{
    event.preventDefault();const button=$('#authSubmit');button.disabled=true;$('#authError').hidden=true;
    try{
      const values=setup?{token:$('#setupToken').value,ownerPassword:$('#ownerPassword').value,staffPassword:$('#staffPassword').value}:{password:$('#loginPassword').value,role:$('#loginRole').value};
      const authenticated=await api(setup?'/api/setup':'/api/login',{method:'POST',body:JSON.stringify(values)});authGeneration++;session=authenticated;
      $('#authPanel').innerHTML='<section class="card auth-card"><h1>Tincture Lab</h1><p>Открываем общую базу…</p></section>';
      await loadSharedState();
    }catch(error){
      const message=error.status===401?'Неверный пароль или выбранный доступ.':error.network?'Нет связи с сервером. Проверьте интернет.':error.message;
      if($('#authError')){$('#authError').textContent=message;$('#authError').hidden=false;button.disabled=false;}
      else if(error.status!==401)showConnectionGate('Вход выполнен, но общая база пока недоступна. Повторите открытие.');
    }
  };
}
function showAuthenticatedShell(){
  $('#authPanel').hidden=true;$('#authPanel').innerHTML='';$('#appShell').hidden=false;
  $('#logoutBtn').hidden=false;$('#sessionRole').textContent=session.role==='owner'?'Владелец':'Сотрудник';
}
async function loadSharedState(){
  const result=await api('/api/state');if(!session.authenticated)return;
  serverRevision=result.revision;showAuthenticatedShell();
  if(result.state===null){state=freshState();stateReady=false;renderNav();await renderMigration();updateNetwork();return;}
  state=normalizeState(result.state);stateReady=true;remotePending=false;formDirty=false;
  renderNav();setRoute('calculator');updateNetwork();updateSharedBanner();checkExpiryNotifications();
}
async function renderMigration(){
  $('#pageTitle').textContent='Общая база';$('#pageSubtitle').textContent='Первый перенос данных на сервер';
  $('#notificationBtn').hidden=true;
  if(session.role!=='owner'){$('#content').innerHTML='<section class="card"><h2>База ещё не перенесена</h2><p>Владелец должен войти и перенести данные с прежнего устройства или загрузить резервную копию.</p><button class="soft" id="checkMigration">Проверить готовность</button></section>';$('#checkMigration').onclick=loadSharedState;return;}
  const generation=authGeneration;let legacy=null,legacyMessage='На этом устройстве прежняя база не найдена.';
  try{const saved=await dbGet('state');if(saved){legacy=normalizeState(saved);legacyMessage=`На этом устройстве: ${legacy.recipes.length} ТК, ${legacy.requisitions.length} заявок, ${legacy.stock.length} позиций склада, ${legacy.batches.length} партий, ${legacy.stats.length} записей истории.`;}}
  catch(error){legacyMessage='Прежняя база на этом устройстве недоступна. Можно загрузить её полную резервную копию JSON.';}
  if(generation!==authGeneration||!session.authenticated)return;
  $('#content').innerHTML=`<section class="card migration-card"><h2>Перенести прежние данные</h2><p>После переноса состав, фотографии, архив, заявки, склад, планы, партии и история будут общими на всех устройствах.</p><div class="notice">${esc(legacyMessage)}</div><div class="actions" style="margin-top:18px">${legacy?'<button class="primary" id="migrateLocal">Перенести всю базу с этого устройства</button>':''}<label class="soft file-action">Загрузить полную копию JSON<input id="migrateJson" type="file" accept="application/json,.json" hidden></label></div><p id="migrationError" class="notice warn" role="alert" hidden></p><div class="divider"></div><p class="tiny muted">Если рабочих данных ещё нет, можно создать пустую общую базу. Прежняя локальная копия останется без изменений.</p><button class="soft" id="startEmpty">Создать пустую общую базу</button></section>`;
  if(legacy)$('#migrateLocal').onclick=()=>initializeShared(legacy);
  $('#startEmpty').onclick=()=>initializeShared(freshState());
  $('#migrateJson').onchange=async event=>{
    const file=event.target.files[0];if(!file)return;
    try{if(file.size>100*1024*1024)throw Error('Полная копия больше 100 МБ. Уменьшите размер фотографий.');const imported=JSON.parse(await file.text());if(!Array.isArray(imported.recipes)||!imported.settings)throw Error('Выберите полную резервную копию базы, а не отдельный список ТК.');await initializeShared(normalizeState(imported));}
    catch(error){$('#migrationError').textContent=error.message;$('#migrationError').hidden=false;}
  };
}
async function initializeShared(source){
  if(stateMutationBusy||uncertainSave||session.role!=='owner')return;
  stateMutationBusy=true;const buttons=$$('button').map(button=>[button,button.disabled]);buttons.forEach(([button])=>button.disabled=true);
  state=normalizeState(source);updateNetwork('syncing');
  try{await persist();stateReady=true;$('#notificationBtn').hidden=false;formDirty=false;setRoute('calculator');toast('Общая база сохранена на сервере.');}
  catch(error){
    state=freshState();stateReady=false;
    if(error.status===409){await loadSharedState();toast('Общая база уже создана. Загружена существующая версия.','error');}
    else if(error.status!==401){$('#migrationError').textContent=error.uncertain?'Ответ о переносе не получен. Нажмите «Проверить сохранение» вверху страницы.':error.status===413?'База больше 100 МБ. Уменьшите размер фотографий.':'Не удалось перенести данные. Прежняя база сохранена; повторите попытку.';$('#migrationError').hidden=false;}
  }finally{stateMutationBusy=false;buttons.forEach(([button,disabled])=>button.disabled=disabled);updateNetwork();updateSharedBanner();}
}
function isFormOpen(){return !$('#modalBackdrop').hidden||formDirty;}
function updateSharedBanner(){
  const banner=$('#sharedBanner');if(!banner)return;
  banner.hidden=!session.authenticated||(!remotePending&&!uncertainSave);
  if(banner.hidden)return;
  banner.innerHTML=`<div class="notice warn shared-notice"><span>${uncertainSave?'Связь прервалась во время сохранения. Сначала проверьте его результат.':'На другом устройстве появились новые изменения. Обновите общую базу перед сохранением.'}</span><button class="soft" id="refreshShared">${uncertainSave?'Проверить сохранение':'Обновить общую базу'}</button></div>`;
  $('#refreshShared').onclick=()=>uncertainSave?resolveUncertainSave():refreshSharedState(true);
}
async function resolveUncertainSave(){
  if(!uncertainSave||stateMutationBusy||refreshBusy)return;
  refreshBusy=true;updateNetwork('syncing');const pending=uncertainSave;
  try{
    const result=await sendState(pending);if(!session.authenticated)return;
    serverRevision=result.revision;uncertainSave=null;remotePending=true;
    toast('Сохранение подтверждено сервером. Закройте форму и обновите общую базу.');
  }catch(error){if(error.status===409){uncertainSave=null;remotePending=true;toast('Запись не была применена: на сервере уже есть новые данные. Скопируйте текст формы перед обновлением.','error');}else if(error.status!==401)toast('Результат пока недоступен. Проверьте интернет и нажмите ещё раз.','error');}
  finally{refreshBusy=false;updateNetwork();updateSharedBanner();}
  if(!uncertainSave&&!isFormOpen()&&session.authenticated){if(!stateReady)await loadSharedState();else await refreshSharedState();}
}
async function refreshSharedState(manual=false,navigation=false){
  if(!session.authenticated||stateMutationBusy||refreshBusy||uncertainSave)return false;
  if(isFormOpen()&&!navigation){if(manual)toast('Скопируйте несохранённый текст и закройте форму или перейдите в другой раздел.','error');return false;}
  if(!$('#modalBackdrop').hidden){if(manual)toast('Сначала закройте открытую форму.','error');return false;}
  refreshBusy=true;const inputVersion=formVersion;
  try{
    const result=await api('/api/state');if(!session.authenticated)return false;
    if(!$('#modalBackdrop').hidden||formVersion!==inputVersion){remotePending=true;updateSharedBanner();return false;}
    if(result.state===null){state=freshState();stateReady=false;renderNav();await renderMigration();return false;}
    state=normalizeState(result.state);serverRevision=result.revision;remotePending=false;formDirty=false;stateReady=true;
    render();updateNetwork();updateSharedBanner();if(manual)toast('Общая база обновлена');return true;
  }catch(error){if(error.status!==401&&manual)toast('Не удалось обновить общую базу. Форма и текущие данные остались на экране.','error');updateNetwork();return false;}
  finally{refreshBusy=false;updateNetwork();}
}
async function checkSharedRevision(){
  if(document.hidden||revisionCheckBusy||!session.authenticated||!stateReady||stateMutationBusy||refreshBusy||uncertainSave||!navigator.onLine)return;
  revisionCheckBusy=true;
  try{
    const result=await api('/api/revision');
    // A hidden tab must not start a second database read after a delayed reply.
    if(document.hidden||stateMutationBusy||refreshBusy||uncertainSave)return;
    if(result.revision!==serverRevision){remotePending=true;updateSharedBanner();if(!isFormOpen())await refreshSharedState();}updateNetwork();
  }
  catch(error){updateNetwork();}
  finally{revisionCheckBusy=false;}
}
async function logout(){
  if(stateMutationBusy||refreshBusy){toast('Дождитесь завершения текущего запроса.','error');return;}
  rememberLogoutPending(true);clearPrivateState();session={authenticated:false,role:null,csrfToken:null,initialized:true};
  await completeLogout();
}
function rememberLogoutPending(value){
  logoutPending=value;
  try{if(value)localStorage.setItem('tincture-lab-logout-pending','1');else localStorage.removeItem('tincture-lab-logout-pending');}catch(error){}
}
function showLogoutGate(message,loading=false){
  $('#appShell').hidden=true;$('#authPanel').hidden=false;
  $('#authPanel').innerHTML=`<section class="card auth-card"><div class="brand-mark">TL</div><h1>Выход из общей базы</h1><p class="notice ${loading?'':'warn'}" role="status">${esc(message)}</p><p class="tiny muted">Рабочие данные скрыты. Для нового входа нужно завершить выход на сервере.</p><button class="primary full" id="retryLogout" ${loading?'disabled':''}>${loading?'Завершаем выход…':'Повторить выход'}</button></section>`;
  $('#retryLogout').onclick=completeLogout;
}
async function completeLogout(){
  if(logoutBusy)return;logoutBusy=true;showLogoutGate('Подтверждаем выход из общей базы…',true);
  try{
    const current=await api('/api/session');session=current;
    if(current.authenticated)await api('/api/logout',{method:'POST',body:'{}'});
    rememberLogoutPending(false);session={...current,authenticated:false,role:null,csrfToken:null};renderAuth();
  }catch(error){
    if(error.status===401){rememberLogoutPending(false);session={authenticated:false,role:null,csrfToken:null,initialized:true};renderAuth();}
    else{session={authenticated:false,role:null,csrfToken:null,initialized:session.initialized};showLogoutGate('Сервер пока недоступен. Проверьте интернет и повторите выход.');}
  }finally{logoutBusy=false;}
}
document.addEventListener('input',event=>{if(session.authenticated&&stateReady&&event.target.closest?.('#content,#modal')){formDirty=true;formVersion++;}});
document.addEventListener('change',event=>{if(session.authenticated&&stateReady&&event.target.closest?.('#content,#modal')){formDirty=true;formVersion++;}});
$('#logoutBtn').onclick=logout;

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
window.addEventListener('unhandledrejection',()=>{if(session.authenticated)toast('Не удалось завершить операцию. Проверьте связь с сервером.','error');});

function renderNav(){
  if(!session.authenticated||!stateReady){$('#nav').innerHTML='';return;}
  $('#nav').innerHTML=Object.entries(pages).filter(([k])=>k!=='notifications').map(([k,v])=>`<button class="nav-btn ${route===k?'active':''}" data-route="${k}"><span class="nav-icon">${v[2]}</span><span>${v[0]}</span></button>`).join('');
  $$('[data-route]').forEach(b=>b.onclick=()=>setRoute(b.dataset.route));
}
function setRoute(next){
  if(!session.authenticated||!stateReady)return;
  const navigate=()=>{formDirty=false;route=next;const p=pages[next];$('#pageTitle').textContent=p[0];$('#pageSubtitle').textContent=p[1];renderNav();render();$('#sidebar').classList.remove('open');window.scrollTo({top:0,behavior:'smooth'});};
  if(uncertainSave){toast('Сначала проверьте результат предыдущего сохранения вверху страницы.','error');return;}
  if(remotePending){if(!$('#modalBackdrop').hidden){toast('Сначала закройте открытую форму. Её текст можно скопировать перед обновлением.','error');return;}refreshSharedState(false,true).then(saved=>{if(saved)navigate();});return;}
  navigate();
}
$('#menuBtn').onclick=()=>$('#sidebar').classList.toggle('open');
$('#notificationBtn').onclick=()=>setRoute('notifications');

function render(){
  if(!session.authenticated||!stateReady)return;
  $('#notificationBtn').hidden=false;
  const fn={calculator:renderCalculator,request:renderRequest,plans:renderPlans,recipes:renderRecipes,warehouse:renderWarehouse,batches:renderBatches,stats:renderStats,notifications:renderNotifications,settings:renderSettings}[route];
  fn(); updateNoticeBadge();
}

function activeRecipes(){return state.recipes.filter(r=>!r.archived);}
function ensureCurrentRequisition(create=true){
  const wk=isoWeekKey(new Date());
  let req=state.requisitions.find(r=>r.week===wk);
  if(!req){req={id:create?uid():null,week:wk,status:'draft',items:[],appliedItems:[],createdAt:nowISO(),updatedAt:nowISO()};if(create)state.requisitions.push(req);}
  return req;
}
function selectedRecipe(){const list=activeRecipes();return state.recipes.find(r=>r.id===ui.recipeId&&!r.archived)||list[0]||null;}
function calculationRecipe(){const r=selectedRecipe();return r?{...r,yield:Number(r.yield)>0?r.yield:ui.baseYield}:null;}
function canCalculate(){const r=calculationRecipe();return Number(r?.yield)>0&&Number.isFinite(Number(r?.yield))&&Number(ui.target)>0&&Number.isFinite(Number(ui.target))&&(r?.ingredients||[]).length>0&&(r?.ingredients||[]).every(i=>i.name&&Number(i.amount)>0&&Number.isFinite(Number(i.amount))&&i.unit);}
function calcRows(){const r=calculationRecipe();return r&&canCalculate()?scaleRecipe(r,ui.target):[];}
function recipeOptions(selected){return activeRecipes().map(r=>`<option value="${esc(r.id)}" ${r.id===selected?'selected':''}>${esc(r.name)}</option>`).join('');}

function renderCalculator(){
  const recipes=activeRecipes(); if(!ui.recipeId && recipes[0])ui.recipeId=recipes[0].id;
  const r=selectedRecipe(); const rows=calcRows(); const cost=totalCost(rows);
  const req=ensureCurrentRequisition(false);
  $('#content').innerHTML=`
    <div class="hero">
      <div><span class="pill olive">ОБЩАЯ БАЗА ЦЕХА</span><h2>Одна технологичка — два разных расчёта.</h2><p>Закупочная заявка агрегирует ингредиенты на неделю. Постановка рассчитывает конкретную варку, может сохраниться в план и после приготовления запускает срок годности.</p></div>
      <div class="hero-stat"><span>Текущая неделя</span><strong>${esc(req.week)}</strong><span>${req.status==='confirmed'?'заявка подтверждена':'заявка ещё черновик'}</span></div>
    </div>
    <div style="height:18px"></div>
    <div class="segmented"><button id="modeRequest" class="${calcMode==='request'?'active':''}">В заявку</button><button id="modeProduction" class="${calcMode==='production'?'active':''}">Поставить настойку</button></div>
    <div style="height:14px"></div>
    <div class="grid two">
      <section class="card">
        <h2>${calcMode==='request'?'Расчёт закупки':'Расчёт постановки'}</h2>
        ${recipes.length?`<div class="form-grid">
          <div class="field full"><label for="calcRecipe">Технология</label><select id="calcRecipe">${recipeOptions(r?.id)}</select></div>
          <div class="field"><label for="calcTarget">Нужно готового продукта</label><input id="calcTarget" type="number" inputmode="decimal" min="0.001" step="any" value="${esc(ui.target)}"></div>
          <div class="field"><label>Единица выхода</label><input value="л" disabled></div>
          ${!Number(r?.yield)?`<div class="field full"><label for="calcBase">Исходный объём для этого расчёта, л</label><input id="calcBase" type="number" inputmode="decimal" min="0.001" step="any" value="${esc(ui.baseYield??'')}" placeholder="Сколько готового продукта даёт указанный состав"><span class="tiny muted">Не изменяет выход в технологической карте.</span></div>`:''}
        </div>
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
  $('#calcRecipe').onchange=e=>{ui.recipeId=e.target.value;ui.baseYield=null;renderCalculator()};
  const refreshCalculation=()=>{
    const updated=calcRows();$('.calc-result').innerHTML=updated.map(x=>`<div class="calc-row"><span class="name">${esc(x.name)}</span><span class="qty">${fmtNum(x.amount,4)} ${esc(x.unit)}</span><span class="cost">${x.cost?fmtMoney(x.amount*x.cost):'цена не задана'}</span></div>`).join('');
    $('#calcCost').textContent=fmtMoney(totalCost(updated));$('#calcWarning').hidden=canCalculate();
    for(const id of ['addRequest','savePlan','finishBatch'])if($('#'+id))$('#'+id).disabled=!canCalculate();
    if(calcMode==='production')$('.soft-card').innerHTML=`<h2>Что произойдёт после приготовления</h2>${renderProductionExplanation(r,updated)}`;
  };
  $('#calcTarget').oninput=e=>{ui.target=Number(e.target.value);refreshCalculation();};
  if($('#calcBase'))$('#calcBase').oninput=e=>{ui.baseYield=Number(e.target.value);refreshCalculation();};
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
async function savePlan(){if(!canCalculate()){toast('Заполните состав и исходный объём для расчёта','error');return;}const r=calculationRecipe(),plan={id:uid(),recipeId:r.id,name:r.name,targetYield:ui.target,baseYield:r.yield,ingredients:calcRows(),createdAt:nowISO(),status:'planned'};if(await commitStateChange(()=>state.plans.unshift(plan)))toast('План постановки сохранён');}
function openFinishBatch(recipe,ingredients){
  const target=Number(ui.target);
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
  $$('[data-openplan]').forEach(b=>b.onclick=()=>{const p=state.plans.find(x=>x.id===b.dataset.openplan),recipe=state.recipes.find(r=>r.id===p?.recipeId);if(!p||!recipe||recipe.archived){toast(recipe?.archived?'ТК этого плана в архиве. Верните её в актуальные карты перед открытием плана.':'ТК этого плана не найдена. План сохранён; выберите или восстановите нужную карту.','error');return;}ui.recipeId=recipe.id;ui.target=p.targetYield;ui.baseYield=p.baseYield??null;calcMode='production';setRoute('calculator');});
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
function recipeStrengthBadge(recipe){
  const strength=recipeAlcoholStrength(recipe),value=strength.status==='ready'?`≈${fmtNum(strength.value,1)}%`:'—';
  return `<span class="recipe-strength ${strength.status}" role="img" aria-label="${esc(strength.status==='ready'?`Расчётная крепость ${fmtNum(strength.value,1)} процентов`:strength.message)}" title="${esc(strength.message)}"><strong>${value}</strong><span>крепость</span></span>`;
}
function recipeCardView(recipe){
  const base=Number(recipe?.yield),ingredients=recipe?.ingredients||[];
  if(!Number.isFinite(base)||base<=0||!ingredients.length||ingredients.some(i=>!i.name||!i.unit||!Number.isFinite(Number(i.amount))||Number(i.amount)<=0))return null;
  return {...recipe,yield:1,ingredients:ingredients.map(i=>({...i,amount:Number(i.amount)/base})),process:scaleProcess(recipe.process||'',1/base)};
}
function recipeList(list,arch){
  if(!list.length)return '<div class="empty">Пусто</div>';
  return `<div class="recipe-grid">${[...list].sort((a,b)=>String(a.name).localeCompare(String(b.name),'ru')).map(r=>{
    const card=recipeCardView(r),incomplete=!card,view=card||r;
    const photos=(r.photos||[]).map(p=>({src:recipePhotoSource(p),name:typeof p==='string'?'Фото приготовления':p?.name||'Фото приготовления'})).filter(p=>p.src);
    return `<article class="card recipe-card ${incomplete?'recipe-incomplete':''}"><details><summary><span class="recipe-card-heading"><span class="recipe-card-heading-text"><span class="recipe-card-title">${esc(r.name||'Без названия')}</span><span class="recipe-card-meta">${incomplete?'<span class="pill burg">Черновик</span>':''}${r.category==='Требует уточнения'?'<span class="pill burg">Выберите основной алкоголь</span>':''}<span>${card?'ТК на 1 л':Number(r.yield)>0?'Проверьте состав':'Укажите выход'}</span><span class="recipe-disclosure">Раскрыть карту</span></span></span>${recipeStrengthBadge(r)}</span><span class="recipe-composition-preview">${(view.ingredients||[]).length?esc(view.ingredients.map(i=>`${i.name} — ${fmtNum(i.amount,4)} ${i.unit||''}`).join(' · ')):'Состав ещё не заполнен'}</span></summary>
      <div class="recipe-card-body"><h3>${card?'Состав на 1 л':'Исходный состав'}</h3>${recipeCompositionHTML(view.ingredients)}${card?`<p class="tiny muted">Исходный выход: ${fmtNum(r.yield,4)} л. Введённый состав и выход сохранены в редакторе.</p>`:''}<h3>Процесс приготовления${card?' на 1 л':''}</h3><div class="recipe-process">${esc(view.process||'Процесс ещё не добавлен.')}</div>${photos.length?`<div class="recipe-photos">${photos.map(p=>`<img src="${esc(p.src)}" alt="${esc(p.name)}" loading="lazy">`).join('')}</div>`:''}
      ${r.unparsedText?`<div class="notice warn recipe-preserved"><b>${card?'Дополнительный текст не пересчитан — проверьте':'Проверьте и дополните'}</b><div class="recipe-process">${esc(r.unparsedText)}</div></div>`:''}
      <p class="tiny muted recipe-strength-note">${esc(recipeAlcoholStrength(r).message)}</p><p class="tiny muted">${r.shelfLifeDays!=null?`Срок годности: ${fmtNum(r.shelfLifeDays,0)} дн. · `:''}${r.categoryMode==='manual'?'Категория выбрана вручную':r.categoryMode==='confirmed'?'Основной алкоголь подтверждён':'Автоматическая категория'}</p>${r.rawText?`<details class="recipe-source"><summary>Исходный текст</summary><div class="recipe-process">${esc(r.rawText)}</div></details>`:''}</div></details>
      <div class="actions recipe-card-actions"><button class="soft" data-editrecipe="${esc(r.id)}">Редактировать</button><button class="primary" data-recipe-calc="${esc(r.id)}">Рассчитать</button><button class="ghost" data-archive="${esc(r.id)}">${arch?'Вернуть':'В архив'}</button>${r.isDemo?`<button class="icon-btn" data-delete-recipe="${esc(r.id)}" aria-label="Удалить демо-карту" title="Удалить демо">×</button>`:''}</div></article>`;
  }).join('')}</div>`;
}
function recipeModal(id){
  const existing=state.recipes.find(x=>x.id===id);
  const r=normalizeRecipe(existing?structuredClone(existing):{id:null,name:'',yield:null,shelfLifeDays:30,ingredients:[],process:'',rawText:'',unparsedText:'',categoryMode:'auto',photos:[]});
  let photos=structuredClone(r.photos||[]), categoryMode=r.categoryMode||'auto', primaryAlcohol=r.primaryAlcohol||'', parseTimer=null, lastParsed={}, lastSourceParsed=r.rawText||'', photoBusy=false;
  const manuallyChanged=new Set();
  // Keep ingredient metadata through textarea parsing, including explicit 0%.
  const repeatedIngredientNames=new Set();
  const ingredientKeys=ingredients=>{
    const names=ingredients.map(item=>String(item.name||'').trim().toLocaleLowerCase('ru')),nameCounts=new Map();
    names.forEach(name=>nameCounts.set(name,(nameCounts.get(name)||0)+1));
    nameCounts.forEach((count,name)=>{if(count>1)repeatedIngredientNames.add(name);});
    const signatures=ingredients.map((item,index)=>{const multiplier={'л':1000,'мл':1,'сл':10,'дл':100}[item.unit],family=multiplier?'volume':item.unit;return JSON.stringify([names[index],family,...repeatedIngredientNames.has(names[index])?[Number(item.amount)*(multiplier||1)]:[]]);});
    const counts=new Map(),occurrences=new Map();signatures.forEach(signature=>counts.set(signature,(counts.get(signature)||0)+1));
    return signatures.map(signature=>{const occurrence=occurrences.get(signature)||0;occurrences.set(signature,occurrence+1);return `${signature}:${counts.get(signature)}:${occurrence}`;});
  };
  const originalKeys=ingredientKeys(r.ingredients),ingredientMetadata=new Map(r.ingredients.map((item,index)=>[originalKeys[index],item]));
  const strengthOverrides=new Map(r.ingredients.flatMap((item,index)=>Object.hasOwn(item,'abv')?[[originalKeys[index],item.abv]]:[]));
  modal(`<div class="section-head"><h2>${id?'Технологическая карта':'Добавить ТК'}</h2><button class="icon-btn" id="closeM" aria-label="Закрыть">×</button></div>
    <div class="field full"><label for="rSource">Вставить готовую ТК целиком</label><textarea id="rSource" class="recipe-source-input" placeholder="Клюквенная настойка\nВодка — 1 л\nКлюква 300 г\nСахар 100 г\nПриготовление: смешать и настоять 7 дней.">${esc(r.rawText||'')}</textarea><p class="tiny muted">Текст распознаётся автоматически. Исправленные вручную поля сохраняются. Исходный текст остаётся в карточке.</p></div>
    <div class="actions"><button class="soft" id="parseRecipeSource">Распознать текст</button><button class="ghost" id="replaceRecipeSource">Заменить поля из текста</button></div><p id="rParseStatus" class="tiny muted" role="status" aria-live="polite"></p>
    <div class="divider"></div><div class="form-grid">
      <div class="field full"><label for="rName">Название *</label><input id="rName" value="${esc(r.name)}" placeholder="Например, Облепиха / ваниль" autocomplete="off"></div>
      <div class="field"><label for="rYield">Выход, л — необязательно</label><input id="rYield" type="number" min=".001" step="any" inputmode="decimal" value="${esc(r.yield??'')}" placeholder="Можно оставить пустым"><span id="rYieldHint" class="tiny muted"></span></div>
      <div class="field"><label for="rShelf">Срок годности, дней</label><input id="rShelf" type="number" min="0" step="1" inputmode="numeric" value="${esc(r.shelfLifeDays??'')}"></div>
      <div class="field full"><label for="rLines">Состав — в любом привычном формате</label><textarea id="rLines" class="recipe-lines-input" placeholder="Водка 1 л\n300 г клюквы\nСахар — 100 г">${esc(r.ingredientsText||recipeIngredientText(r.ingredients))}</textarea><span class="tiny muted">Например: «Водка 1 л», «300 г клюквы» или «Водка | 1 | л | 500». Нераспознанные строки сохранятся для исправления.</span></div>
      <div class="field full recipe-strength-editor"><h3>Крепость настойки</h3><p class="tiny muted">Укажите крепость жидких ингредиентов. Процент в названии алкоголя распознаётся автоматически, вода и сок учитываются как 0%. Алкоголь указывайте в л или мл.</p><div id="rStrengthFields" class="recipe-strength-fields"></div><div id="rStrengthPreview" class="recipe-strength-preview" aria-live="polite"></div></div>
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
    const keys=ingredientKeys(parsed.ingredients),ingredients=parsed.ingredients.map((item,index)=>{const key=keys[index],row={...ingredientMetadata.get(key),...item};if(strengthOverrides.has(key)){const value=strengthOverrides.get(key);if(value==null||String(value).trim()==='')delete row.abv;else row.abv=Number(String(value).replace(',','.'));}return row;});
    return {...r,name:$('#rName').value.trim(),yield:$('#rYield').value===''?null:Number($('#rYield').value),shelfLifeDays:$('#rShelf').value===''?null:Number($('#rShelf').value),ingredients,ingredientsText:$('#rLines').value,process:$('#rProcess').value.trim(),rawText:$('#rSource').value,unparsedText:mergeRecipeNotes($('#rUnparsed').value,parsed.unparsedText),category:$('#rCat').value.trim()||'Без категории',categoryMode,primaryAlcohol,photos:structuredClone(photos)};
  };
  const renderStrengthPreview=draft=>{$('#rStrengthPreview').innerHTML=`${recipeStrengthBadge(draft)}<p class="tiny muted">${esc(recipeAlcoholStrength(draft).message)}</p>`;};
  const renderStrengthFields=draft=>{
    const keys=ingredientKeys(draft.ingredients),rows=draft.ingredients.map((item,index)=>({item,index,info:ingredientStrengthInfo(item)})).filter(row=>row.info.requiresStrength||Object.hasOwn(row.item,'abv')||['л','мл','сл','дл'].includes(row.item.unit));
    $('#rStrengthFields').innerHTML=rows.map(({item,index,info})=>`<div class="recipe-strength-field"><label for="rAbv${index}">${esc(item.name)}<span class="tiny muted">${fmtNum(item.amount,4)} ${esc(item.unit)}</span></label><div class="recipe-percent-input"><input id="rAbv${index}" type="number" min="0" max="100" step="any" inputmode="decimal" value="${esc(Object.hasOwn(item,'abv')?item.abv:info.abv??'')}" placeholder="Укажите %" aria-label="Крепость ${esc(item.name)}, %"><span>%</span></div></div>`).join('')||'<p class="tiny muted">Добавьте жидкие ингредиенты в состав.</p>';
    rows.forEach(({index})=>{$('#rAbv'+index).oninput=()=>{strengthOverrides.set(keys[index],$('#rAbv'+index).value);renderStrengthPreview(readDraft());};});
    renderStrengthPreview(draft);
  };
  const updateCategory=(force=false)=>{
    const classified=classifyRecipe(readDraft(),{force});categoryMode=classified.categoryMode;primaryAlcohol=classified.primaryAlcohol||'';
    renderStrengthFields(classified);
    const ready=!!recipeCardView(classified);
    $('#saveRecipe').textContent=ready?'Сохранить ТК':'Сохранить черновик';
    $('#rYieldHint').textContent=ready?'После сохранения карта покажет состав на 1 л. Укажите фактический выход всего введённого состава.':'Состав можно сохранить в черновик. Когда укажете выход, карта автоматически пересчитается на 1 л.';
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
  $('#rYield').addEventListener('input',()=>updateCategory());
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
    const invalidStrength=next.ingredients.findIndex(item=>ingredientStrengthInfo(item).invalid);
    if(invalidStrength>=0){toast('Крепость ингредиента должна быть от 0 до 100%.','error');$('#rAbv'+invalidStrength)?.focus();return;}
    next=normalizeRecipe(classifyRecipe({...next,id:existing?.id||uid(),archived:existing?.archived||false,updatedAt:nowISO(),isDemo:false}));
    const duplicate=findRecipeDuplicate(next,state.recipes.filter(x=>x.id!==next.id));
    if(duplicate){toast(`Такая ТК уже существует: «${duplicate.name}». Карта не продублирована.`,'error');return;}
    const sourceSignatures=[...(existing?.importSignatures||[])];
    if(next.rawText.trim()){const source=parseRecipeText(next.rawText);if(source.name)sourceSignatures.push(recipeFingerprint(normalizeRecipe(source)));}
    next.importSignatures=[...new Set([...sourceSignatures,recipeFingerprint(next)])];
    $('#rSaveError').hidden=true;
    const saved=await commitStateChange(()=>{const idx=state.recipes.findIndex(x=>x.id===next.id);if(idx>=0)state.recipes[idx]=next;else state.recipes.push(next);},'Не удалось сохранить карту. Данные остались в форме; повторите попытку.');
    if(saved){if(alive())leave();toast(next.category==='Требует уточнения'?'ТК сохранена. Подтвердите основной алкоголь в редакторе.':recipeCardView(next)?'ТК на 1 л сохранена':'Черновик сохранён. Выход и состав можно заполнить позже.');render();}
    else if(alive()){$('#rSaveError').hidden=false;$('#rSaveError').textContent='Карта не сохранена. Данные остались в форме. Проверьте свободное место и повторите сохранение.';}
  };
  renderPhotos();updateCategory();
}
function mergeRecipeNotes(...values){return [...new Set(values.flatMap(value=>String(value||'').split(/\r?\n/)).map(s=>s.trim()).filter(Boolean))].join('\n');}
function parseIngredientLines(text){return parseIngredientsText(text).ingredients;}
function recipeImportMetadata(recipe){return JSON.stringify({shelfLifeDays:recipe.shelfLifeDays??null,category:recipe.category||'',prices:(recipe.ingredients||[]).map(i=>[String(i.name).toLowerCase(),i.unit,Number(i.amount),Number(i.cost||0),i.abv??null]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),photos:(recipe.photos||[]).map(p=>[recipePhotoSource(p),typeof p==='string'?'':p?.name||'']).filter(p=>p[0])});}
function recipeIngredientStrengthText(recipe){return (recipe.ingredients||[]).filter(i=>ingredientStrengthInfo(i).requiresStrength||Object.hasOwn(i,'abv')).map(i=>{const info=ingredientStrengthInfo(i);return `${i.name}: ${info.invalid?'проверьте значение':info.abv===null?'не указана':`${fmtNum(info.abv,2)}%`}`;}).join('\n');}
function recipeImportDifferences(current,incoming){
  const changes=[],add=(label,a,b)=>{if(String(a??'')!==String(b??''))changes.push({label,current:String(a??'не указано'),incoming:String(b??'не указано')});};
  if(recipeFingerprint(current)!==recipeFingerprint(incoming)){add('Название',current.name,incoming.name);add('Выход, л',current.yield,incoming.yield);add('Процесс',current.process,incoming.process);add('Дополнительный текст',current.unparsedText,incoming.unparsedText);}
  add('Состав и цены',recipeIngredientText(current.ingredients),recipeIngredientText(incoming.ingredients));add('Крепость ингредиентов',recipeIngredientStrengthText(current),recipeIngredientStrengthText(incoming));add('Срок годности, дней',current.shelfLifeDays,incoming.shelfLifeDays);add('Категория',current.category,incoming.category);
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
  modal(`<div class="section-head"><h2>Рассчитать: ${esc(recipe.name)}</h2><button class="icon-btn" id="closeM" aria-label="Закрыть">×</button></div><p class="tiny muted">Расчёт временный. Состав, процесс и выход исходной карточки сохраняются.</p>
    <div class="form-grid"><div class="field"><label for="recipeCalcTarget">Нужный объём, л</label><input id="recipeCalcTarget" type="number" min=".001" step="any" inputmode="decimal" value="1"></div>${Number(recipe.yield)>0?`<div class="field"><label>Исходный выход всего состава</label><div class="recipe-base-value">${fmtNum(recipe.yield)} л</div></div>`:`<div class="field"><label for="recipeCalcBase">На какой объём рассчитан исходный состав, л</label><input id="recipeCalcBase" type="number" min=".001" step="any" inputmode="decimal" placeholder="Укажите для этого расчёта"></div>`}</div>
    <div class="divider"></div><div id="recipeCalcResult" aria-live="polite"></div><div class="actions"><button class="soft" id="closeM2">Закрыть</button></div>`);
  const calculate=()=>{
    const target=Number($('#recipeCalcTarget').value),base=Number(recipe.yield)>0?Number(recipe.yield):Number($('#recipeCalcBase').value);
    if(!recipe.ingredients?.length){$('#recipeCalcResult').innerHTML='<div class="notice warn">В карточке пока нет состава. Добавьте ингредиенты, чтобы рассчитать количество.</div>';return;}
    if(!(target>0)||!(base>0)||!Number.isFinite(target)||!Number.isFinite(base)){$('#recipeCalcResult').innerHTML='<div class="notice">Укажите нужный объём и исходный выход, чтобы получить расчёт.</div>';return;}
    const factor=target/base;const rows=recipe.ingredients.map(i=>({...i,amount:Number(i.amount)*factor}));
    if(rows.some(i=>!i.name||!i.unit||!Number.isFinite(i.amount)||i.amount<=0)){$('#recipeCalcResult').innerHTML='<div class="notice warn">Проверьте состав: каждому ингредиенту нужно положительное количество и единица измерения.</div>';return;}
    const scaled={...recipe,yield:target,ingredients:rows};
    $('#recipeCalcResult').innerHTML=`<div class="recipe-calculation-heading"><div><h3>Состав на ${fmtNum(target,4)} л</h3><p class="tiny muted">${esc(recipeAlcoholStrength(scaled).message)}</p></div>${recipeStrengthBadge(scaled)}</div>${recipeCompositionHTML(rows)}<h3>Процесс приготовления</h3><div class="recipe-process">${esc(scaleProcess(recipe.process||'',factor)||'Процесс ещё не добавлен.')}</div>${recipe.unparsedText?`<div class="notice warn"><b>Дополнительный текст не пересчитан — проверьте вручную</b><div class="recipe-process">${esc(recipe.unparsedText)}</div></div>`:''}<p class="tiny muted">Количество масштабировано в ${fmtNum(factor,4)} раза. Время, температура и проценты остаются прежними.</p>`;
  };
  $('#recipeCalcTarget').oninput=calculate;if($('#recipeCalcBase'))$('#recipeCalcBase').oninput=calculate;$('#closeM').onclick=$('#closeM2').onclick=closeModal;calculate();
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
async function useStatVersion(id){const s=state.stats.find(x=>x.id===id);if(!s?.recipeSnapshot)return;const r=state.recipes.find(x=>x.id===s.recipeId);if(!r||r.archived){toast('Сначала верните технологическую карту из архива.','error');return;}if(await commitStateChange(()=>{const recipe=state.recipes.find(x=>x.id===s.recipeId);recipe.ingredients=structuredClone(s.recipeSnapshot.ingredients||[]);recipe.ingredientsText=recipeIngredientText(recipe.ingredients);recipe.yield=s.recipeSnapshot.yield??recipe.yield;recipe.shelfLifeDays=s.recipeSnapshot.shelfLifeDays??recipe.shelfLifeDays;Object.assign(recipe,classifyRecipe(recipe));recipe.updatedAt=nowISO();},'Не удалось подставить фактическую версию. Карта не изменена.')){ui.recipeId=r.id;ui.baseYield=null;calcMode='production';toast('Последняя фактическая версия подставлена');setRoute('calculator');}}

function noticeRows(){
  const rows=[];for(const b of state.batches.filter(x=>!x.stoppedAt)){const st=expiryStatus(b.expiresAt);if(st.key!=='ok')rows.push({id:`expiry-${b.id}`,type:st.key,title:b.name,sub:st.key==='expired'?`Срок истёк ${fmtDate(b.expiresAt)}`:`До окончания ${Math.max(0,st.days)} дн. · ${fmtDate(b.expiresAt)}`,date:b.expiresAt});}
  for(const s of state.stock.filter(x=>x.amount<0))rows.push({id:`stock-${s.name}-${s.unit}`,type:'shortage',title:`Дефицит: ${s.name}`,sub:`Баланс ${fmtNum(s.amount,4)} ${s.unit}`,date:nowISO()});
  return rows.sort((a,b)=>new Date(a.date)-new Date(b.date));
}
function updateNoticeBadge(){const n=noticeRows().filter(x=>!state.readNotices.includes(x.id)).length;$('#notificationBadge').hidden=!n;$('#notificationBadge').textContent=n>99?'99+':n;}
function renderNotifications(){const rows=noticeRows();$('#content').innerHTML=`<div class="section-head"><div><h2>Центр уведомлений</h2><p class="tiny muted">Партии попадают сюда за 3 дня до конца срока и остаются до стопа/списания.</p></div><button class="soft" id="markRead">Отметить просмотренными</button></div>${rows.length?`<div class="list">${rows.map(n=>`<div class="list-item"><div class="list-main"><div class="list-title ${n.type==='expired'||n.type==='shortage'?'danger-text':''}">${esc(n.title)}</div><div class="list-sub">${esc(n.sub)}</div></div><span class="pill ${n.type==='soon'?'burg':'dark'}">${n.type==='soon'?'срок':n.type==='expired'?'просрочено':'склад'}</span></div>`).join('')}</div>`:`<div class="empty">Сейчас критичных уведомлений нет.</div>`}`;$('#markRead').onclick=async()=>{if(await commitStateChange(()=>{state.readNotices=[...new Set([...state.readNotices,...rows.map(x=>x.id)])];},'Не удалось сохранить отметки уведомлений.',false)){updateNoticeBadge();toast('Уведомления отмечены просмотренными');}};}
async function checkExpiryNotifications(){
  if(!session.authenticated||!stateReady)return;
  const soon=noticeRows().filter(x=>x.type==='soon'&&!state.readNotices.includes(x.id));
  updateNoticeBadge();
  if(soon.length && state.settings.notifications && 'Notification'in window && Notification.permission==='granted'){
    const reg=await navigator.serviceWorker?.ready; reg?.showNotification('Tincture Lab: срок годности',{body:`${soon.length} партий испортятся в течение 3 дней`,icon:'icon.svg',tag:'expiry'}).catch(()=>{});
  }
}

function renderSettings(){
  $('#content').innerHTML='<div class="grid two"><section class="card"><h2>Общая база</h2><div class="notice">Все технологические карты, фотографии, заявки, склад, планы, партии и история хранятся на сервере. Сохранённые изменения доступны на других устройствах после обновления.</div><div class="divider"></div><p class="tiny muted">Без интернета интерфейс доступен, а вход, открытие базы и сохранение требуют соединения с сервером.</p><div class="actions"><button class="soft" id="refreshSettings">Обновить общую базу</button><button class="soft" id="installSettings">Установить приложение</button><button class="soft" id="notifySettings">'+(state.settings.notifications?'Уведомления включены':'Включить уведомления')+'</button></div><p class="tiny muted">На iPhone: Safari → «Поделиться» → «На экран Домой». Разрешение системных уведомлений выдаётся отдельно на каждом устройстве.</p></section><section class="card"><h2>Резервная копия</h2><p class="tiny muted">Полная копия содержит все рабочие данные и фотографии. Загрузка копии заменяет общую базу на сервере для всех устройств.</p><div class="actions"><button class="soft" id="exportData">Скачать полную копию JSON</button><label class="soft file-action">Загрузить полную копию JSON<input id="importData" type="file" accept="application/json,.json" hidden></label></div></section></div>'+(session.role==='owner'?'<section class="card password-card"><h2>Пароли доступа</h2><p class="tiny muted">Вы вошли как владелец. Можно сменить свой пароль, пароль сотрудников или оба. После смены устройства с этим доступом войдут заново.</p><form id="passwordForm"><div class="form-grid"><div class="field full"><label for="currentPassword">Текущий пароль владельца</label><input id="currentPassword" type="password" autocomplete="current-password" required></div><div class="field"><label for="newOwnerPassword">Новый пароль владельца</label><input id="newOwnerPassword" type="password" autocomplete="new-password" minlength="12"><span class="tiny muted">Минимум 12 символов, либо оставьте пустым.</span></div><div class="field"><label for="newStaffPassword">Новый пароль сотрудников</label><input id="newStaffPassword" type="password" autocomplete="new-password" minlength="12"><span class="tiny muted">Минимум 12 символов, либо оставьте пустым.</span></div></div><p id="passwordError" class="notice warn" role="alert" hidden></p><div class="actions" style="margin-top:16px"><button class="primary" type="submit" id="savePasswords">Сменить пароли</button></div></form></section>':'<section class="card password-card"><h2>Доступ сотрудника</h2><p class="tiny muted">Вы можете работать с общей базой. Пароли доступа меняет владелец.</p></section>');
  $('#installSettings').onclick=triggerInstall;$('#notifySettings').onclick=enableNotifications;
  $('#refreshSettings').onclick=()=>refreshSharedState(true);$('#exportData').onclick=exportData;$('#importData').onchange=importData;
  if(session.role==='owner')$('#passwordForm').onsubmit=async event=>{
    event.preventDefault();const ownerPassword=$('#newOwnerPassword').value,staffPassword=$('#newStaffPassword').value;
    if(stateMutationBusy||refreshBusy){toast('Дождитесь завершения текущего запроса.','error');return;}
    if(!ownerPassword&&!staffPassword){$('#passwordError').textContent='Укажите хотя бы один новый пароль.';$('#passwordError').hidden=false;return;}
    const payload={currentPassword:$('#currentPassword').value};if(ownerPassword)payload.ownerPassword=ownerPassword;if(staffPassword)payload.staffPassword=staffPassword;
    const button=$('#savePasswords');button.disabled=true;$('#passwordError').hidden=true;stateMutationBusy=true;updateNetwork('syncing');
    try{const authenticated=await api('/api/password',{method:'POST',body:JSON.stringify(payload)});authGeneration++;session=authenticated;formDirty=false;renderSettings();toast('Пароли изменены. На устройствах с изменённым доступом потребуется новый вход.');}
    catch(error){if((error.status!==401||error.code==='invalid_credentials')&&$('#passwordError')){$('#passwordError').textContent=error.network?'Нет связи с сервером. Изменение паролей не подтверждено. Войдите с новым паролем или проверьте текущий перед повтором.':error.message;$('#passwordError').hidden=false;button.disabled=false;}}
    finally{stateMutationBusy=false;updateNetwork();}
  };
}
function exportData(){
  if(!session.authenticated||!stateReady)return;
  const blob=new Blob([JSON.stringify(sharedStateCopy(state),null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='tincture-lab-backup-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
async function importData(e){
  const file=e.target.files[0];if(!file)return;
  try{if(file.size>100*1024*1024)throw Error('Полная копия больше 100 МБ. Уменьшите размер фотографий.');const data=JSON.parse(await file.text());if(!Array.isArray(data.recipes)||!data.settings)throw Error('Выберите полную резервную копию базы.');const restored=normalizeState(data);
    modal('<div class="section-head"><h2>Восстановить общую базу?</h2><button class="icon-btn" id="closeRestore">×</button></div><div class="notice warn">Копия заменит рабочие данные на сервере для всех устройств. Перед заменой можно скачать текущую базу.</div><p class="tiny muted">В копии: '+restored.recipes.length+' ТК, '+restored.stock.length+' позиций склада, '+restored.batches.length+' партий и '+restored.stats.length+' записей истории.</p><div class="actions"><button class="soft" id="exportBeforeRestore">Скачать текущую базу</button><button class="danger" id="confirmRestore">Восстановить из копии</button><button class="soft" id="cancelRestore">Отмена</button></div>');
    $('#closeRestore').onclick=$('#cancelRestore').onclick=closeModal;$('#exportBeforeRestore').onclick=exportData;
    $('#confirmRestore').onclick=async()=>{if(await commitStateChange(()=>{state=restored;},'Не удалось восстановить копию. Общая база не изменена.')){closeModal();toast('Общая база восстановлена');render();}};
  }catch(error){toast('Ошибка импорта: '+error.message,'error');}
}
function updateNetwork(mode){
  const dot=$('#syncDot'),label=$('#syncLabel');if(!dot||!label)return;dot.className='sync-dot';
  if(mode==='syncing'||stateMutationBusy||refreshBusy){dot.classList.add('warn');label.textContent='Связь с сервером…';return;}
  if(!session.authenticated){label.textContent='Вход в общую базу';return;}
  if(uncertainSave){dot.classList.add('warn');label.textContent='Результат сохранения уточняется';return;}
  if(!navigator.onLine||networkIssue){dot.classList.add('warn');label.textContent='Нет связи · запись недоступна';return;}
  dot.classList.add('online');label.textContent=remotePending?'Есть новые общие данные':stateReady?'Общая база · сохранено':'Перенос общей базы';
}
window.addEventListener('online',()=>{if(logoutPending){completeLogout();return;}updateNetwork();checkSharedRevision();});
window.addEventListener('offline',()=>updateNetwork());
window.addEventListener('focus',checkSharedRevision);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkSharedRevision();});
// Visible tabs check once a minute; hidden tabs leave a sleeping database idle.
setInterval(checkSharedRevision,60000);

async function enableNotifications(){if(!('Notification'in window)){toast('Системные уведомления не поддерживаются','error');return}const p=await Notification.requestPermission();if(!await commitStateChange(()=>{state.settings.notifications=p==='granted';},'Не удалось сохранить настройку уведомлений.',false))return;if(p==='granted'){toast('Уведомления включены');}else toast('Разрешение на уведомления не выдано','error');render();}
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;$('#installBtn').hidden=false;});$('#installBtn').onclick=triggerInstall;
async function triggerInstall(){if(deferredInstallPrompt){deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;$('#installBtn').hidden=true;}else toast('Если кнопка установки не появилась, используйте меню браузера → «Установить приложение»');}

if('serviceWorker'in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.warn));}
setInterval(checkExpiryNotifications,60*60*1000);
load();
