import {$,$$,api,btn,esc,fmtDate,icon,modal,bindForm,on,pageCleanup,pageHead,state,toast} from './core.js?v=2.14.0';

const stations={bar:'Бар',kitchen:'Кухня'};
const stopURL='/app/stop-list';

export function mountStopListWidget(root){
 const box=$('[data-stop-widget]',root);
 if(!box)return;
 const ticket=state.renderTicket;
 let disposed=false;
 async function refresh(){
  if(disposed||document.hidden)return;
  try{
   const {items}=await api('/stop-list?current=true');
   if(disposed||ticket!==state.renderTicket)return;
   box.innerHTML=`<div class="row between"><h2>${icon('list')} Стоп-лист</h2>
   <a href="${stopURL}" class="btn sm soft">Открыть ${icon('arrow')}</a></div>
   ${items.length?`<div class="stop-preview">${items.slice(0,6).map(item=>`<span title="${esc(stations[item.station])}">${esc(item.name)}</span>`).join('')}${items.length>6?`<span>Ещё ${items.length-6}</span>`:''}</div>`:'<p class="muted">Сейчас все позиции доступны.</p>'}`;
  }catch{
   if(disposed||ticket!==state.renderTicket)return;
   box.innerHTML='<div class="row between"><h2>Стоп-лист</h2><a href="/app/stop-list" class="btn sm soft">Открыть</a></div><p class="muted">Не удалось обновить наличие.</p>';
  }
 }
 refresh();
 const interval=window.setInterval(refresh,30000);
 document.addEventListener('visibilitychange',refresh);
 pageCleanup(()=>{disposed=true;window.clearInterval(interval);document.removeEventListener('visibilitychange',refresh)},ticket);
}

export async function stopListPage(root){
 let data=await api('/stop-list'),station='all',query='',unavailableOnly=!data.editable_stations.length;
 const manager=state.me.account.role!=='employee';
 function draw(){
  root.innerHTML=pageHead('Стоп-лист',data.editable_stations.length?'Отметьте позиции, которых сейчас нет.':'Позиции, которые сейчас недоступны.',
   btn('На экран телефона','download','soft','data-stop-install'))+
   `<section class="card stop-list-card">
   <div class="toolbar stop-tools"><div class="tabs">${[['all','Все'],...Object.entries(stations)].map(([key,label])=>
    `<button data-stop-station="${key}" class="${station===key?'active':''}" aria-pressed="${station===key}">${label}</button>`).join('')}</div>
    <label class="field"><span class="sr-only">Найти позицию</span><input type="search" data-stop-search value="${esc(query)}" placeholder="Найти позицию"></label>
    ${data.editable_stations.length?`<label class="check-label"><input type="checkbox" data-stop-only ${unavailableOnly?'checked':''}> Только в стопе</label>`:''}
   </div><div data-stop-items></div></section>`+
   (data.editable_stations.length?`<details class="card section-space" data-stop-settings><summary>Добавить название из меню</summary><form id="stop-create" class="stop-create">
    <label class="field"><span>Позиция</span><input name="name" maxlength="140" required placeholder="Например, лимонад тархун"></label>
    <label class="field"><span>Раздел</span><select name="station">${data.editable_stations.map(s=>`<option value="${s}">${stations[s]}</option>`).join('')}</select></label>
    ${btn('Добавить','plus','primary','type="submit"')}</form></details>`:'');
  on('[data-stop-install]','click',()=>{
   modal('Стоп-лист на телефоне',`<ul><li><strong>Android.</strong> Установите BarOS через браузер. Затем удерживайте значок приложения и выберите «Стоп-лист», если ваше устройство показывает быстрые действия.</li><li><strong>iPhone.</strong> Откройте эту страницу в Safari и выберите «Поделиться» → «На экран Домой». Для ярлыка именно на эту страницу выключите «Открыть как веб-приложение», если Safari предлагает этот параметр.</li></ul>${btn('Установить BarOS','download','primary','data-install')}`);
  },root);
  on('[data-stop-station]','click',(_,b)=>{
   station=b.dataset.stopStation;draw();$('[data-stop-station='+station+']',root)?.focus();
  },root);
  $('[data-stop-search]',root).addEventListener('input',e=>{query=e.target.value;drawItems()});
  $('[data-stop-only]',root)?.addEventListener('change',e=>{unavailableOnly=e.target.checked;drawItems()});
  if($('#stop-create',root))bindForm('#stop-create',async form=>{
   const item=await api('/stop-list','POST',{name:form.get('name'),station:form.get('station')});
   await reload();station=item.station;query='';unavailableOnly=false;draw();toast('Позиция добавлена');
  },root);
  drawItems();
 }
 async function reload(){data=await api('/stop-list')}
 function drawItems(){
  const area=$('[data-stop-items]',root);
  const list=data.items.filter(item=>(station==='all'||station===item.station)&&
   (!unavailableOnly||item.unavailable)&&item.name.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')))
   .sort((a,b)=>Number(b.unavailable)-Number(a.unavailable)||a.name.localeCompare(b.name,'ru'));
  area.innerHTML=list.map(item=>{
   const editable=data.editable_stations.includes(item.station);
   const title=`<span><strong>${esc(item.name)}</strong><small>${stations[item.station]}${item.unavailable?' · в стопе':''}</small></span>`;
   return `<div class="stop-item ${item.unavailable?'is-unavailable':''}">
   ${editable?`<label><input type="checkbox" data-stop-item="${item.id}" ${item.unavailable?'checked':''} aria-label="${esc(item.name)} — в стоп-листе">${title}</label>`:title}
   ${item.unavailable?`<time>${esc(fmtDate(item.updated_at,true))}</time>`:''}
   ${editable&&manager&&!item.unavailable?btn('','trash','ghost icon-only sm',`data-stop-remove="${item.id}" aria-label="Удалить позицию ${esc(item.name)}"`):''}</div>`;
  }).join('')||'<p class="muted">'+(query?'Позиции не найдены.':unavailableOnly?'В стоп-листе ничего нет.':'Добавьте позиции из меню.')+'</p>';
  on('[data-stop-item]','change',async(_,input)=>{
   const item=data.items.find(row=>row.id===Number(input.dataset.stopItem));
   input.disabled=true;
   try{
    Object.assign(item,await api('/stop-list/'+item.id,'PUT',{unavailable:input.checked,version:item.version}));
    drawItems();$('[data-stop-item="'+item.id+'"]',root)?.focus();
   }catch(error){await reload();drawItems();throw error}
   finally{input.disabled=false}
  },area);
  on('[data-stop-remove]','click',async(_,b)=>{
   if(!confirm('Удалить позицию из списка?'))return;
   await api('/stop-list/'+b.dataset.stopRemove,'DELETE');await reload();drawItems();
  },area);
 }
 draw();
}
