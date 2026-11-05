import {$, $$, state, api, esc, btn, notice, pageHead, select as selectField, field, bindForm, fmtDate, toast} from './core.js?v=2.14.0';

const select = (name, label, entries, value) => selectField(name, label, Object.fromEntries(entries), value);
const roles = {lead:'Руководитель группы', methodist:'Методист группы', manager:'Управляющий точками'};
const options = rows => rows.map(row => [row.id, row.name]);
const venueLink = (path, id) => path+'?venue='+encodeURIComponent(id);
const fraction = (n, d) => d ? n+' из '+d+' · '+Math.round(100*n/d)+'%' : 'Обучение не назначено';
const permissions = [['shifts_manage','Смены и заработок'],['uploads_manage','Исходные материалы'],['exports_access','Выгрузка персональных данных']];
const submit = label => btn(label,'check','primary','type="submit"');
const loginField = () => field('login','Логин действующего управляющего','','text','required maxlength="255"');
const form = (id, contents) => `<form id="${id}" class="workspace-form">${contents}</form>`;
const metric = (label, value) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;

function overviewHTML(data) {
 const total=data.totals, names=new Map(data.venues.map(v=>[v.id,v.name]));
 return `<section class="card" aria-label="Сводка по заведениям">
  <h2>Текущая готовность</h2>
  <dl class="workspace-metrics">
   ${metric('Сотрудников',total.employees)}
   ${metric('Готовы по обязательному обучению',total.ready+' из '+total.employees)}
   ${metric('Назначения завершены',fraction(total.complete,total.assigned))}
   ${metric('Письменных работ ждут проверки',total.pending_review)}
  </dl></section>
  <section class="workspace-cards" aria-label="Сравнение заведений">
  ${data.venues.length?data.venues.map(item=>`<article class="card">
   <p class="eyebrow">${item.available?'Доступно':item.status==='archived'?'В архиве':'Доступ приостановлен'}</p>
   <h2>${esc(item.name)}</h2>
   ${item.available?`<dl class="workspace-metrics">
    ${metric('Команда',item.employees)}${metric('Готовы к работе',item.ready+' из '+item.employees)}
    ${metric('Назначения',fraction(item.complete,item.assigned))}${metric('Просрочено',item.overdue)}
    ${metric('На проверке',item.pending_review)}${metric('За период',item.attempts?item.attempts+' завершено':'Нет попыток')}
    ${metric('Последний вход команды',item.last_activity?fmtDate(item.last_activity,true):'Нет данных')}
   </dl>`:'<p class="muted">Данные точки пока недоступны.</p>'}
   ${item.direct?`<a class="btn soft" href="${venueLink('/app',item.id)}">Открыть заведение</a>`:''}
  </article>`).join(''):notice('Доступные заведения появятся здесь после подключения.')}
  </section>
  <section class="card"><h2>Очередь письменных работ</h2>
  ${data.queue.length?data.queue.map(row=>`<a class="line-item" href="${venueLink('/app/assessment-attempts/'+encodeURIComponent(row.id),row.venue_id)}">
   <span class="grow"><strong>${esc(row.title)}</strong><small>${esc(names.get(row.venue_id))} · ${esc(row.name)}</small></span>
   <small>${row.submitted_at?fmtDate(row.submitted_at,true):''}</small></a>`).join(''):'<p class="muted">В доступных вам кабинетах нет работ для проверки.</p>'}
  ${data.queue.length===100?'<p class="muted">Показаны 100 самых ранних работ. Остальные доступны в аналитике каждой точки.</p>':''}</section>`;
}

function grantForm(id, venues, people) {
 const login=people?select('login','Управляющий',people.map(person=>[person.login,person.name+' · '+person.login]),''):loginField();
 const rights=people?'':`<fieldset class="field"><legend>Дополнительные права</legend>
   ${permissions.map(([name,label])=>`<label><input type="checkbox" name="${name}"> ${label}</label>`).join('')}</fieldset>`;
 return form(id,select('venue','Заведение',options(venues),'')+login+
  select('active','Действие',[['true','Выдать доступ'],['false','Отозвать доступ']],'true')+rights+submit('Сохранить доступ'));
}

