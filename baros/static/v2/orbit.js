import {esc,icon} from './core.js?v=2.13.1';
import {reducedMotion} from './motion.js?v=2.13.1';

export function orbitMarkup(items){
 if(!items?.length)return '';
 return `<section class="site-venue-section site-container" id="venues"><div class="site-section-heading"><div class="site-kicker">ОБУЧЕНИЕ ПОД КАЖДОЕ ЗАВЕДЕНИЕ</div><h2>Заведения с BarOS</h2><p>Свои материалы и стандарты. Общий путь к знаниям команды.</p></div><div class="venue-orbit" role="region" aria-roledescription="карусель" aria-label="Подключённые заведения"><div class="venue-orbit-stage" tabindex="0" aria-label="Вращение заведений. Используйте стрелки влево и вправо или проведите в сторону."><div class="venue-orbit-track" aria-hidden="true"></div><div class="venue-orbit-shadow" aria-hidden="true"></div>${items.map((item,i)=>`<button type="button" class="venue-orbit-card" data-orbit-index="${i}" tabindex="${i===0?'0':'-1'}" aria-label="Показать ${esc(item.name)}">${item.logo?`<span class="venue-orbit-logo"><img src="${esc(item.logo)}" alt="" width="96" height="96" draggable="false"></span>`:`<span class="venue-orbit-monogram" aria-hidden="true">${esc(Array.from(item.name).slice(0,2).join('').toUpperCase())}</span>`}<strong>${esc(item.name)}</strong></button>`).join('')}</div><div class="venue-orbit-controls"><button type="button" class="btn soft icon-only" data-orbit-step="-1" aria-label="Предыдущее заведение" ${items.length<2?'disabled':''}>${icon('back')}</button><div class="venue-orbit-caption" role="status" aria-live="polite" aria-atomic="true"><strong data-orbit-name></strong><span data-orbit-description></span><small data-orbit-counter></small></div><button type="button" class="btn soft icon-only" data-orbit-step="1" aria-label="Следующее заведение" ${items.length<2?'disabled':''}>${icon('arrow')}</button></div><p class="venue-orbit-help">${items.length>1?'Проведите в сторону или воспользуйтесь стрелками':'Обучение команды заведения'}</p></div></section>`;
}

export function mountOrbit(scope,items){
 const root=scope.querySelector('.venue-orbit');if(!root||!items.length)return ()=>{};
 const stage=root.querySelector('.venue-orbit-stage'),cards=[...root.querySelectorAll('[data-orbit-index]')];
 const step=2*Math.PI/items.length;let rotation=0,frame=null,targetIndex=0,radius=0,vertical=0,pointer=null,suppressClick=0;
 const selected=()=>((Math.round(-rotation/step)%items.length)+items.length)%items.length;
 const caption=()=>{const index=selected(),item=items[index];root.dataset.activeIndex=String(index);root.querySelector('[data-orbit-name]').textContent=item.name;root.querySelector('[data-orbit-description]').textContent=[item.city,item.description].filter(Boolean).join(' · ');root.querySelector('[data-orbit-counter]').textContent=(index+1)+' / '+items.length};
 function paint(){
  const current=selected();cards.forEach((card,i)=>{const angle=i*step+rotation,depth=Math.cos(angle),behind=depth<=.025;
   card.style.transform=`translate(-50%,-50%) translate(${Math.sin(angle)*radius}px,${depth*vertical}px) scale(${.63+.37*Math.max(0,depth)})`;
   card.style.opacity=behind?'0':String(Math.min(1,depth*2.25));card.style.visibility=behind?'hidden':'visible';card.style.filter=`brightness(${.55+.45*Math.max(0,depth)})`;
   card.style.zIndex=String(Math.round((depth+1)*50));card.tabIndex=!behind&&i===current?0:-1;card.setAttribute('aria-hidden',String(behind));card.setAttribute('aria-pressed',String(i===current));card.inert=behind;
   if(behind&&card.contains(document.activeElement))stage.focus({preventScroll:true});
  });
 }
 function stop(){if(frame!==null)cancelAnimationFrame(frame);frame=null}
 function to(index){
  stop();targetIndex=((index%items.length)+items.length)%items.length;const target=-targetIndex*step,difference=Math.atan2(Math.sin(target-rotation),Math.cos(target-rotation)),start=rotation;
  if(reducedMotion()){rotation+=difference;paint();caption();return}
  const began=performance.now();const tick=time=>{const t=Math.min(1,(time-began)/540);rotation=start+difference*(1-Math.pow(1-t,4));paint();if(t<1)frame=requestAnimationFrame(tick);else{frame=null;caption()}};frame=requestAnimationFrame(tick);
 }
 function resize(){const width=stage.getBoundingClientRect().width||520,cardWidth=cards[0].offsetWidth||140;radius=Math.max(0,width/2-cardWidth/2-18);vertical=Math.min(78,width*.13);root.style.setProperty('--orbit-y',vertical+'px');paint()}
 const click=e=>{if(performance.now()<suppressClick){e.preventDefault();return}const card=e.target.closest('[data-orbit-index]');if(card)to(Number(card.dataset.orbitIndex));const control=e.target.closest('[data-orbit-step]');if(control)to(targetIndex+Number(control.dataset.orbitStep))};
 const key=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();to(e.key==='Home'?0:e.key==='End'?items.length-1:targetIndex+(e.key==='ArrowRight'?1:-1))}};
 const down=e=>{if(items.length<2||!e.isPrimary||(e.pointerType==='mouse'&&e.button!==0))return;stop();pointer={id:e.pointerId,x:e.clientX,y:e.clientY,start:rotation,dragging:false}};
 const move=e=>{if(!pointer||e.pointerId!==pointer.id)return;const dx=e.clientX-pointer.x,dy=e.clientY-pointer.y;if(!pointer.dragging&&(Math.abs(dx)<7||Math.abs(dx)<Math.abs(dy)))return;pointer.dragging=true;stage.setPointerCapture?.(e.pointerId);e.preventDefault();rotation=pointer.start+dx/Math.max(100,radius);paint()};
 const up=e=>{if(!pointer||e.pointerId!==pointer.id)return;const dragged=pointer.dragging;pointer=null;if(stage.hasPointerCapture?.(e.pointerId))stage.releasePointerCapture(e.pointerId);if(dragged){suppressClick=performance.now()+350;to(selected())}};
 root.addEventListener('click',click);stage.addEventListener('keydown',key);stage.addEventListener('pointerdown',down);stage.addEventListener('pointermove',move);stage.addEventListener('pointerup',up);stage.addEventListener('pointercancel',up);
 const observer=window.ResizeObserver?new ResizeObserver(resize):null;observer?.observe(stage);window.addEventListener('resize',resize);
 const preference=window.matchMedia?.('(prefers-reduced-motion: reduce)');const change=()=>{if(preference.matches){stop();rotation=-selected()*step;paint();caption()}};preference?.addEventListener?.('change',change);
 resize();caption();
 return ()=>{stop();observer?.disconnect();window.removeEventListener('resize',resize);root.removeEventListener('click',click);stage.removeEventListener('keydown',key);stage.removeEventListener('pointerdown',down);stage.removeEventListener('pointermove',move);stage.removeEventListener('pointerup',up);stage.removeEventListener('pointercancel',up);preference?.removeEventListener?.('change',change)};
}
