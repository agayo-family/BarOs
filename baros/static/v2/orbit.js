import {esc,icon} from './core.js?v=2.13.3';
import {reducedMotion} from './motion.js?v=2.13.3';

export function orbitMarkup(items){
 if(!items?.length)return '';
 return `<section class="site-venue-section site-container" id="venues"><div class="site-section-heading"><div class="site-kicker">ОБУЧЕНИЕ ПОД КАЖДОЕ ЗАВЕДЕНИЕ</div><h2>Заведения с BarOS</h2><p>Свои материалы и стандарты. Общий путь к знаниям команды.</p></div><div class="venue-orbit" role="region" aria-roledescription="карусель" aria-label="Подключённые заведения"><div class="venue-orbit-stage" tabindex="0" aria-label="Вращение заведений. Используйте стрелки влево и вправо или проведите в сторону."><div class="venue-orbit-track" aria-hidden="true"></div><div class="venue-orbit-shadow" aria-hidden="true"></div>${items.map((item,i)=>`<button type="button" class="venue-orbit-card" data-orbit-index="${i}" tabindex="${i===0?'0':'-1'}" aria-label="Показать ${esc(item.name)}">${item.logo?`<span class="venue-orbit-logo"><img src="${esc(item.logo)}" alt="" width="148" height="136" draggable="false"></span>`:`<span class="venue-orbit-monogram" aria-hidden="true">${esc(Array.from(item.name).slice(0,2).join('').toUpperCase())}</span>`}</button>`).join('')}</div><div class="venue-orbit-controls"><button type="button" class="btn soft icon-only" data-orbit-step="-1" aria-label="Предыдущее заведение" ${items.length<2?'disabled':''}>${icon('back')}</button><div class="venue-orbit-caption" role="status" aria-live="polite" aria-atomic="true">${items.map((item,i)=>`<div class="venue-orbit-caption-item" data-orbit-caption="${i}" aria-hidden="${i!==0}"><strong>${esc(item.name)}</strong><span>${esc([item.city,item.description].filter(Boolean).join(' · '))}</span></div>`).join('')}</div><button type="button" class="btn soft icon-only" data-orbit-step="1" aria-label="Следующее заведение" ${items.length<2?'disabled':''}>${icon('arrow')}</button></div><p class="venue-orbit-help">${items.length>1?'Проведите в сторону или воспользуйтесь стрелками':'Обучение команды заведения'}</p></div></section>`;
}

const eased=t=>t*t*t*(t*(t*6-15)+10);
const fade=t=>t*t*(3-2*t);