function groupHTML(group, owner, venues) {
 const latest=group.standards.filter((standard,i,all)=>all.findIndex(row=>row.key===standard.key)===i);
 const canEdit=['owner','lead','methodist'].includes(group.role), points=group.venues.filter(v=>v.writable);
 const people=group.people.filter(person=>person.login!==state.me.account.login);
 return `<section class="card"><h2>${esc(group.name)}</h2>
 <p class="muted">${owner?'Управление составом и ролями':esc(roles[group.role])}</p>
 ${owner&&venues.length?form('group-point',
  select('venue','Заведение',options(venues),'')+
  select('active','Состав группы',[['true','Подключить'],['false','Исключить']],'true')+submit('Сохранить состав')):''}
 ${['owner','lead'].includes(group.role)?`<h3>Участники группы</h3>
  ${group.people.map(person=>`<p>${esc(person.name)} · ${esc(roles[person.role])}</p>`).join('')||'<p class="muted">Участники ещё не назначены.</p>'}
  ${owner?form('group-person',loginField()+select('role','Роль',[...Object.entries(roles),['remove','Исключить из группы']],'manager')+submit('Сохранить роль')):
   people.length&&group.venues.length?grantForm('group-grant',group.venues,people):''}`:''}
 </section><section class="card"><h2>Стандарты группы</h2>
 <p class="muted">Каждая версия поступает в выбранные точки как отдельный черновик. Управляющий проверяет его перед публикацией.</p>
 ${group.standards.map(row=>`<div class="line-item"><strong>${esc(row.title)}</strong><span class="muted">Версия ${row.version}</span></div>`).join('')||'<p class="muted">Пока нет стандартов.</p>'}
 ${canEdit?`<details><summary>Загрузить стандарт из BarOS JSON</summary>
 ${form('group-standard',
  select('key','Редакция',[['','Новый стандарт'],...latest.map(row=>[row.key,row.title+' · новая версия'])],'')+
  '<label class="field"><span>Файл курса</span><input type="file" name="course" accept=".json,application/json" required></label>'+
  select('source_venue','Исходная точка для фото',[['','Курс без фото'],...options(group.venues)],'')+submit('Сохранить версию'))}</details>
 ${group.standards.length&&points.length?`<details><summary>Передать черновик в точки</summary>
  ${form('group-distribute',select('standard','Версия стандарта',group.standards.map(row=>[row.id,row.title+' · версия '+row.version]),'')+
   `<fieldset class="field"><legend>Точки</legend>${points.map(v=>`<label><input type="checkbox" name="venue" value="${v.id}"> ${esc(v.name)}</label>`).join('')}</fieldset>`+
   select('position','Назначение по должности',[['','Как в стандарте'],['all','Все должности'],...Object.entries(state.me.positions)],'')+submit('Создать черновики'))}</details>`:''}`:''}
 </section>`;
}

