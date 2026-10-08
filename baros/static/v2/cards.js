import {$,state,pageCleanup,api,esc,icon,btn,pageHead,empty,badge,progress,toast} from './core.js?v=2.3.1';

export async function cardsPage(root,cid=null){const ticket=state.renderTicket;
 const preview=state.me.account.role!=='employee';
 if(!cid){const courses=preview?await api('/courses'):(await api('/learning')).courses;root.innerHTML=pageHead('Карточки',preview?'Предпросмотр карточек ваших курсов. Сотрудникам доступны только опубликованные версии по их должностям.':'Вспомните ответ, переверните карточку и закрепите знание. Это тренировка без оценок и попыток.','','ПРАКТИКА BAROS')+`<div class="grid-3">${courses.length?courses.map(c=>`<article class="card course-card"><div class="icon-box">${icon('cards')}</div><h3>${esc(c.title)}</h3><p>${esc(c.description||'Повторите материал короткими вопросами и ответами.')}</p><div class="course-meta">${badge((preview?c.questions:c.card_count)+' карточек','purple')}${preview?badge(c.published?'Опубликован':'Черновик',c.published?'green':'orange'):''}</div><div class="course-footer"><a class="btn text" href="/app/cards/${c.id}">${preview?'Предпросмотр':'Начать повторение'} ${icon('arrow')}</a></div></article>`).join(''):`<section class="card">${empty('Карточки скоро появятся','Они доступны для опубликованного обучения, назначенного вашим должностям.','cards')}</section>`}</div>`;return}
 let data;if(preview){const course=await api('/courses/'+cid);data={...course,cards:course.questions.map((q,id)=>({id,question:q.prompt,answer:q.choices[q.correct_index],explanation:q.explanation}))}}else data=await api('/learning/'+cid+'/cards');
 root.innerHTML=`<a class="btn text" href="/app/cards">${icon('back')}Все карточки</a>`+pageHead(data.title,'Сначала попробуйте ответить сами. Затем переверните карточку.',badge('Тренировка · v'+data.version,'purple'),'ЗАПОМИНАЕМ ПО ШАГАМ')+`<div class="learning-path"><a href="/app/games/${cid}">${icon('games')}Закрепить в игре</a>${preview?'':`<a href="/app/learn/${cid}">${icon('book')}Вернуться к теории</a>`}</div><div id="practice-deck"></div>`;
 if(ticket!==state.renderTicket)return;mountDeck($('#practice-deck',root),data,{preview,ticket});
}