export function mountOrbit(scope,items){
 const root=scope.querySelector('.venue-orbit');if(!root||!items.length)return ()=>{};
 const stage=root.querySelector('.venue-orbit-stage'),cards=[...root.querySelectorAll('[data-orbit-index]')],captions=[...root.querySelectorAll('[data-orbit-caption]')];
 const step=2*Math.PI/items.length,normal=index=>((index%items.length)+items.length)%items.length;
 let rotation=0,frame=null,targetIndex=0,radius=0,vertical=0,pointer=null,suppressClick=0;
 const selected=()=>normal(Math.round(-rotation/step));
 function paint(){
  const current=selected();root.dataset.activeIndex=String(current);
  cards.forEach((card,i)=>{
   const angle=i*step+rotation,depth=Math.cos(angle),behind=depth<=.001,front=Math.max(0,depth);
   card.style.transform=`translate(-50%,-50%) translate(${Math.sin(angle)*radius}px,${depth*vertical}px) scale(${.66+.34*front})`;
   card.style.opacity=behind?'0':String(fade(Math.min(1,front/.45)));card.style.visibility=behind?'hidden':'visible';card.style.filter=`brightness(${.6+.4*front})`;
   card.style.zIndex=String(Math.round((depth+1)*50));card.tabIndex=!behind&&i===current?0:-1;card.setAttribute('aria-hidden',String(behind));card.setAttribute('aria-pressed',String(i===current));card.inert=behind;
   if(behind&&card.contains(document.activeElement))stage.focus({preventScroll:true});
   // Stack every caption in one grid cell, reserving the tallest title's height.
   // Logos and labels fade from the same angle; labels change only at zero opacity.
   const distance=Math.abs(Math.atan2(Math.sin(angle),Math.cos(angle)));
   const opacity=fade(Math.max(0,1-distance/(step/2))),caption=captions[i],hidden=opacity<.001;
   caption.style.opacity=String(opacity);caption.style.visibility=hidden?'hidden':'visible';
   if(caption.getAttribute('aria-hidden')!==String(hidden))caption.setAttribute('aria-hidden',String(hidden));
  });
 }
 function stop(){if(frame!==null)cancelAnimationFrame(frame);frame=null}
 function to(index,direction=0){
  stop();targetIndex=normal(index);
  const target=-targetIndex*step,start=rotation;
  let difference=Math.atan2(Math.sin(target-rotation),Math.cos(target-rotation));
  // Explicit direction also handles two exactly opposite venues and quick clicks.
  if(direction>0&&difference>0.00001)difference-=2*Math.PI;
  if(direction<0&&difference<-.00001)difference+=2*Math.PI;
  if(reducedMotion()||Math.abs(difference)<.00001){rotation=start+difference;paint();return}
  const began=performance.now(),duration=Math.min(1400,Math.max(700,Math.abs(difference)/Math.PI*860));
  const tick=time=>{const t=Math.min(1,Math.max(0,(time-began)/duration));rotation=start+difference*eased(t);paint();if(t<1)frame=requestAnimationFrame(tick);else frame=null};
  frame=requestAnimationFrame(tick);
 }
 function resize(){const width=stage.getBoundingClientRect().width||520,cardWidth=cards[0].offsetWidth||156;radius=Math.max(0,width/2-cardWidth/2-18);vertical=Math.min(78,width*.13);root.style.setProperty('--orbit-y',vertical+'px');paint()}
 const click=e=>{if(performance.now()<suppressClick){e.preventDefault();return}const card=e.target.closest('[data-orbit-index]');if(card)to(Number(card.dataset.orbitIndex));const control=e.target.closest('[data-orbit-step]');if(control){const direction=Number(control.dataset.orbitStep);to(targetIndex+direction,direction)}};
 const key=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const direction=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;to(e.key==='Home'?0:e.key==='End'?items.length-1:targetIndex+direction,direction)}};
 const down=e=>{if(items.length<2||!e.isPrimary||(e.pointerType==='mouse'&&e.button!==0))return;pointer={id:e.pointerId,x:e.clientX,y:e.clientY,start:rotation,dragging:false}};
 const move=e=>{
  if(!pointer||e.pointerId!==pointer.id)return;
  const dx=e.clientX-pointer.x,dy=e.clientY-pointer.y;
  if(!pointer.dragging){
   if(Math.abs(dx)<7||Math.abs(dx)<Math.abs(dy))return;
   stop();pointer.dragging=true;pointer.start=rotation;pointer.x=e.clientX;stage.setPointerCapture?.(e.pointerId);
  }
  e.preventDefault();rotation=pointer.start+(e.clientX-pointer.x)/Math.max(100,radius);paint();
 };
 const up=e=>{if(!pointer||e.pointerId!==pointer.id)return;const dragged=pointer.dragging;pointer=null;if(stage.hasPointerCapture?.(e.pointerId))stage.releasePointerCapture(e.pointerId);if(dragged){suppressClick=performance.now()+350;to(selected())}};
 root.addEventListener('click',click);stage.addEventListener('keydown',key);stage.addEventListener('pointerdown',down);stage.addEventListener('pointermove',move);stage.addEventListener('pointerup',up);stage.addEventListener('pointercancel',up);
 const observer=window.ResizeObserver?new ResizeObserver(resize):null;observer?.observe(stage);window.addEventListener('resize',resize);
 const preference=window.matchMedia?.('(prefers-reduced-motion: reduce)');const change=()=>{if(preference.matches){stop();rotation=-(pointer?.dragging?selected():targetIndex)*step;paint()}};preference?.addEventListener?.('change',change);
 resize();
 return ()=>{stop();observer?.disconnect();window.removeEventListener('resize',resize);root.removeEventListener('click',click);stage.removeEventListener('keydown',key);stage.removeEventListener('pointerdown',down);stage.removeEventListener('pointermove',move);stage.removeEventListener('pointerup',up);stage.removeEventListener('pointercancel',up);preference?.removeEventListener?.('change',change)};
}
