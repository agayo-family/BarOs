export const $=(s,root=document)=>root.querySelector(s);
export const $$=(s,root=document)=>[...root.querySelectorAll(s)];
export const state={me:null,org:localStorage.getItem('baros:venue')||'',dirty:false,cleanup:null,renderTicket:0};
export function pageCleanup(callback,ticket){if(ticket!==state.renderTicket){callback();return}state.cleanup=callback}
export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons={
 camera:'<path d="M4 6h4l2-3h4l2 3h4v14H4z"/><circle cx="12" cy="12" r="4"/>',
 heart:'<path d="M12 21C5 16 2 12 3 7c1-4 7-5 9-1 2-4 8-3 9 1 1 5-2 9-9 14Z"/>',
 bag:'<path d="M5 7h14l1 14H4L5 7Z"/><path d="M9 9V6a3 3 0 0 1 6 0v3"/>',

 games:'<path d="M8 7h8c3 0 5 5 5 9 0 3-3 3-5 0H8c-2 3-5 3-5 0 0-4 2-9 5-9Z"/><path d="M7 10v5M4.5 12.5h5M16 11h.01M18 14h.01M12 7V3"/>',brain:'<path d="M12 4c-3-3-7 0-6 3-4 1-4 6-1 7-2 4 3 8 7 5 4 3 9-1 7-5 3-1 3-6-1-7 1-3-3-6-6-3ZM12 4v15M7 8l2 2M5 14h3M17 8l-2 2M19 14h-3"/>',blocks:'<rect x="3" y="4" width="8" height="6" rx="2"/><rect x="13" y="4" width="8" height="6" rx="2"/><rect x="3" y="14" width="5" height="6" rx="2"/><rect x="10" y="14" width="11" height="6" rx="2"/>',route:'<circle cx="5" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M7 5h9a4 4 0 0 1 0 8H8a3 3 0 0 0 0 6h9"/>',
 cards:'<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M2 7v12M22 5v12M9 9h6M9 13h4"/>',moon:'<path d="M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z"/>',sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1"/>',
 dashboard:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
 book:'<path d="M12 5v16M12 5C9 3 5 3 2 4v15c4-1 7-1 10 2 3-3 6-3 10-2V4c-3-1-7-1-10 1Z"/>',
 users:'<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M17 14c3 0 4 2 4 5v2"/>',
 file:'<path d="M13 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V10L13 2Z"/><path d="M13 2v8h8M7 14h10M7 18h7"/>',
 spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4M18 4h4"/>',
 chart:'<path d="M4 3v18h17M8 16v-4M13 16V8M18 16V5"/>',
 settings:'<path d="m9 3-1 3-3 1-1 4 2 2v3l3 2 2 3 4-1 1-3 3-1 1-4-2-2V7l-3-2-2-2-4 1Z"/><circle cx="12" cy="12" r="3"/>',
 bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
 building:'<path d="M4 22V3h13v19M17 9h4v13M8 7h2M8 11h2M8 15h2M13 7h1M13 11h1M10 22v-3h3v3"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',back:'<path d="M19 12H5m5-5-5 5 5 5"/>',
 check:'<path d="m5 12 4 4L19 6"/>',chevron:'<path d="m9 5 7 7-7 7"/>',down:'<path d="m6 9 6 6 6-6"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',target:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
 shield:'<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z"/><path d="m8 12 3 3 5-6"/>',
 search:'<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',download:'<path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5"/>',
 edit:'<path d="m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5"/>',trash:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',archive:'<rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v13h14V8M10 12h4"/>',
 logout:'<path d="M9 4H3v16h6M9 12h13m-5-5 5 5-5 5"/>',menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',close:'<path d="m5 5 14 14M5 19 19 5"/>',
 copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',link:'<path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 -1) scale(.92)"/>',
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',checkcircle:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
 trophy:'<path d="M7 3h10v8a5 5 0 0 1-10 0V3ZM7 5H3v3c0 3 2 5 5 5M17 5h4v3c0 3-2 5-5 5M12 16v5M7 21h10"/>',
 wallet:'<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 7V5l13-3v3M16 11h5v5h-5v-5Z"/>',
 phone:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4M11 19h2"/>',interview:'<path d="M21 12a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4Z"/><path d="M8 9h8M8 13h5"/>',
 eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',refresh:'<path d="M20 8a8 8 0 1 0 1 7M20 3v5h-5"/>',lock:'<rect x="4" y="10" width="16" height="12" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3M12 15v3"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M7 14h3M7 17h3"/>'};
