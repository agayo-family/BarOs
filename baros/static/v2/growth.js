import {petEyes} from './pet-eyes.js?v=2.14.0';
import {$,$$,state,api,esc,icon,btn,pageHead,badge,progress,modal,on,toast,fmtDate,positionTags} from './core.js?v=2.14.0';
let lastReaction=null;
let catalogue=null,flight=null,phraseTimer=null,accountId=null;
const stages=level=>level>=8?3:level>=4?2:1;
const sprite=(p,level=1)=>`/static/v2/pets/${p.id}-${stages(level)}.svg`;
const petFor=id=>catalogue?.pets.find(x=>x.id===id);
const itemFor=id=>catalogue?.shop.find(x=>x.id===id);
export function companionName(){return petFor(state.growth?.pet_id)?.name||'Питомец'}
export const rewardNotice=r=>{if(!r)return;if(r.xp||r.gold)toast(`+${r.xp} опыта · +${r.gold} золота${r.achievements?.length?' · '+r.achievements.join(', '):''}`);window.dispatchEvent(new Event('baros:growth'))};
async function getCatalog(){if(!catalogue)catalogue=await api('/growth/catalog');return catalogue}
const shopSlots={
 avatar_frame:['Рамки','camera'],wings:['Крылья','spark'],artifact:['Артефакты','shield'],
 headwear:['Головные уборы','trophy'],collar:['Платки и ошейники','heart'],
 aura:['Сияние','sun'],backdrop:['Фоны','image'],badge:['Значки','star'],
};
const gesture={
 ember:['flap',8],aurora:['flap',9.5],moss:['twitch',11],tide:['wave',8.5],moon:['tilt',10],
 storm:['flap',10.5],prism:['glide',12],clock:['tilt',9],ink:['twitch',8.8],
 snow:['stomp',12.5],star:['wave',11.5],sprout:['twitch',9.8],sand:['glide',10.8],forge:['stomp',9.4],dream:['wave',13],
};
const frameStyle=inventory=>itemFor(inventory?.avatar_frame)?.style||'';
const profileBadge=inventory=>{
 const item=itemFor(inventory?.badge);
 return item?`<span class="profile-cosmetic-badge badge-${item.style}" title="${esc(item.name)}" aria-label="${esc(item.name)}">${icon(item.style==='clover'?'spark':'star')}</span>`:'';
};
export function petFigure(p,level=1,equipped={},compact=false){
 if(!p)return '';
 const gear=['wings','artifact','headwear','collar','aura','backdrop'].map(slot=>itemFor(equipped[slot]));
 const classes=gear.filter(Boolean).map(i=>i.slot+'-'+i.style).join(' ');
 const stage=stages(level),[move,speed]=gesture[p.id]||gesture.dream;
 const eyes=(petEyes[p.id]?.[stage-1]||[]).map(([x,y,color])=>`<span class="pet-blink" style="--eye-x:${(x-1)*100/48}%;--eye-y:${(y-1)*100/48}%;--face:${color}"></span>`).join('');
 return `<div class="pet-figure stage-${stage} ${classes} ${compact?'pet-compact':''}" style="--pet-color:${p.color};--pet-gesture:idle-${move};--pet-cycle:${speed}s">
 ${gear[5]?'<span class="pet-backdrop"></span>':''}<div class="pet-idle">
 <span class="pet-aura" aria-hidden="true"></span>${gear[0]?'<span class="pet-wings" aria-hidden="true"></span>':''}
 <div class="pet-frame"><img class="pet-sprite" src="${sprite(p,level)}" alt="${esc(p.name)}" width="192" height="192" loading="lazy">${eyes}</div>
 ${gear[1]?'<span class="pet-artifact" aria-hidden="true"></span>':''}
 ${gear[2]?'<span class="pet-hat" aria-hidden="true"></span>':''}
 ${gear[3]?'<span class="pet-collar" aria-hidden="true"></span>':''}
 </div></div>`;
}

