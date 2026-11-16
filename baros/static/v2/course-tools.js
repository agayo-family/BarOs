import {$,$$,api,go,esc,icon,btn,bindForm,modal,on,toast,notice,venueURL,state} from './core.js?v=2.14.0';

export const priorities={P0:'Критическая',P1:'Высокая',P2:'Плановая'};

export function courseCover(url,extraClass=''){
 if(!url)return '';
 const image=new URL(url,location.origin);
 if(state.me?.account.role==='manager'&&state.org)image.searchParams.set('venue',state.org);
 return `<img class="course-cover ${extraClass}" src="${esc(image.pathname+image.search)}" alt="" loading="lazy" decoding="async">`;
}

export function editPresentation(course,done){
 let coverId=course.cover_url?new URL(course.cover_url,location.origin).searchParams.get('v'):null;
 const form=modal('Обложка и важность',`<form id="course-presentation">
 <div data-cover-preview>${courseCover(course.cover_url)}</div>
 <label class="field"><span>Фото курса</span><input type="file" data-course-cover accept="image/jpeg,image/png,image/webp"></label>
 ${btn('Убрать фото','trash','text','type="button" data-clear-cover '+(coverId?'':'hidden'))}
 <label class="field"><span>Важность в этом заведении</span><select name="priority">
 <option value="">По умолчанию${course.priority_default?' · '+priorities[course.priority_default]:''}</option>
 ${Object.entries(priorities).map(([key,label])=>`<option value="${key}" ${key===course.priority_override?'selected':''}>${label}</option>`).join('')}</select></label>
 <div class="modal-actions">${btn('Сохранить оформление','check','primary','type="submit"')}</div></form>`);
 on('[data-course-cover]','change',async(_,input)=>{
  const file=input.files?.[0];if(!file)return;
  if(file.size>8*1024*1024)throw new Error('Размер фото — не больше 8 МБ');
  const formData=new FormData();formData.append('file',file);
  const submit=form.root.querySelector('button[type=submit]');
  const clear=form.root.querySelector('[data-clear-cover]');
  submit.disabled=true;input.disabled=true;clear.disabled=true;
  try{
   const result=await api('/media','POST',formData);
   coverId=result.url.split('/').at(-1);
   $('[data-cover-preview]',form.root).innerHTML=courseCover(result.url);
   clear.hidden=false;
  }finally{submit.disabled=false;input.disabled=false;clear.disabled=false}
 },form.root);
 on('[data-clear-cover]','click',(_,b)=>{
  coverId=null;b.hidden=true;$('[data-cover-preview]',form.root).innerHTML='';
  $('[data-course-cover]',form.root).value='';
 },form.root);
 bindForm('#course-presentation',async data=>{
  const result=await api('/courses/'+course.id+'/presentation','PUT',{cover_id:coverId,priority_override:data.get('priority')||null});
  form.close();toast('Оформление курса сохранено');done(result);
 },form.root);
}

export function removeCourse(course,done){
 const dialog=modal('Переместить курс в корзину',`<form id="course-remove">
 <p>«${esc(course.title)}» исчезнет из обучения этого заведения. Результаты сохранятся, курс можно вернуть из корзины.</p>
 <div class="modal-actions">${btn('Переместить в корзину','trash','danger','type="submit"')}</div></form>`);
 bindForm('#course-remove',async()=>{
  await api('/courses/'+course.id,'DELETE');dialog.close();toast('Курс в корзине');done();
 },dialog.root);
}

export async function distributeCourse(key,fingerprint){
 const venues=(await api('/venues')).filter(v=>['active','read_only'].includes(v.status));
 const dialog=modal('Подключить курс к заведениям',venues.length?`<form id="catalog-distribute">
 <p>В выбранных заведениях появится черновик курса для управляющего.</p>
 <fieldset class="venue-choices"><legend>Действующие заведения</legend>${venues.map(v=>
  `<label class="check-label"><input type="checkbox" name="venue" value="${v.id}">${esc(v.name)}</label>`).join('')}</fieldset>
 <div class="modal-actions">${btn('Добавить черновики','plus','primary','type="submit"')}</div></form>`:
 '<p>Сначала создайте заведение в кабинете владельца.</p>');
 if(!venues.length)return;
 bindForm('#catalog-distribute',async (data)=>{
  const ids=data.getAll('venue').map(Number);
  if(!ids.length)throw new Error('Выберите хотя бы одно заведение');
  const result=await api('/owner/catalog/courses/'+encodeURIComponent(key)+'/distribute','POST',{venue_ids:ids,fingerprint});
  const names=new Map(venues.map(v=>[v.id,v.name]));
  $('.modal-body',dialog.root).innerHTML=`<ul class="import-receipt">${result.map(x=>
   `<li><strong>${esc(names.get(x.venue_id))}</strong><span>${{draft:'Добавлен черновик',existing:'Курс уже есть',trash:'Курс в корзине'}[x.status]}</span></li>`).join('')}</ul>`;
 },dialog.root);
}