export const icon=(name,cls='')=>`<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${icons[name]||icons.file}</svg>`;
export const brand=()=>`<a href="/app" class="brand"><div class="brandmark">B<span>•</span></div>BarOS<small>2.5</small></a>`;
export const initials=s=>String(s||'?').split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase();
export const avatar=(s,cls='')=>`<div class="avatar ${cls}">${esc(initials(s))}</div>`;
export const badge=(s,cls='')=>`<span class="badge ${cls}">${esc(s)}</span>`;
export const btn=(label,ic='',cls='',attrs='')=>`<button class="btn ${cls}" ${attrs}>${ic?icon(ic):''}${esc(label)}</button>`;
export const notice=(body,cls='',title='')=>`<div class="notice-box ${cls}">${icon(cls==='success'?'checkcircle':'info')}<div>${title?`<strong>${esc(title)}</strong>`:''}<p>${esc(body)}</p></div>`;
export const empty=(title,desc,ic='book',action='')=>`<div class="empty"><div class="icon-box large">${icon(ic)}</div><h3>${esc(title)}</h3><p>${esc(desc)}</p>${action}</div>`;
export const fmtDate=(d,long=false)=>d?new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:long?'long':'short',year:long?'numeric':undefined,timeZone:'Europe/Moscow'}).format(new Date(d)):'—';
export const fmtTime=s=>s==null?'—':s<60?`${s} с`:`${Math.floor(s/60)} мин ${s%60?`${s%60} с`:''}`;
export const percent=(v)=>v==null?'—':`${Math.round(v)}%`;
export const dateValue=s=>s?new Date(s).toISOString().slice(0,10):'';
export const roleName=r=>({owner:'Владелец BarOS',manager:'Управляющий',employee:'Сотрудник'}[r]||r);
export const positionTags=ps=>(ps||[]).map(p=>badge(state.me?.positions?.[p]|| (p==='all'?'Все должности':p),'outline')).join('');
export const progress=(v,cls='')=>`<div class="progress ${cls}"><span style="width:${Math.max(0,Math.min(100,Number(v)||0))}%"></span></div>`;
export const stat=(label,value,foot,ic,cls='')=>`<div class="stat"><div class="stat-top">${esc(label)}${icon(ic)}</div><strong>${esc(value)}</strong><div class="foot ${cls}">${esc(foot)}</div></div>`;
export const pageHead=(title,subtitle,actions='',eyebrow='')=>`<div class="page-head"><div>${eyebrow?`<div class="eyebrow">${esc(eyebrow)}</div>`:''}<h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${actions?`<div class="actions">${actions}</div>`:''}</div>`;
export const search=(placeholder='Поиск…')=>`<label class="search">${icon('search')}<input type="search" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" data-search></label>`;
export const field=(name,label,value='',type='text',attrs='',help='')=>`<label class="field"><span>${esc(label)}</span><input type="${type}" name="${name}" value="${esc(value)}" ${attrs}>${help?`<small>${esc(help)}</small>`:''}</label>`;
export const textarea=(name,label,value='',attrs='',help='')=>`<label class="field"><span>${esc(label)}</span><textarea name="${name}" ${attrs}>${esc(value)}</textarea>${help?`<small>${esc(help)}</small>`:''}</label>`;
export const select=(name,label,values,value)=>`<label class="field"><span>${esc(label)}</span><select name="${name}">${Object.entries(values).map(([v,l])=>`<option value="${esc(v)}" ${String(v)===String(value)?'selected':''}>${esc(l)}</option>`).join('')}</select></label>`;
export const check=(name,label,checked=false)=>`<label class="check-label"><input type="checkbox" name="${name}" ${checked?'checked':''}>${esc(label)}</label>`;
export const positions=(selected=['all'],all=true,name='positions')=>`<div class="check-group">${Object.entries({...all?{all:'Все должности'}:{},...state.me?.positions}).map(([v,l])=>`<label class="check-chip"><input type="checkbox" name="${name}" value="${v}" ${selected.includes(v)?'checked':''}>${esc(l)}</label>`).join('')}</div>`;
export const selected=(form,name='positions')=>$$(`[name="${name}"]:checked`,form).map(x=>x.value);
export function wirePositions(root=document){$$('.check-group',root).forEach(g=>g.addEventListener('change',e=>{if(e.target.value==='all'&&e.target.checked)$$('input',g).filter(x=>x.value!=='all').forEach(x=>x.checked=false);else if(e.target.checked){const all=$('[value="all"]',g);if(all)all.checked=false}}));}
export async function api(path,method='GET',body){
 const headers={}; if(state.me?.csrf)headers['x-csrf-token']=state.me.csrf;if(state.org&&state.me?.account?.role==='owner')headers['x-organization-id']=state.org;
 if(!(body instanceof FormData))headers['content-type']='application/json';
 let res;try{res=await fetch('/api'+path,{method,headers,credentials:'same-origin',body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)})}catch{throw new Error('Нет связи с сервером. Проверьте интернет и повторите действие.')}
 let data;try{data=await res.json()}catch{throw new Error('Сервер не ответил. Подождите немного и повторите.')}
 if(!res.ok){let err=new Error(typeof data.detail==='string'?data.detail:'Не удалось выполнить действие');err.status=res.status;err.fields=data.fields;throw err}return data;
}
export async function reloadMe(ticket){const me=await api('/me');if(ticket===undefined||ticket===state.renderTicket)state.me=me;return me}
export function toast(message,error=false){const el=document.createElement('div');el.className='toast'+(error?' error':'');el.textContent=message;$('#toast-root').append(el);setTimeout(()=>el.remove(),6000)}
export function go(path,replace=false){if(state.dirty&&!confirm('Есть несохранённые изменения. Покинуть редактор?'))return;state.dirty=false;replace?history.replaceState({},'',path):history.pushState({},'',path);window.dispatchEvent(new Event('baros:navigate'));}
export function on(selector,event,callback,root=document){$$(selector,root).forEach(el=>el.addEventListener(event,async e=>{try{await callback(e,el)}catch(err){toast(err.message,true)}}))}
export function modal(title,content,{wide=false}={}){const previous=document.activeElement;const root=$('#modal-root');root.innerHTML=`<div class="modal-backdrop"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button class="btn icon-only ghost" data-close aria-label="Закрыть">${icon('close')}</button></div><div class="modal-body">${content}</div></section></div>`;
 const close=()=>{root.innerHTML='';document.body.style.overflow='';document.removeEventListener('keydown',key);previous?.focus?.()};
 const key=e=>{if(e.key==='Escape')close();if(e.key==='Tab'){const controls=$$('a,button,input,select,textarea,[tabindex="0"]',root).filter(x=>!x.disabled&&!x.hidden);const first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}};
 document.addEventListener('keydown',key);document.body.style.overflow='hidden';$('[data-close]',root).onclick=close;$('.modal-backdrop',root).addEventListener('click',e=>{if(e.target.classList.contains('modal-backdrop'))close()});wirePositions(root);setTimeout(()=>($('input:not([type=checkbox]),textarea,select',root)||$('[data-close]',root))?.focus(),50);return {root,close};}
