import {$,$$,state,api,esc,field,btn,pageHead,bindForm,toast,notice,pageCleanup} from './core.js?v=2.14.0';
import {orbitMarkup,mountOrbit} from './orbit.js?v=2.14.0';

export async function showcasePage(root){
 const ticket=state.renderTicket,controller=new AbortController();
 let data=await api('/owner/showcase'),items=data.items.map(x=>({...x})),uploading=false,stopPreview=()=>{};
 root.innerHTML=pageHead('Заведения на главной','Выберите подключённые заведения для публичного показа.', '<a class="btn soft" href="/about#venues">Посмотреть на сайте</a>')+`<section class="card legal-editor"><p>Название, город, описание и логотип будут видны посетителям сайта. Добавляйте заведение после согласования публичного показа с его представителем. Учебные материалы, контакты сотрудников и результаты сюда не попадают.</p><form id="showcase-form"><div data-showcase-entries></div><button type="button" class="btn soft" data-showcase-add>${'Добавить заведение'}</button><label class="check-label section-space"><input type="checkbox" name="permission_confirmed" value="yes"><span>Публичный показ названий и логотипов согласован с представителями выбранных заведений</span></label><p class="footnote">До 12 заведений. Если список пуст, блок на главной скрыт. Загруженные, но не опубликованные логотипы доступны только владельцу.</p><div class="actions">${btn('Сохранить на главной','check','primary','type="submit"')}</div></form></section><section class="card section-space showcase-preview"><h2>Предпросмотр кольца</h2><p class="muted">Изменения станут публичными после сохранения.</p><div data-showcase-preview></div></section>`;
 const form=$('#showcase-form',root);
 function collect(){items=$$('[data-showcase-entry]',root).map(row=>({organization_id:Number($('[name=organization_id]',row).value),name:$('[name=name]',row).value.trim(),city:$('[name=city]',row).value.trim(),description:$('[name=description]',row).value.trim(),logo_id:items[Number(row.dataset.showcaseEntry)]?.logo_id||null}));}
 function preview(){stopPreview();const rows=items.filter(x=>x.name).map(x=>({...x,logo:x.logo_id?'/api/owner/showcase/logos/'+x.logo_id:null}));$('[data-showcase-preview]',root).innerHTML=rows.length?orbitMarkup(rows):'<p class="muted">Добавьте заведение, чтобы увидеть кольцо.</p>';stopPreview=mountOrbit($('[data-showcase-preview]',root),rows);}
 function render(){
  $('[data-showcase-entries]',root).innerHTML=items.map((item,i)=>`<fieldset class="pricing-editor-tier" data-showcase-entry="${i}"><legend>Заведение ${i+1}</legend><label class="field"><span>Подключённое заведение</span><select name="organization_id" required><option value="">Выберите заведение</option>${data.venues.map(v=>`<option value="${v.id}" ${v.id===item.organization_id?'selected':''} ${!['active','read_only'].includes(v.status)?'disabled':''}>${esc(v.name)}</option>`).join('')}</select></label>${field('name','Публичное название',item.name,'text','required minlength="2" maxlength="100"')}${field('city','Город',item.city,'text','maxlength="80"')}${field('description','Формат заведения',item.description,'text','maxlength="100" placeholder="Например, коктейльный бар"')}<div class="showcase-logo-picker">${item.logo_id?`<img src="/api/owner/showcase/logos/${esc(item.logo_id)}" alt="Предпросмотр логотипа" width="72" height="72">`:''}<label class="field"><span>Логотип JPEG, PNG или WebP до 4 МБ</span><input type="file" accept="image/jpeg,image/png,image/webp" data-showcase-logo="${i}"></label>${item.logo_id?`<button type="button" class="btn ghost sm" data-logo-remove="${i}">Убрать логотип</button>`:''}</div><div class="actions"><button type="button" class="btn soft sm" data-showcase-up="${i}" ${i===0?'disabled':''} aria-label="Переместить заведение ${i+1} выше">↑ Выше</button><button type="button" class="btn soft sm" data-showcase-down="${i}" ${i===items.length-1?'disabled':''} aria-label="Переместить заведение ${i+1} ниже">↓ Ниже</button><button type="button" class="btn ghost sm" data-showcase-remove="${i}">Убрать из списка</button></div></fieldset>`).join('');
  $('[data-showcase-add]',root).disabled=items.length>=12;preview();
 }
 form.addEventListener('input',()=>{state.dirty=true;collect();preview()});
 form.addEventListener('change',async event=>{
  const input=event.target;
  if(input.name==='organization_id'){const row=input.closest('[data-showcase-entry]'),name=$('[name=name]',row);if(!name.value)name.value=data.venues.find(v=>v.id===Number(input.value))?.name||'';collect();preview()}
  if(!input.hasAttribute('data-showcase-logo'))return;
  const file=input.files?.[0];if(!file)return;if(uploading){toast('Дождитесь загрузки логотипа',true);return}
  if(file.size>4*1024*1024){toast('Логотип должен быть не больше 4 МБ',true);input.value='';return}
  collect();uploading=true;const index=Number(input.dataset.showcaseLogo);form.setAttribute('aria-busy','true');$$('button,input,select',form).forEach(x=>x.disabled=true);
  try{const body=new FormData();body.append('file',file);const response=await fetch('/api/owner/showcase/logo',{method:'POST',credentials:'same-origin',signal:controller.signal,headers:{'x-csrf-token':state.me.csrf},body});const result=await response.json();if(ticket!==state.renderTicket)return;if(!response.ok)throw new Error(result.detail||'Не удалось загрузить логотип');items[index].logo_id=result.logo_id;state.dirty=true;toast('Логотип подготовлен. Сохраните список для публикации.')}catch(error){if(error.name!=='AbortError'&&ticket===state.renderTicket)toast(error.message,true)}finally{uploading=false;if(ticket!==state.renderTicket)return;form.removeAttribute('aria-busy');$$('button,input,select',form).forEach(x=>x.disabled=false);render()}
 });
 form.addEventListener('click',event=>{if(uploading)return;const button=event.target.closest('button');if(!button)return;collect();let changed=true;
  if(button.hasAttribute('data-showcase-add')){if(items.length>=12)return;items.push({organization_id:0,name:'',city:'',description:'',logo_id:null})}
  else if(button.hasAttribute('data-showcase-remove'))items.splice(Number(button.dataset.showcaseRemove),1);
  else if(button.hasAttribute('data-logo-remove'))items[Number(button.dataset.logoRemove)].logo_id=null;
  else if(button.hasAttribute('data-showcase-up')){const i=Number(button.dataset.showcaseUp);if(i>0)[items[i-1],items[i]]=[items[i],items[i-1]]}
  else if(button.hasAttribute('data-showcase-down')){const i=Number(button.dataset.showcaseDown);if(i<items.length-1)[items[i],items[i+1]]=[items[i+1],items[i]]}
  else changed=false;
  if(changed){state.dirty=true;render()}
 });
 bindForm('#showcase-form',async d=>{if(uploading)throw new Error('Дождитесь загрузки логотипа');collect();data=await api('/owner/showcase','PUT',{version:data.version,items,permission_confirmed:d.get('permission_confirmed')==='yes'});items=data.items.map(x=>({...x}));state.dirty=false;toast('Заведения на главной обновлены');render()},root);
 render();pageCleanup(()=>{stopPreview();controller.abort()},ticket);
}