export async function workspacePage(root) {
 const owner=state.me.account.role==='owner';
 const ticket=state.renderTicket;
 const [groups,venues]=owner?await Promise.all([api('/owner/groups'),api('/venues')]):[state.me.workspaces.groups,state.me.workspaces.venues];
 if(ticket!==state.renderTicket)return;
 const initial=new URLSearchParams(location.search).get('group');
 const gid=groups.some(group=>String(group.id)===initial)?initial:owner&&groups.length?String(groups[0].id):'';
 root.innerHTML=pageHead(owner?'Ресторанные группы':'Все мои заведения','Сравнивайте точки, отслеживайте обучение и открывайте нужный кабинет.')+
 `<div class="stack">${owner?`<section class="card"><h2>Подключение</h2>
  ${form('new-group',field('name','Название группы','','text','required minlength="2" maxlength="160"')+submit('Создать группу'))}
  ${venues.length?`<details><summary>Доступ управляющего к заведению</summary>${grantForm('owner-grant',venues,null)}</details>`:''}
  </section>`:''}
  <section class="card workspace-form"><h2>Область просмотра</h2>
   ${select('group','Рабочее пространство',[['',owner?'Выберите группу':'Мои заведения'],...options(groups)],gid)}
   ${select('days','Активность за период',[['7','7 дней'],['30','30 дней'],['90','90 дней'],['365','Год']],'30')}
   ${select('position','Должность',[['','Все должности'],...Object.entries(state.me.positions)],'')}
  </section><div data-workspace-content class="stack" aria-live="polite"></div></div>`;
 const output=$('[data-workspace-content]',root), selected=$('[name=group]',root);
 let generation=0;
 const bind=(id, callback)=>{if($('#'+id,root))bindForm('#'+id,callback,root)};
 const grant=(id, endpoint, allowSensitive)=>bind(id,async data=>{
  const flags=allowSensitive?Object.fromEntries(permissions.map(([name])=>[name,data.has(name)])):{};
  await api(endpoint(Number(data.get('venue'))),'PUT',{login:data.get('login'),active:data.get('active')==='true',permissions:flags});
  toast('Доступ обновлён');
  await draw();
 });
 async function draw(){
  const current=++generation, id=selected.value;
  const filters=new URLSearchParams({days:$('[name=days]',root).value,position:$('[name=position]',root).value});
  if(id)filters.set('group_id',id);
  output.setAttribute('aria-busy','true');
  try{
   const [summary,group]=await Promise.all([api('/workspaces/overview?'+filters),id?api('/workspaces/groups/'+id):null]);
   if(current!==generation||ticket!==state.renderTicket)return;
   output.innerHTML=overviewHTML(summary)+(group?groupHTML(group,owner,venues):'');
   if(!group)return;
   const base='/workspaces/groups/'+group.id;
   bind('group-point',async data=>{
    await api('/owner/groups/'+group.id+'/venues/'+data.get('venue'),'PUT',{active:data.get('active')==='true'});
    toast('Состав группы обновлён');await draw();
   });
   bind('group-person',async data=>{
    await api('/owner/groups/'+group.id+'/people','PUT',{login:data.get('login'),role:data.get('role')});
    toast('Роль обновлена');await draw();
   });
   grant('group-grant',oid=>base+'/venues/'+oid+'/access',false);
   bind('group-standard',async formData=>{
    const file=formData.get('course');
    if(!file?.size||file.size>2*1024*1024)throw new Error('Выберите файл курса BarOS JSON до 2 МБ.');
    let data;
    try{data=JSON.parse(await file.text())}catch{throw new Error('Не удалось прочитать файл JSON.')}
    const key=formData.get('key')||null;
    const expected_version=key?Math.max(...group.standards.filter(row=>row.key===key).map(row=>row.version)):0;
    await api(base+'/standards','POST',{course:data?.course||data,key,expected_version,source_venue:Number(formData.get('source_venue'))||null});
    toast('Версия стандарта сохранена');await draw();
   });
   bind('group-distribute',async data=>{
    const chosen=data.getAll('venue').map(Number);
    if(!chosen.length)throw new Error('Выберите хотя бы одну точку.');
    const position=data.get('position');
    const result=await api(base+'/standards/'+data.get('standard')+'/distribute','POST',{venues:chosen,positions:position?[position]:null});
    toast('Создано черновиков: '+result.items.filter(item=>!item.existing).length);
    await draw();
   });
  }catch(error){
   if(current===generation&&ticket===state.renderTicket)output.innerHTML=notice(error.message,'error','Не удалось загрузить обзор');
  }finally{if(current===generation)output.removeAttribute('aria-busy')}
 }
 for(const input of $$('[name=group],[name=days],[name=position]',root))input.onchange=draw;
 if(owner){
  bind('new-group',async data=>{
   const group=await api('/owner/groups','POST',{name:data.get('name')});
   const option=document.createElement('option');option.value=group.id;option.textContent=group.name;selected.append(option);
   selected.value=String(group.id);toast('Группа создана');await draw();
  });
  grant('owner-grant',oid=>'/owner/venues/'+oid+'/access',true);
 }
 await draw();
}
