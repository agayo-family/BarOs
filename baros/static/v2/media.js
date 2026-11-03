import {esc,api,toast} from './core.js?v=2.13.3';

export function mediaText(value){
 const text=String(value||''),re=/!\[([^\]\n]{0,200})\]\((\/api\/media\/[A-Za-z0-9_-]{20,80})\)/g;let out='',at=0;
 const plain=s=>esc(s).replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>');
 for(const m of text.matchAll(re)){out+=plain(text.slice(at,m.index))+`<span class="course-photo"><img src="${esc(m[2])}" alt="${esc(m[1]||'Иллюстрация к обучению')}" loading="lazy" decoding="async"></span>`;at=m.index+m[0].length}
 return out+plain(text.slice(at));
}

export function photoPicker(target,{global=false}={}){
 if(!target||target.dataset.photoReady)return;target.dataset.photoReady='1';
 const box=document.createElement('div');box.className='photo-picker';
 box.innerHTML='<button type="button" class="btn soft photo-upload" data-photo-trigger>Добавить фото</button><input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Выбрать фото для обучения" hidden><label class="photo-description">Описание фото<input type="text" maxlength="150" placeholder="Например, внешний вид бокала"></label><small>JPEG, PNG или WebP до 8 МБ. В вопросе описание не должно подсказывать ответ.</small><div class="photo-preview"></div>';
 target.closest('label')?.insertAdjacentElement('afterend',box);
 const refs=()=>[...target.value.matchAll(/!\[[^\]\n]*\]\(\/api\/media\/[A-Za-z0-9_-]+\)/g)];
 const preview=()=>{const images=refs();box.querySelector('.photo-preview').innerHTML=images.map((m,i)=>'<div class="photo-preview-item">'+mediaText(m[0])+'<button type="button" class="btn ghost" data-photo-remove="'+i+'">Удалить фото из блока</button></div>').join('');box.querySelectorAll('[data-photo-remove]').forEach(b=>b.onclick=()=>{const m=refs()[Number(b.dataset.photoRemove)];if(!m)return;target.value=target.value.slice(0,m.index)+target.value.slice(m.index+m[0].length);target.dispatchEvent(new Event('input',{bubbles:true}))})};target.addEventListener('input',preview);preview();
 const input=box.querySelector('[type=file]'),trigger=box.querySelector('[data-photo-trigger]');trigger.onclick=()=>input.click();input.onchange=async()=>{const file=input.files?.[0];if(!file)return;input.disabled=true;trigger.disabled=true;trigger.textContent='Загружаем фото…';try{if(file.size>8*1024*1024)throw new Error('Размер фото — не больше 8 МБ');const body=new FormData();body.append('file',file);const r=await api('/media'+(global?'?global_asset=true':''),'POST',body);if(!target.isConnected){toast('Фото загружено. Откройте нужный блок и добавьте его снова.',true);return}const alt=(box.querySelector('[type=text]').value||'Иллюстрация к обучению').replace(/[\[\]\n]/g,' ').trim();const next=target.value+'\n\n!['+alt+']('+r.url+')';if(target.maxLength>0&&next.length>target.maxLength)throw new Error('В блоке недостаточно места. Сократите текст перед добавлением фото.');target.value=next;target.dispatchEvent(new Event('input',{bubbles:true}));preview();toast('Фото добавлено в черновик')}catch(e){toast(e.message,true)}finally{input.disabled=false;input.value='';trigger.disabled=false;trigger.textContent='Добавить фото'}};
}
