import {$,$$,icon,modal,notice,toast} from './core.js?v=2.2.0';

let installPrompt=null,changing=false;
export const themeButton=()=>`<button class="btn icon-only ghost" data-theme-toggle aria-label="Переключить цветовую тему">${icon('moon')}</button>`;
export const experienceSettings=()=>`<section class="card section-space" style="max-width:720px"><div class="card-head"><div><h2>Ваш BarOS</h2><p>Удобно на рабочем компьютере и на телефоне</p></div>${icon('phone')}</div><div class="row"><button class="btn soft" data-theme-toggle>${icon('moon')}Ночная тема</button><button class="btn primary" data-install>${icon('download')}Установить приложение</button><button class="btn" data-support>${icon('interview')}Связаться</button></div><p class="footnote">Приложение открывается с главного экрана. Для обучения и сохранения результатов нужен интернет.</p></section>`;
export function syncThemeControls(){const dark=document.documentElement.dataset.theme==='dark';$$('[data-theme-toggle]').forEach(b=>{const compact=b.classList.contains('icon-only');b.innerHTML=icon(dark?'sun':'moon')+(compact?'':dark?'Светлая тема':'Ночная тема');b.setAttribute('aria-label',dark?'Включить светлую тему':'Включить ночную тему');b.setAttribute('aria-pressed',String(dark))})}
function applyTheme(theme){document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#171623':'#5b47d6');try{localStorage.setItem('baros:theme',theme)}catch{}syncThemeControls()}
async function toggleTheme(button){if(changing)return;changing=true;const next=document.documentElement.dataset.theme==='dark'?'light':'dark',reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
 try{if(reduced||!document.startViewTransition){applyTheme(next);return}
  const r=button.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,radius=Math.hypot(Math.max(x,innerWidth-x),Math.max(y,innerHeight-y));
  const rain=document.createElement('div');rain.className='theme-rain';rain.setAttribute('aria-hidden','true');rain.innerHTML=Array.from({length:7},(_,i)=>`<i style="left:${13+i*12}%;top:${14+(i*19)%65}%;--delay:${i*45}ms"></i>`).join('');document.body.append(rain);
  const transition=document.startViewTransition(()=>applyTheme(next));
  try{await transition.ready;document.documentElement.animate({clipPath:[`circle(0px at ${x}px ${y}px)`,`circle(${radius}px at ${x}px ${y}px)`]},{duration:650,easing:'cubic-bezier(.22,1,.36,1)',pseudoElement:'::view-transition-new(root)'});await transition.finished}finally{rain.remove()}
 }catch{applyTheme(next)}finally{changing=false}
}
function contact(){modal('Связаться с владельцем BarOS',`<p class="lead">Сергей · помощь с платформой и подключение заведения</p><div class="contact-options"><a class="contact-option" href="mailto:ergin.sergey2002@yandex.ru">${icon('interview')}<span><small>Email</small><strong>ergin.sergey2002@yandex.ru</strong></span>${icon('arrow')}</a><a class="contact-option" href="https://t.me/frooppe" target="_blank" rel="noopener noreferrer">${icon('link')}<span><small>Telegram</small><strong>@frooppe</strong></span>${icon('arrow')}</a></div>`)}
async function install(){if(window.matchMedia?.('(display-mode: standalone)').matches||navigator.standalone){toast('BarOS уже открыт как приложение');return}
 if(installPrompt){const prompt=installPrompt;installPrompt=null;await prompt.prompt();const choice=await prompt.userChoice;toast(choice.outcome==='accepted'?'Установка подтверждена':'Установить можно позже из профиля');return}
 const ios=/iPhone|iPad|iPod/i.test(navigator.userAgent)||navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1;
 modal('Установить BarOS',ios?`<p class="lead">Откройте BarOS в Safari и добавьте на главный экран.</p><ol class="install-steps"><li>Нажмите «Поделиться» в панели Safari.</li><li>Выберите «На экран Домой».</li><li>Подтвердите кнопкой «Добавить».</li></ol>`:`<p class="lead">Откройте BarOS в Chrome или Edge.</p><ol class="install-steps"><li>Откройте меню браузера ⋮.</li><li>Выберите «Установить приложение» или «Добавить на главный экран».</li><li>Подтвердите установку.</li></ol>${notice('Если пункта установки пока нет, обновите страницу и откройте сайт в обычном браузере вместо встроенного окна мессенджера.')}`);
}
export function initExperience(){
 if(!document.documentElement.dataset.theme)applyTheme(window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light');
 window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e});window.addEventListener('appinstalled',()=>{installPrompt=null;toast('BarOS установлен — ищите значок на главном экране')});
 document.addEventListener('click',e=>{const theme=e.target.closest('[data-theme-toggle]'),support=e.target.closest('[data-support]'),app=e.target.closest('[data-install]');if(theme)toggleTheme(theme);else if(support)contact();else if(app)install().catch(err=>toast(err.message,true))});
 window.addEventListener('storage',e=>{if(e.key==='baros:theme'&&['light','dark'].includes(e.newValue))applyTheme(e.newValue)});
 if('serviceWorker'in navigator&&window.isSecureContext)navigator.serviceWorker.register('/sw.js').catch(()=>{});
}