export function bindForm(selector,submit,root=document){const form=$(selector,root);form.addEventListener('submit',async e=>{e.preventDefault();$('.form-error',form)?.remove();const submitters=$$('button[type=submit]',form);submitters.forEach(b=>{b.disabled=true;b.dataset.old=b.innerHTML;b.innerHTML='<span class="spinner"></span> Сохраняем…'});try{await submit(new FormData(form),form)}catch(err){const el=document.createElement('div');el.className='form-error';el.textContent=err.message+(err.fields?.length?' · '+err.fields.join('; '):'');form.prepend(el);el.scrollIntoView({block:'nearest'});}finally{submitters.forEach(b=>{b.disabled=false;b.innerHTML=b.dataset.old})}})}
export async function copy(text){try{await navigator.clipboard.writeText(text);toast('Скопировано')}catch{modal('Скопируйте текст',`<div class="secret-box">${esc(text)}</div>`)}}
export const absolute=path=>new URL(path,location.origin).href;
export function showLink(title,url,detail='Ссылка одноразовая. Передайте её получателю лично.'){const m=modal(title,`<p class="lead">${esc(detail)}</p><div class="secret-box">${esc(absolute(url))}</div><div class="modal-actions">${btn('Скопировать ссылку','copy','primary','data-copy')}</div>`);$('[data-copy]',m.root).onclick=()=>copy(absolute(url));}
export function setOrg(id){state.org=String(id);localStorage.setItem('baros:venue',state.org)}
export async function download(path,name){const res=await fetch('/api'+path,{credentials:'same-origin',headers:state.org&&state.me.account.role==='owner'?{'x-organization-id':state.org}:{}});if(!res.ok){const j=await res.json();throw new Error(j.detail||'Не удалось скачать')};const blob=await res.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500)}
export function hero(title,desc,action='',eyebrow='АКАДЕМИЯ КОМАНДЫ'){return `<div class="hero"><div><div class="eyebrow">${esc(eyebrow)}</div><h2>${esc(title)}</h2><p>${esc(desc)}</p>${action}</div><div class="hero-graphic" aria-hidden="true"><div class="orb"><div class="paper">${icon('book')}<i></i><i></i><i></i></div><span class="spark">${icon('spark')}</span><span class="check">${icon('check')}</span></div></div></div>`}
export const ring=(value,label)=>`<div class="ring" style="--value:${Math.min(100,Math.max(0,value||0))}"><div><strong>${Math.round(value||0)}%</strong><small>${esc(label)}</small></div></div>`;