export async function teamPage(root){
 const [staff]=await Promise.all([api('/growth/team'),getCatalog()]);
 root.innerHTML=pageHead('Команда','Коллеги вашего заведения.')+
  `<label class="field team-search"><span class="sr-only">Найти коллегу</span><input type="search" placeholder="Имя коллеги" data-team-search></label>
  <div class="grid-3" data-team-members></div>`;
 function draw(query=''){
  $('[data-team-members]',root).innerHTML=staff.filter(member=>member.name.toLocaleLowerCase('ru').includes(query))
   .map(member=>{
    const pet=petFor(member.pet_id);
    const initials=member.name.split(/\s+/).slice(0,2).map(word=>word[0]).join('');
    return `<article class="card team-member"><div class="row">
    <div class="profile-avatar framed-avatar frame-${frameStyle(member.decorations)}">
     ${member.avatar_url?`<img src="${esc(member.avatar_url)}" alt="" loading="lazy" width="64" height="64">`:esc(initials)}</div>
    <div><h2>${esc(member.name)} ${profileBadge(member.decorations)}</h2><div class="tags">${positionTags(member.positions)}</div></div></div>
    ${pet?`<div class="team-pet">${petFigure(pet,1,{},true)}<div><strong>${esc(pet.name)}</strong><small>${esc(pet.species)}</small></div></div>`:''}</article>`;
   }).join('')||'<p class="muted">Коллеги не найдены.</p>';
 }
 draw();
 $('[data-team-search]',root).addEventListener('input',e=>draw(e.target.value.trim().toLocaleLowerCase('ru')));
}
function money(gold){return `<span class="gold-count"><span aria-hidden="true" class="gold-coin">B</span>${gold} золота</span>`}
export async function profilePage(root){
 const ticket=state.renderTicket;const [p]=await Promise.all([api('/growth'),getCatalog()]);if(ticket!==state.renderTicket)return;state.growth=p;
 let tab='journey',shopSlot='all';
 const draw=()=>{
  const pet=petFor(p.pet_id);const hue=[255,225,185,145,40,285][Math.min(5,Math.floor((p.level-1)/3))];
  root.innerHTML=pageHead('Мой профиль','Знания помогают на смене. Спутник и награды поддерживают ваш путь.',`<a class="btn soft" href="/app/settings">${icon('settings')}Настройки</a>`,'ВАШ ПУТЬ В BAROS')+`<section class="profile-hero card" style="--profile-hue:${hue}"><div class="profile-identity"><div class="profile-avatar framed-avatar frame-${frameStyle(p.equipped)}">${p.avatar_url?`<img src="${esc(p.avatar_url)}" alt="Ваша аватарка" width="88" height="88">`:`<span>${esc(p.name.split(/\s+/).slice(0,2).map(s=>s[0]).join(''))}</span>`}<label class="avatar-change" title="Загрузить аватарку">${icon('camera')}<input type="file" data-avatar accept="image/jpeg,image/png,image/webp" aria-label="Загрузить аватарку"></label></div><div><h2>${esc(p.name)} ${profileBadge(p.equipped)}</h2><div class="profile-level">${badge('Уровень '+p.level,'purple')}${money(p.gold)}</div><p>${p.xp} опыта · до следующего уровня ${p.next-p.progress}</p>${progress(p.percent)}${p.avatar_url?btn('Убрать аватарку','close','text sm','data-remove-avatar'):''}</div></div><div class="profile-pet-mini">${pet?petFigure(pet,p.pet_level,p.equipped):'<div class="pet-placeholder">'+icon('spark')+'</div>'}<div><strong>${pet?esc(pet.name):'Спутник ещё не выбран'}</strong><small>${pet?'Уровень '+p.pet_level+' · '+(stages(p.pet_level)===1?'Малыш':stages(p.pet_level)===2?'Исследователь':'Хранитель'):'15 существ со своей историей'}</small></div></div></section><div class="profile-tabs" role="tablist" aria-label="Разделы профиля">${[['journey','Достижения','spark'],['pet','Мой питомец','heart'],['shop','Магазин','bag']].map(([id,name,ic])=>`<button class="btn ${tab===id?'primary':'ghost'}" role="tab" id="profile-tab-${id}" aria-controls="profile-panel" tabindex="${tab===id?0:-1}" aria-selected="${tab===id}" data-profile-tab="${id}">${icon(ic)}${name}</button>`).join('')}</div><div class="profile-panel" id="profile-panel" role="tabpanel" aria-labelledby="profile-tab-${tab}">${tab==='journey'?achievements(p):tab==='pet'?petPanel(p):shopPanel(p,shopSlot)}</div><p class="footnote">Золото — внутренняя награда, его нельзя купить или вывести. Предметы меняют внешний вид и не влияют на оценки. Питомец получает опыт вместе с вами и не теряет его за перерывы. Дневной предел: ${p.daily_limits.xp} опыта и ${p.daily_limits.gold} золота (сброс в 03:00 по Москве).</p>`;
  on('[data-profile-tab]','click',(_,b)=>{tab=b.dataset.profileTab;draw();$(`[data-profile-tab="${tab}"]`,root)?.focus({preventScroll:true})},root);
  on('[data-shop-slot]','click',(_,b)=>{
   shopSlot=b.dataset.shopSlot;draw();$('[data-shop-slot='+shopSlot+']',root)?.focus({preventScroll:true});
  },root);
  on('[data-pet-picker]','click',()=>pickPet(p,draw),root);
  on('[data-buy]','click',async(_,b)=>{b.disabled=true;try{Object.assign(p,await api('/growth/buy','POST',{item_id:b.dataset.buy}));state.growth=p;draw();toast('Предмет в вашей коллекции')}finally{b.disabled=false}},root);
  on('[data-equip]','click',async(_,b)=>{b.disabled=true;Object.assign(p,await api('/growth/equip','PUT',{slot:b.dataset.slot,item_id:b.dataset.equip||null}));state.growth=p;draw();await syncCompanion(false)},root);
  on('[data-companion-enabled]','change',async(_,b)=>{await api('/growth/preferences','PUT',{companion_enabled:b.checked});p.companion_enabled=b.checked;state.growth=p;await syncCompanion(false)},root);
  on('[data-remove-avatar]','click',async()=>{await api('/growth/avatar','DELETE');p.avatar_url=null;draw()},root);
  on('[data-avatar]','change',async(_,input)=>{const file=input.files?.[0];if(!file)return;if(file.size>5*1024*1024)throw new Error('Аватар: максимум 5 МБ');const data=new FormData();data.append('file',file);input.disabled=true;try{Object.assign(p,await api('/growth/avatar','POST',data));state.growth=p;draw();toast('Аватарка сохранена')}finally{input.disabled=false}},root);
 };
 draw();
}
function achievements(p){return `<div class="profile-achievement-grid">${p.achievements.map(a=>`<article class="card achievement ${a.earned_at?'earned':''}"><div class="achievement-icon">${icon(a.icon)}</div><div><h3>${esc(a.name)}</h3><p>${esc(a.description)}</p>${a.earned_at?`<small>${icon('check')} Получено ${fmtDate(a.earned_at)}</small>`:`<small>${a.progress} / ${a.target}</small>${progress(a.progress/a.target*100)}`}</div></article>`).join('')}</div>`}
function petPanel(p){const pet=petFor(p.pet_id);return pet?`<section class="card pet-home"><div class="pet-stage" style="--pet-color:${pet.color}">${petFigure(pet,p.pet_level,p.equipped)}<span class="pet-stage-shadow" aria-hidden="true"></span></div><div><span class="eyebrow">${esc(pet.species)}</span><h2>${esc(pet.name)}</h2><p>${esc(pet.lore)}</p><div class="pet-growth-label">${badge('Уровень '+p.pet_level,'purple')}<span>${p.pet_progress.progress} / ${p.pet_progress.next} опыта</span></div>${progress(p.pet_progress.percent)}<p class="muted">Теория, карточки, попытки тестов и игры помогают ему расти. Успешные тесты дают больше опыта. Новый облик открывается на 4 и 8 уровнях.</p><a class="btn primary" href="/app/mentor">${icon('book')}Поговорить с ${esc(pet.name)}</a><label class="check-label"><input type="checkbox" data-companion-enabled ${p.companion_enabled?'checked':''}>Показывать спутника на страницах</label>${p.pet_swaps_left?btn('Выбрать другого','refresh','soft','data-pet-picker'):badge('Единственная смена использована','outline')}<p class="footnote">Питомца можно поменять один раз. Новый начнёт с 1 уровня; ваш уровень, золото и покупки сохранятся.</p></div></section>`:`<section class="card pet-empty"><div class="pet-preview-strip">${catalogue.pets.slice(0,5).map(x=>petFigure(x)).join('')}</div><h2>Кто будет рядом с вами?</h2><p>Спокойный хранитель, любопытный дракон или ткач сновидений — выберите характер, который вам близок.</p>${btn('Выбрать спутника','spark','primary','data-pet-picker')}<p class="footnote">Выбор добровольный. Обучение доступно и без питомца.</p></section>`}
function shopPanel(p,slot){
 const pet=petFor(p.pet_id)||catalogue.pets[0];
 const catalog=catalogue.shop.filter(item=>slot==='all'||item.slot===slot);
 return `<div class="shop-head"><h2>Магазин</h2>${money(p.gold)}</div>
  <div class="shop-categories" aria-label="Категории магазина">${[['all',['Все предметы','bag']],...Object.entries(shopSlots)].map(([key,[label,visual]])=>
   `<button class="btn ${slot===key?'soft':'ghost'}" data-shop-slot="${key}" aria-pressed="${slot===key}">${icon(visual)} ${label}</button>`).join('')}</div>
  <div class="shop-grid">${catalog.map(item=>{
   const owned=p.inventory.includes(item.id),equipped=p.equipped[item.slot]===item.id;
   const needsPet=!p.pet_id&&!['avatar_frame','badge'].includes(item.slot);
   const art=item.slot==='avatar_frame'?`<div class="profile-avatar framed-avatar frame-${item.style}">${icon('user')}</div>`:
    item.slot==='badge'?profileBadge({badge:item.id}):petFigure(pet,2,{[item.slot]:item.id},true);
   const purchase=p.level<item.level?'С уровня '+item.level:needsPet?'Выберите питомца':p.gold<item.price?'Не хватает золота':'Купить';
   return `<article class="card shop-item">
    <div class="shop-item-art item-${item.style}" aria-hidden="true">${art}</div>
    <small class="muted">${shopSlots[item.slot][0]}</small><h3>${esc(item.name)}</h3><p>${esc(item.description)}</p>
    <small>${item.price} золота · уровень ${item.level}+</small>
    ${owned?btn(equipped?'Снять':'Надеть',equipped?'close':'check',equipped?'soft':'primary',`data-equip="${equipped?'':item.id}" data-slot="${item.slot}"`):
    btn(purchase,'bag','primary',`data-buy="${item.id}" ${p.level<item.level||p.gold<item.price||needsPet?'disabled':''}`)}
   </article>`;
  }).join('')}</div>`;
}
function pickPet(p,draw){const swapping=!!p.pet_id;const m=modal(swapping?'Смена спутника':'Выберите своего спутника',`<p>${swapping?'Это единственная смена. Новый питомец начнёт с 1 уровня.':'Каждый спутник поддерживает вас по-своему. Выберите того, чья история близка.'}</p><div class="pet-picker-grid">${catalogue.pets.map(x=>`<article class="pet-option ${p.pet_id===x.id?'selected':''}">${petFigure(x)}<div><h3>${esc(x.name)}</h3><small>${esc(x.species)}</small><p>${esc(x.lore)}</p></div>${btn(p.pet_id===x.id?'Ваш спутник':'Выбрать','check',p.pet_id===x.id?'soft':'primary',`data-choose-pet="${x.id}" ${p.pet_id===x.id?'disabled':''}`)}</article>`).join('')}</div>`,{wide:true});on('[data-choose-pet]','click',(_,b)=>{const pet=petFor(b.dataset.choosePet);m.close();const confirm=modal('Ваш спутник — '+pet.name,petFigure(pet)+`<p>${esc(pet.lore)}</p><p>${swapping?'Подтверждая, вы используете единственную смену и начнёте развитие нового питомца с первого уровня.':'Питомец будет расти вместе с вашими знаниями. Позднее его можно заменить один раз.'}</p>`+btn('Подтвердить выбор','check','primary','data-confirm-pet'));on('[data-confirm-pet]','click',async(_,button)=>{button.disabled=true;try{Object.assign(p,await api('/growth/pet','POST',{pet_id:pet.id,confirm_swap:swapping}));state.growth=p;confirm.close();draw();await syncCompanion(false);toast(pet.name+' теперь с вами')}finally{button.disabled=false}},confirm.root)},m.root)}
function nextPhrase(pet){const key=`baros:phrases:${accountId}:${pet.id}`;let used=[];try{used=JSON.parse(localStorage.getItem(key)||'[]')}catch{}if(!Array.isArray(used))used=[];let free=pet.phrases.map((_,i)=>i).filter(i=>!used.includes(i));if(!free.length){used=used.slice(-3);free=pet.phrases.map((_,i)=>i).filter(i=>!used.includes(i))}const index=free[Math.floor(Math.random()*free.length)];try{localStorage.setItem(key,JSON.stringify([...used,index]))}catch{}return pet.phrases[index]}
export function clearCompanion(){document.querySelector('#companion-root')?.remove();clearTimeout(phraseTimer);state.growth=null;accountId=null}
export async function syncCompanion(refresh=true){
 const a=state.me?.account;if(!a){clearCompanion();return}if(flight)await flight;if(state.me?.account?.id!==a.id)return;
 const task=(async()=>{try{if(accountId!==a.id){state.growth=null;accountId=a.id}if(refresh||!state.growth){const previous=state.growth;const growth=await api('/growth');if(state.me?.account?.id!==a.id)return;if(state.growth===previous)state.growth=growth}if(state.me?.account?.id!==a.id)return;const p=state.growth;if(!p)return;if(p.pet_id)await getCatalog();if(state.me?.account?.id!==a.id||!location.pathname.startsWith('/app'))return;const pet=petFor(p.pet_id);document.querySelector('#companion-root')?.remove();if(!pet||!p.companion_enabled)return;
  const root=document.createElement('aside');root.id='companion-root';root.className='companion-root';root.setAttribute('aria-label','Спутник обучения');root.innerHTML=`<div class="companion-popover" hidden><button class="btn icon-only ghost companion-close" data-companion-close aria-label="Скрыть сообщение">${icon('close')}</button><div class="companion-animation"><span class="companion-effect" aria-hidden="true" style="--pet-color:${pet.color}">${trickVisual(pet.id)}</span>${petFigure(pet,p.pet_level,p.equipped)}</div><strong>${esc(pet.name)}</strong><p data-companion-phrase role="status" aria-live="polite"></p><a href="/app/mentor" class="btn primary sm">${icon('book')}Поговорить со мной</a><a href="/app/profile" class="btn text sm">Профиль спутника ${icon('arrow')}</a></div><button class="companion-bubble" aria-label="${esc(pet.name)}: поддержка" aria-expanded="false"><img src="${sprite(pet,p.pet_level)}" alt="" width="48" height="48"></button>`;if(document.querySelector('.modal')||document.querySelector('#sidebar.open')){root.inert=true;root.setAttribute('inert','')}document.body.append(root);
  const bubble=$('.companion-bubble',root),popover=$('.companion-popover',root);const close=()=>{popover.hidden=true;bubble.setAttribute('aria-expanded','false');clearTimeout(phraseTimer)};
  bubble.onclick=()=>{popover.hidden=false;bubble.setAttribute('aria-expanded','true');const trick=Math.random()<.05;popover.classList.toggle('pet-trick',trick);popover.dataset.trick=pet.id;$('[data-companion-phrase]',root).textContent=trick?pet.trick+'. '+nextPhrase(pet):lastReaction==='mistake'?'Я рядом. Разберём одну важную деталь и попробуем снова.':lastReaction==='success'?'Хороший шаг! Давай закрепим, почему этот ответ подходит.':nextPhrase(pet);lastReaction=null;clearTimeout(phraseTimer);phraseTimer=setTimeout(close,18000)};
  $('[data-companion-close]',root).onclick=close;root.onkeydown=e=>{if(e.key==='Escape'){close();bubble.focus()}};
 }catch{}})();flight=task;try{return await task}finally{if(flight===task)flight=null}
}
window.addEventListener('baros:pet-react',e=>{lastReaction=e.detail?.kind;const b=document.querySelector('.companion-bubble');if(b){b.classList.add('pet-react');setTimeout(()=>b.classList.remove('pet-react'),1600)}});
window.addEventListener('baros:growth',()=>syncCompanion(true));