export function importZip(refresh){
 const dialog=modal('Импорт ZIP',`<label class="field"><span>ZIP с учебными пакетами до 15 МБ</span><input type="file" accept=".zip,application/zip" data-zip-file></label>
 <div data-zip-state role="status"></div><section data-zip-preview></section>`,{wide:true});
 const input=$('[data-zip-file]',dialog.root),status=$('[data-zip-state]',dialog.root),area=$('[data-zip-preview]',dialog.root);
 const upload=file=>{const fields=new FormData();fields.append('file',file);return fields};
 on('[data-zip-file]','change',async()=>{
  const file=input.files?.[0];area.innerHTML='';status.textContent='';
  if(!file)return;
  if(file.size>15*1024*1024){status.textContent='Размер ZIP — не более 15 МБ';return}
  input.disabled=true;status.textContent='Проверяем учебные пакеты…';
  try{
   const preview=await api('/packages/zip/preview','POST',upload(file));
   status.textContent='';
   render(preview,file);
  }catch(error){status.textContent=error.message}
  finally{input.disabled=false}
 },dialog.root);

 function render(preview,file){
  area.innerHTML=`<form id="zip-import"><p>Заведение для загрузки: <strong>${esc(preview.venue)}</strong>. Материалы будут черновиками.</p>
  ${preview.archive_venues.length?`<label class="field"><span>К каким материалам заведения в реестре относится эта точка</span><select name="archive_venue" required>
  <option value="">Выберите заведение в реестре</option>${preview.archive_venues.map(x=>`<option ${x===preview.suggested_venue?'selected':''}>${esc(x)}</option>`).join('')}</select></label>`:''}
  <div class="row between"><strong data-zip-count></strong>${btn('Выбрать доступные','check','soft','type="button" data-zip-select')}</div>
  <div data-zip-entries class="import-receipt"></div><div class="modal-actions">${btn('Импортировать выбранное','upload','primary','type="submit"')}</div></form>`;
  const venue=$('[name=archive_venue]',area),list=$('[data-zip-entries]',area),submit=$('button[type=submit]',area);
  const count=()=>{
   const n=$$('input:checked',list).length;
   $('[data-zip-count]',area).textContent='Выбрано: '+n;submit.disabled=!n;
  };
  const renderRows=()=>{
   list.innerHTML=preview.entries.map(item=>{
    const wrongVenue=item.venues.length&&!item.venues.includes(venue?.value);
    const detail=item.error||(wrongVenue?'Из реестра: '+item.venues.join(', '):item.duplicate?'Уже импортирован':item.kind==='assessment'?'Отдельный тест':'Курс');
    return `<label class="zip-entry">
     <input type="checkbox" name="package" value="${esc(item.file)}" ${item.error||wrongVenue||item.duplicate?'disabled':''}>
     <span><strong>${esc(item.title||item.file.split('/').at(-1))}</strong><small>${esc(detail)}${item.priority?' · '+esc(item.priority):''}</small></span></label>`;
   }).join('');
   count();
  };
  venue?.addEventListener('change',renderRows);
  list.addEventListener('change',count);
  on('[data-zip-select]','click',()=>{
   $$('input:not(:disabled)',list).forEach(x=>x.checked=true);count();
  },area);
  bindForm('#zip-import',async data=>{
   const selection=data.getAll('package');
   if(!selection.length)return;
   const fields=upload(file);fields.append('archive_hash',preview.hash);fields.append('selection',JSON.stringify(selection));
   fields.append('archive_venue',data.get('archive_venue')||'');
   input.disabled=true;
   try{
    const result=await api('/packages/zip/import','POST',fields);
    area.innerHTML=`<h3>Создано черновиков: ${result.imported}</h3><ul class="import-receipt">${result.entries.map(item=>
     `<li><a href="${esc(venueURL(item.url))}">${esc(item.title)}</a><span>${item.duplicate?'Уже был в заведении':'Черновик'}</span></li>`).join('')}</ul>`;
    await refresh?.();
   }finally{input.disabled=false}
  },area);
  renderRows();
 }
}