export function mountDeck(root,data,{preview=false,ticket=state.renderTicket}={}){
 const cards=data.cards||[],key=`baros:cards:${state.me?.account?.id}:${data.revision_id}`;
 let saved={};try{if(!preview)saved=JSON.parse(localStorage.getItem(key)||'{}')}catch{}
 const known=new Set((Array.isArray(saved.known)?saved.known:[]).filter(id=>cards.some(c=>c.id===id)));
 const seen=new Set((Array.isArray(saved.seen)?saved.seen:[]).filter(id=>cards.some(c=>c.id===id)));
 let deck=[...cards],index=0,flipped=false,busy=false,repeat=false,drag=null,timer,disposed=false;
 const reduced=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
 const save=()=>{if(preview)return;try{localStorage.setItem(key,JSON.stringify({known:[...known],seen:[...seen]}))}catch{}};
 const clean=()=>{disposed=true;clearTimeout(timer)};
 const previousCleanup=state.cleanup;pageCleanup(()=>{previousCleanup?.();clean()},ticket);
 function draw(){if(disposed)return;
  if(!deck.length){root.innerHTML=`<section class="card">${empty(cards.length?'Всё повторили':'Карточек пока нет',cards.length?'Вы отметили все карточки как запомненные. Можно повторить весь набор ещё раз.':'Добавьте вопросы в редакторе обучения.','cards',cards.length?btn('Повторить всё','refresh','primary','data-all-cards'):'')}</section>`;const all=$('[data-all-cards]',root);if(all)all.onclick=()=>{repeat=false;deck=[...cards];index=0;draw()};return}
  const c=deck[index];root.innerHTML=`<div class="practice-wrap"><div class="practice-toolbar"><span class="muted tiny" aria-live="polite">Карточка ${index+1} из ${deck.length}</span><div class="row">${btn('Перемешать','refresh','sm ghost','data-shuffle')}${btn(repeat?'Все карточки':'Повторить сложные','cards','sm soft','data-repeat')}</div></div><div class="practice-progress"><span>Запомнил(а): ${known.size} / ${cards.length}</span>${progress(known.size/Math.max(1,cards.length)*100)}</div><div class="practice-stage"><button class="btn icon-only practice-arrow" data-card-step="-1" aria-label="Предыдущая карточка" ${index===0?'disabled':''}>${icon('back')}</button><button type="button" class="flashcard ${flipped?'flipped':''}" aria-label="${flipped?'Показать вопрос':'Показать ответ'}" aria-pressed="${flipped}" data-flip><span class="flashcard-inner"><span class="flashcard-face flashcard-front" aria-hidden="${flipped}"><span class="eyebrow">ВОПРОС</span><span class="flashcard-question">${esc(c.question)}</span><span class="flashcard-hint">${icon('refresh')} Нажмите, чтобы увидеть ответ</span></span><span class="flashcard-face flashcard-back" aria-hidden="${!flipped}"><span class="eyebrow">ПРАВИЛЬНЫЙ ОТВЕТ</span><span class="flashcard-answer">${esc(c.answer)}</span>${c.explanation?`<span class="flashcard-explanation">${esc(c.explanation)}</span>`:''}<span class="flashcard-hint">Нажмите, чтобы вернуться к вопросу</span></span></span></button><button class="btn icon-only practice-arrow" data-card-step="1" aria-label="Следующая карточка" ${index===deck.length-1?'disabled':''}>${icon('arrow')}</button></div><div class="practice-mobile-nav">${btn('Назад','back','','data-card-step="-1"'+(index===0?' disabled':''))}${btn('Далее','arrow','','data-card-step="1"'+(index===deck.length-1?' disabled':''))}</div><div class="practice-assess">${btn('Ещё повторить','refresh','',`data-remember="no" ${flipped?'':'disabled'}`)}${btn(known.has(c.id)?'Уже запомнил(а)':'Запомнил(а)','check','primary',`data-remember="yes" ${flipped?'':'disabled'}`)}</div><p class="footnote practice-help">На телефоне: свайп влево — далее, вправо — назад. Клавиатура: ← → и пробел.<br>Ваши отметки сохраняются на этом устройстве. Результаты тестов не меняются.</p></div>`;
  const face=$('[data-flip]',root);let suppress=false;
  face.onclick=()=>{if(suppress){suppress=false;return}if(busy)return;flipped=!flipped;if(flipped){seen.add(c.id);save()}
   face.classList.toggle('flipped',flipped);face.setAttribute('aria-pressed',String(flipped));face.setAttribute('aria-label',flipped?'Показать вопрос':'Показать ответ');
   $('.flashcard-front',face).setAttribute('aria-hidden',String(flipped));$('.flashcard-back',face).setAttribute('aria-hidden',String(!flipped));root.querySelectorAll('[data-remember]').forEach(b=>b.disabled=!flipped);
  };
  root.querySelectorAll('[data-card-step]').forEach(b=>b.onclick=()=>step(Number(b.dataset.cardStep)));
  face.onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();step(e.key==='ArrowLeft'?-1:1)}};
  face.addEventListener('pointerdown',e=>{if(e.isPrimary===false||e.button>0)return;drag={x:e.clientX,y:e.clientY,id:e.pointerId};face.setPointerCapture?.(e.pointerId)});
  face.addEventListener('pointerup',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag=null;if(Math.abs(dx)>=55&&Math.abs(dx)>Math.abs(dy)*1.3){suppress=true;step(dx<0?1:-1);setTimeout(()=>{suppress=false},350)}});
  face.addEventListener('pointercancel',()=>{drag=null});
  root.querySelectorAll('[data-remember]').forEach(b=>b.onclick=()=>{if(b.dataset.remember==='yes')known.add(c.id);else known.delete(c.id);save();if(index+1<deck.length)step(1);else if(repeat){deck=cards.filter(x=>!known.has(x.id));index=0;flipped=false;draw()}else{draw();toast('Отметка сохранена. Можно повторить сложные карточки.')}});
  $('[data-shuffle]',root).onclick=()=>{for(let i=deck.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[deck[i],deck[j]]=[deck[j],deck[i]]}index=0;flipped=false;draw();toast('Карточки перемешаны')};
  $('[data-repeat]',root).onclick=()=>{repeat=!repeat;deck=repeat?cards.filter(x=>!known.has(x.id)):[...cards];index=0;flipped=false;draw()};
 }
 function step(direction){if(busy||index+direction<0||index+direction>=deck.length)return;busy=true;
  const face=$('[data-flip]',root);face?.classList.add(direction>0?'card-exit-left':'card-exit-right');
  timer=setTimeout(()=>{index+=direction;flipped=false;busy=false;draw();$('[data-flip]',root)?.classList.add(direction>0?'card-enter-right':'card-enter-left');$('[data-flip]',root)?.focus({preventScroll:true})},reduced()?0:170);
 }
 draw();return clean;
}