function trickVisual(id){
 const arts={
 ember:'<path d="M16 70 34 32 60 20 86 35 105 62"/><path d="m30 30 4-9 4 9 9 3-9 3-4 9-4-9-9-3Z M59 17l2-7 3 7 7 3-7 3-3 7-2-7-7-3Z M86 33l3-8 3 8 8 3-8 3-3 8-3-8-8-3Z"/>',
 aurora:'<path d="M60 85Q6 68 12 22 47 42 60 85Q4 50 30 8 56 34 60 85Q44 9 60 4 76 9 60 85Q64 34 90 8 116 50 60 85Q73 42 108 22 114 68 60 85Z"/>',
 moss:'<path d="M60 106V23M60 72 30 50 18 27M60 54 89 32 102 10M60 84 90 64 102 44M60 42 42 21 44 8M30 50 12 52M90 64l20 3"/><circle cx="18" cy="27" r="6"/><circle cx="102" cy="10" r="5"/><circle cx="44" cy="8" r="5"/>',
 tide:'<ellipse cx="60" cy="83" rx="54" ry="18"/><ellipse cx="60" cy="72" rx="39" ry="13"/><path d="M5 43Q20 28 35 43T65 43T95 43T125 43"/>',
 moon:'<path d="M22 10a12 12 0 1 0 11 16A11 11 0 0 1 22 10Z M95 22a13 13 0 1 0 12 18A12 12 0 0 1 95 22Z M65 2a10 10 0 1 0 9 14A9 9 0 0 1 65 2Z"/>',
 storm:'<path d="M80 5 45 40 61 40 31 85 76 51 61 51 94 11 M15 22 30 27 45 22M90 81l20 6"/>',
 prism:'<path d="M60 88 8 27M60 88 25 17M60 88 42 10M60 88 60 5M60 88 78 10M60 88 95 17M60 88 112 27"/><path d="m50 15 10-12 10 12-10 12Z m40 15 8-10 8 10-8 10Z m-30 0 8-10 8 10-8 10Z"/>',
 clock:'<path d="M35 5h50M35 110h50M40 5v15l35 80v10M80 5v15l-35 80v10"/><circle cx="50" cy="29" r="3"/><circle cx="67" cy="44" r="3"/><circle cx="57" cy="65" r="3"/><circle cx="65" cy="85" r="3"/>',
 ink:'<path d="M12 12h76l18 19v70H12Z M88 12v21h18M26 27h37M26 43h58M26 58h40M26 76h59M26 89h32"/>',
 snow:'<path d="M14 99V56h14V36h15v20h15V19h18v37h14V36h14v63ZM20 12v16M12 20h16M96 9v14M89 16h14"/>',
 star:'<path d="M14 67 32 25 66 14 98 34 108 75 76 104 40 96Z"/><circle cx="32" cy="25" r="5"/><circle cx="66" cy="14" r="4"/><circle cx="98" cy="34" r="5"/><circle cx="76" cy="104" r="4"/>',
 sprout:'<path d="M60 105V40M60 72Q15 42 15 70q25 18 45 2M60 89q45-36 45-8-25 18-45 8"/><circle cx="60" cy="32" r="11"/><circle cx="42" cy="23" r="14"/><circle cx="76" cy="17" r="14"/><circle cx="80" cy="43" r="14"/><circle cx="43" cy="49" r="14"/>',
 sand:'<path d="M18 105V65a42 42 0 0 1 84 0v40M29 105V65a31 31 0 0 1 62 0v40"/><circle cx="9" cy="72" r="2"/><circle cx="33" cy="9" r="2"/><circle cx="102" cy="14" r="3"/>',
 forge:'<path d="m60 10 43 15v35q0 30-43 50Q17 90 17 60V25Z M60 26v63M33 47h54"/>',
 dream:'<path d="M5 98Q60-50 115 98M14 98Q60-28 106 98M24 98Q60-5 96 98M33 98Q60 17 87 98M42 98Q60 40 78 98"/>',
 };
 return `<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${arts[id]||arts.ember}</svg>`;
}
