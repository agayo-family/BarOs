import {$,$$,state,api,icon,esc,toast,pageCleanup} from './core.js?v=2.14.0';
import {orbitMarkup,mountOrbit} from './orbit.js?v=2.14.0';
import {showSalesContact} from './sales.js?v=2.14.0';
import {fadeChange,reserveHeight,revealSections,smoothBehavior} from './motion.js?v=2.14.0';
import {themeButton,syncThemeControls} from './experience.js?v=2.14.0';

const numberFormat=new Intl.NumberFormat('ru-RU');
const rub=value=>numberFormat.format(value);
const logo=href=>`<a class="brand" href="${href}" aria-label="BarOS — главная сайта"><span class="brandmark">B<span>•</span></span>BarOS</a>`;
const check=text=>`<li>${icon('check')}<span>${text}</span></li>`;
const roles=['Бармены','Официанты','Администраторы','Кальянные мастера','Повара','Клининг'];
const faq=[
 ['Как проходит платный пилот?','Начинаем с одной должности и конкретной темы: например, меню для официантов. До оплаты согласуем объём обучения, срок, поддержку и критерии результата. Управляющий приглашает команду, проверяет письменные работы и разбирает итоговую аналитику.'],
 ['Что входит в подписку?','Курсы и тесты, письменные ответы с проверкой управляющим, карточки, учебные игры, назначения по должностям и аналитика команды. Во всех тарифах доступны одинаковые учебные инструменты.'],
 ['Как создаётся обучение по нашим материалам?','Сохраните материалы и запустите сборку черновика: BarOS разложит проверенный текст на уроки, карточки и письменные вопросы. Варианты ответов создаются при наличии подходящих числовых фактов. Управляющий проверяет и дополняет содержание перед публикацией. Можно загрузить готовый курс или заказать подготовку у команды BarOS.'],
 ['Кто проверяет письменные ответы?','Управляющий: по критериям и баллам, заданным в тесте. Он видит ответ сотрудника, оставляет обратную связь и может вернуть работу на доработку.'],
 ['Как считаются сотрудники?','Тариф выбирается по числу активных аккаунтов сотрудников одного заведения. Например, для 51 сотрудника подходит тариф до 100. Если команда вырастет, условия доступа можно изменить.'],
 ['Подойдёт для нескольких заведений?','Да. У каждого заведения свой кабинет, сотрудники, материалы и результаты. Стоимость считается отдельно по каждому заведению; условия для сети согласуются индивидуально.'],
 ['Нужно устанавливать приложение?','Можно работать в браузере на компьютере или телефоне. BarOS также можно добавить на главный экран. Для обучения и сохранения ответов нужен интернет.'],
 ['Как начать работу?','Определите первую должность и тему обучения, согласуйте условия подключения и получите приглашение управляющему. Затем опубликуйте курс и пригласите команду. Сотрудник уже подключённого заведения может зарегистрироваться по коду управляющего.']
];

function demo(){return `<div class="site-demo" aria-label="Пример отчёта по обучению"><div class="site-demo-top"><span class="site-demo-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>Академия заведения</span><span class="site-demo-label">Пример отчёта</span></div><div class="site-demo-body"><div class="site-demo-heading"><div><small>ОБЗОР ОБУЧЕНИЯ</small><h2>Команда перед сменой</h2></div><span class="site-demo-icon">${icon('chart')}</span></div><div class="site-demo-stats"><div><strong>24<span>/ 30</span></strong><small>завершили обучение</small></div><div><strong>86<span>%</span></strong><small>средний результат</small></div></div><div class="site-demo-list"><div><span class="site-demo-avatar">М</span><span><strong>Знание меню</strong><small>Официанты · 4 урока</small></span><b>92%</b></div><div><span class="site-demo-avatar green">С</span><span><strong>Стандарты сервиса</strong><small>Команда зала · 3 урока</small></span><b>84%</b></div><div><span class="site-demo-avatar orange">Б</span><span><strong>Барная классика</strong><small>Бармены · 6 уроков</small></span><b>78%</b></div></div><div class="site-demo-insight">${icon('target')}<span><strong>Есть тема для повторения</strong><small>Ответы о составе блюд стоит разобрать с командой.</small></span></div></div><div class="site-demo-note">${icon('file')}<span><strong>Ситуация с гостем</strong><small>Письменный ответ · ждёт проверки</small></span><span class="site-demo-pulse" aria-hidden="true"></span></div></div>`}

export async function landingPage(ticket=state.renderTicket){
 const [pricing,showcase]=await Promise.all([api('/pricing'),api('/showcase')]);if(ticket!==state.renderTicket)return;
 const authed=!!state.me?.account;
 const sitePath=authed?'/about':'/';
 const raw=new URLSearchParams(location.search).get('employees');
 let mode=new URLSearchParams(location.search).get('mode')==='self'?'self':'managed';
 let employees=/^\d+$/.test(raw||'')&&Number(raw)>=1&&Number(raw)<=10000?Number(raw):50;
 const contact=`<button type="button" class="btn primary" data-sales-contact>Обсудить подключение ${icon('arrow')}</button>`;
 $('#app').innerHTML=`<div class="site-page"><a class="site-skip" href="#site-main">Перейти к содержимому</a><header class="site-header"><div class="site-container site-header-inner">${logo(sitePath)}<nav class="site-nav" aria-label="Разделы главной страницы"><a href="#possibilities">Возможности</a><a href="#how">Как это работает</a><a href="#pricing">Стоимость</a></nav><div class="site-header-actions">${themeButton()}<a class="btn primary site-login" href="${authed?'/app':'/login'}">${authed?'В кабинет':'Войти'} ${icon('arrow')}</a></div></div></header><main id="site-main"><section class="site-hero site-container"><div class="site-hero-copy"><div class="site-kicker"><span></span>ОБУЧЕНИЕ КОМАНДЫ В ОБЩЕПИТЕ</div><h1>Ваши стандарты.<br>Сильная команда.<br><span>Каждая смена.</span></h1><p>Меню, сервис и работа с гостями — в одном месте. Дайте сотрудникам понятный путь обучения, а управляющему — картину знаний команды.</p><div class="site-hero-actions"><a class="btn primary" href="#pricing">Рассчитать стоимость ${icon('arrow')}</a><a class="site-text-link" href="#possibilities">Познакомиться с BarOS ${icon('chevron')}</a></div><div class="site-hero-facts"><span>${icon('phone')}На телефоне и компьютере</span><span>${icon('users')}Обучение по должностям</span></div></div>${demo()}</section>${orbitMarkup(showcase.items)}<div class="site-role-strip"><div class="site-container"><span>ДЛЯ ВСЕЙ КОМАНДЫ</span>${roles.map(r=>`<span>${r}</span>`).join('')}</div></div>
 <section class="site-section site-container" id="possibilities"><div class="site-section-heading"><div class="site-kicker">ОДИН ПУТЬ ОТ МАТЕРИАЛА ДО РЕЗУЛЬТАТА</div><h2>Знать стандарт.<br><span>Уметь применить на смене.</span></h2><p>Соберите знания заведения в обучение, к которому удобно возвращаться.</p></div><div class="site-features"><article class="site-feature site-feature-large"><div class="site-feature-number">01 / ВАШИ ЗНАНИЯ</div><h3>Меню и стандарты<br>становятся обучением</h3><p>Храните исходные материалы, загружайте курсы и тесты в черновики. Проверяйте содержание, редактируйте и назначайте нужным должностям.</p><div class="site-materials" aria-hidden="true"><span>${icon('file')}Меню заведения</span><span>${icon('book')}Уроки и примеры</span><span>${icon('checkcircle')}Проверено управляющим</span></div></article><article class="site-feature"><div class="site-feature-number">02 / ПРОВЕРКА ЗНАНИЙ</div>${icon('target')}<h3>Ответы показывают понимание</h3><p>Тесты с вариантами и письменные ситуации с гостями. Критерии оценки, обратная связь и история попыток.</p></article><article class="site-feature"><div class="site-feature-number">03 / ЗАКРЕПЛЕНИЕ</div>${icon('cards')}<h3>Повторение, к которому возвращаются</h3><p>Карточки и учебные игры помогают ещё раз пройти составы, стандарты и сложные вопросы.</p></article></div></section>
 <section class="site-insight-wrap"><div class="site-container site-insight"><div><div class="site-kicker">УПРАВЛЕНИЕ ОБУЧЕНИЕМ</div><h2>Видеть, кому нужна помощь.<br><span>И с какой темой.</span></h2><p>От общего отчёта по команде до конкретного ответа сотрудника. Смотрите завершённые курсы, результаты попыток, сложные вопросы и письменные работы.</p><ul class="site-checks">${check('Назначения и результаты по должностям')}${check('Темы, к которым стоит вернуться')}${check('Динамика обучения и выгрузка отчётов')}</ul></div><div class="site-example"><span class="site-demo-label">Пример разбора темы</span><h3>Что обсудить перед сменой</h3><div class="site-topic"><span>Состав и аллергены</span><b>Повторить</b></div><p>Разберите сложные ответы, уточните стандарт и назначьте повторение нужным сотрудникам.</p><div class="site-example-path"><span>${icon('chart')}Найти пробел</span><span>${icon('book')}Повторить</span><span>${icon('check')}Проверить</span></div></div></div></section>
 <section class="site-section site-container" id="how"><div class="site-section-heading"><div class="site-kicker">НАЧНИТЕ С ОДНОЙ ЗАДАЧИ</div><h2>От вашего меню<br><span>к знаниям команды.</span></h2></div><ol class="site-steps"><li><span>01</span><h3>Выберите тему</h3><p>Меню для официантов, классика для барменов или стандарты работы для новой команды.</p></li><li><span>02</span><h3>Проверьте обучение</h3><p>Подготовьте уроки и вопросы, утвердите формулировки и критерии письменных ответов.</p></li><li><span>03</span><h3>Пригласите сотрудников</h3><p>Назначьте обучение по должностям. Сотрудники проходят его со своего телефона.</p></li><li><span>04</span><h3>Разберите результат</h3><p>Проверьте письменные работы, посмотрите отчёт и определите темы для повторения.</p></li></ol></section>
 <section class="site-pricing-wrap" id="pricing"><div class="site-container"><div class="site-pricing"><div class="site-price-intro"><div class="site-kicker">ДВА СПОСОБА НАЧАТЬ</div><h2>Ваша академия.<br><span>В удобном для вас ритме.</span></h2><p>Соберите обучение своими силами или поручите подготовку команде BarOS. Учебные инструменты доступны в обоих вариантах.</p><ul class="site-checks">${check('Уроки, тесты и карточки с фотографиями')}${check('Письменные ответы и аналитика команды')}${check('График смен, часы и расчёт заработка')}${check('Раздельный кабинет вашего заведения')}</ul><p class="site-price-terms">Одна подписка — одно заведение. Оплата по счёту напрямую исполнителю, без автоматических списаний.</p></div><div class="site-price-card"><div class="site-mode-switch" role="group" aria-label="Способ подготовки обучения"><button type="button" data-mode="self">Самостоятельно</button><button type="button" data-mode="managed">С подготовкой</button></div><p id="mode-description" class="site-mode-description"></p><label class="site-count-label" for="team-size">Сколько сотрудников в вашей команде?</label><div class="site-team-input"><input id="team-size" type="number" min="1" max="10000" step="1" inputmode="numeric" value="${employees}" aria-describedby="team-size-help"><span>сотрудников</span></div><input class="site-team-range" id="team-range" type="range" min="1" max="300" step="1" value="${Math.min(employees,300)}" aria-label="Число сотрудников"><div class="site-tier-buttons" role="group" aria-label="Быстрый выбор размера команды">${[50,100,200,250].map(n=>`<button type="button" data-team="${n}">${n===250?'Больше 200':'До '+n}</button>`).join('')}</div><p id="team-size-help" class="site-help">Считаются активные аккаунты сотрудников одного заведения.</p><div id="price-result" class="site-price-result" role="status" aria-live="polite" aria-atomic="true"></div><div class="site-price-actions"><button type="button" class="btn primary full" data-quote>Скачать расчёт в Word ${icon('download')}</button>${contact}</div><p class="site-price-note">Подготовка указана «от». Темы, объём материалов, обновления и сроки согласуются до оплаты.</p></div></div><div class="site-plan-gallery"><div class="site-plan-heading"><div><span class="site-kicker">ВЫБЕРИТЕ СВОЙ МАСШТАБ</span><h3>Все тарифы перед вами</h3></div><div class="site-plan-arrows"><button type="button" class="btn icon-only soft" data-plan-step="-1" aria-label="Предыдущий тариф">${icon('back')}</button><button type="button" class="btn icon-only soft" data-plan-step="1" aria-label="Следующий тариф">${icon('arrow')}</button></div></div><div id="plan-carousel" class="site-plan-carousel" tabindex="0" role="region" aria-label="Тарифы. Пролистывайте в сторону или используйте стрелки."></div><p class="site-help">Листайте тарифы в сторону. Нажмите карточку, чтобы увидеть подробный расчёт.</p></div></div></section>
 <section class="site-section site-container site-faq" id="questions"><div class="site-section-heading"><div class="site-kicker">ПЕРЕД ПЕРВОЙ СМЕНОЙ</div><h2>Частые вопросы</h2><p>О подключении, обучении и работе команды.</p></div><div>${faq.map(([q,a])=>`<details><summary>${q}<span aria-hidden="true">+</span></summary><p>${a}</p></details>`).join('')}</div></section>
 <section class="site-container site-final" id="start"><div><div class="site-kicker">СЛЕДУЮЩИЙ ШАГ</div><h2>Начните с темы,<br>которая нужна на ближайшей смене.</h2><p>Выберите размер команды и сохраните расчёт для обсуждения подключения.</p></div><div><a class="btn primary" href="#pricing">Выбрать тариф ${icon('arrow')}</a>${contact}<a class="site-text-link" href="${authed?'/app':'/login'}">${authed?'Вернуться в кабинет':'Уже с командой? Войти'}</a></div></section></main><footer class="site-footer site-container">${logo(sitePath)}<span>Знания вашего заведения.<br>Уверенность вашей команды.</span><nav aria-label="Дополнительные ссылки"><a href="#pricing">Стоимость</a><a href="#questions">Вопросы</a><a href="/join">Я новый сотрудник</a><a href="/legal/privacy">Документы и реквизиты</a></nav></footer></div>`;
 const input=$('#team-size'),range=$('#team-range'),price=$('#price-result'),gallery=$('#plan-carousel');
 let valid=true,galleryGesture=false,downloading=false,priceAnimation=null;
 const downloadAbort=new AbortController();
 const description=$('#mode-description');
 const descriptions={
  self:'Вы загружаете материалы, собираете черновики и проверяете обучение перед публикацией.',
  managed:'Команда BarOS готовит обучение по вашим материалам, согласует содержание и сопровождает обновления в рамках договора.'
 };
 function priceMarkup(n,selectedMode){
  const tier=pricing.modes[selectedMode].tiers.find(t=>n<=t.employees);
  return tier?`<span class="site-price-tier">${esc(pricing.modes[selectedMode].title)} · до ${tier.employees} сотрудников</span><div class="site-price-value">${rub(tier.monthly)} <span>₽ / месяц</span></div>${tier.preparation?`<div class="site-setup-price"><span>Подготовка обучения</span><strong>от ${rub(tier.preparation)} ₽ <small>разово</small></strong></div><p class="site-first-month">Первый месяц с подготовкой: от ${rub(tier.monthly+tier.preparation)} ₽</p>`:'<p class="site-first-month">Без разовой платы за подготовку</p>'}<p class="site-per-person">≈ ${rub(Math.round(tier.monthly/n))} ₽ на сотрудника в месяц при команде из ${n}</p>`:'<span class="site-price-tier">Команда больше 200 сотрудников</span><div class="site-price-value site-custom-price">Индивидуально</div><p class="site-per-person">Подберём условия по составу команды и числу заведений.</p>';
 }
 const variants=Object.keys(descriptions).flatMap(selectedMode=>{
  const tiers=pricing.modes[selectedMode].tiers;
  return tiers.flatMap((tier,i)=>[priceMarkup(i?tiers[i-1].employees+1:1,selectedMode),priceMarkup(tier.employees,selectedMode)]);
 }).concat(priceMarkup(10000,'managed'));
 function reservePricingSpace(){
  reserveHeight(price,variants);
  reserveHeight(description,Object.values(descriptions).map(esc));
 }
 function scrollPlan(limit){
  const slide=$(`[data-plan="${limit}"]`,gallery);if(!slide)return;
  const padding=parseFloat(window.getComputedStyle(gallery).paddingLeft)||0;
  const track=gallery.getBoundingClientRect(),card=slide.getBoundingClientRect();
  if(card.left>=track.left+padding-.5&&card.right<=track.right-padding+.5)return;
  const left=gallery.scrollLeft+card.left-track.left-padding;
  gallery.scrollTo?.({left:Math.max(0,left),behavior:smoothBehavior()});
 }
 function update(value,writeUrl=true){
  priceAnimation?.cancel();priceAnimation=null;
  const n=Number(value);valid=String(value).trim()!==''&&Number.isInteger(n)&&n>=1&&n<=10000;
  input.setAttribute('aria-invalid',String(!valid));$('[data-quote]').disabled=!valid||downloading;
  if(!valid){price.innerHTML='<p class="site-price-error">Укажите целое число от 1 до 10 000.</p>';if(writeUrl)priceAnimation=fadeChange(price);return}
  employees=n;input.value=String(n);range.value=String(Math.min(n,300));range.setAttribute('aria-valuetext',n+' сотрудников');
  const tiers=pricing.modes[mode].tiers,tier=tiers.find(t=>n<=t.employees);
  const selected=tiers.findIndex(t=>n<=t.employees),selectedIndex=selected<0?3:selected;
  $$('[data-team]').forEach(b=>b.setAttribute('aria-pressed',String(tier?Number(b.dataset.team)===tier.employees:Number(b.dataset.team)===250)));
  $$('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
  if(description.textContent!==descriptions[mode])description.textContent=descriptions[mode];
  price.innerHTML=priceMarkup(n,mode);
  [...tiers,{employees:250,monthly:null,preparation:null}].forEach((t,i)=>{
   let button=$(`[data-plan="${t.employees}"]`,gallery);
   if(!button){button=document.createElement('button');button.type='button';button.dataset.plan=String(t.employees);button.innerHTML='<span class="site-plan-limit"></span><strong><span data-plan-price></span><small></small></strong><span data-plan-setup></span><span class="site-plan-choose"><span data-plan-label></span><span data-plan-icon aria-hidden="true"></span></span>';button.onclick=()=>{galleryGesture=false;update(button.dataset.plan);button.focus({preventScroll:true});scrollPlan(button.dataset.plan)};gallery.append(button)}
   button.className='site-plan-slide'+(i===selectedIndex?' selected':'');button.setAttribute('aria-pressed',String(i===selectedIndex));
   const texts={
    '.site-plan-limit':(i===3?'Больше 200':'До '+t.employees)+' сотрудников',
    '[data-plan-price]':t.monthly?rub(t.monthly)+' ₽':'Обсудим',
    'strong>small':t.monthly?'в месяц':'индивидуально',
    '[data-plan-setup]':t.preparation?'Подготовка от '+rub(t.preparation)+' ₽':i===3?'Для большой команды и сети':'Без платы за подготовку',
    '[data-plan-label]':i===selectedIndex?'Выбрано':'Выбрать тариф'
   };
   for(const [selector,text] of Object.entries(texts)){
    const node=$(selector,button);
    if(node.textContent!==text)node.textContent=text;
   }
   const symbol=i===selectedIndex?'check':'arrow',slot=$('[data-plan-icon]',button);
   if(slot.dataset.symbol!==symbol){slot.innerHTML=icon(symbol);slot.dataset.symbol=symbol}
  });
  if(writeUrl)priceAnimation=fadeChange(price);
  if(writeUrl){const url=new URL(location.href);url.searchParams.set('employees',String(n));url.searchParams.set('mode',mode);history.replaceState({},'',url.pathname+url.search+url.hash)}
 }
 input.addEventListener('input',()=>update(input.value));range.addEventListener('input',()=>update(range.value));$$('[data-team]').forEach(b=>b.onclick=()=>update(b.dataset.team));
 $('[data-quote]').onclick=async()=>{
  if(!valid||downloading)return;const n=employees,selectedMode=mode,button=$('[data-quote]'),label=button.innerHTML;
  downloading=true;button.disabled=true;button.setAttribute('aria-busy','true');button.textContent='Готовим расчёт…';
  try{
   const response=await fetch('/api/pricing/quote.docx?'+new URLSearchParams({employees:String(n),mode:selectedMode}),{credentials:'same-origin',cache:'no-store',signal:downloadAbort.signal});
   if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.detail||'Не удалось подготовить расчёт. Попробуйте ещё раз.')}
   if(!response.headers.get('content-type')?.includes('wordprocessingml'))throw new Error('Не удалось получить документ Word. Попробуйте ещё раз.');
   const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download='BarOS-'+n+'-'+selectedMode+'.docx';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);toast('Расчёт в Word скачан');
  }catch(error){if(error.name!=='AbortError')toast(error.message,true)}finally{downloading=false;if(button.isConnected){button.disabled=!valid;button.removeAttribute('aria-busy');button.innerHTML=label}}
 };
 $$('[data-sales-contact]').forEach(button=>button.onclick=()=>showSalesContact(pricing,{employees:valid?employees:null,mode}));
 $$('[data-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.mode;update(employees)});
 const planLimits=[50,100,200,250];
 const selectedPlan=()=>{const index=pricing.modes[mode].tiers.findIndex(t=>employees<=t.employees);return index<0?3:index};
 const stepPlans=direction=>{galleryGesture=false;const next=Math.max(0,Math.min(3,selectedPlan()+direction));update(planLimits[next]);scrollPlan(planLimits[next])};
 $$('[data-plan-step]').forEach(b=>b.onclick=()=>stepPlans(Number(b.dataset.planStep)));
 gallery.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const fromCard=e.target.hasAttribute('data-plan');if(e.key==='Home'||e.key==='End'){galleryGesture=false;update(e.key==='Home'?50:250);scrollPlan(planLimits[selectedPlan()])}else stepPlans(e.key==='ArrowRight'?1:-1);if(fromCard)$(`[data-plan="${planLimits[selectedPlan()]}"]`)?.focus({preventScroll:true})});
 gallery.addEventListener('pointerdown',()=>{galleryGesture=true});
 gallery.addEventListener('wheel',()=>{galleryGesture=true},{passive:true});
 gallery.addEventListener('scrollend',()=>{if(!galleryGesture)return;galleryGesture=false;const left=gallery.getBoundingClientRect().left,slides=[...gallery.querySelectorAll('[data-plan]')],nearest=slides.sort((a,b)=>Math.abs(a.getBoundingClientRect().left-left)-Math.abs(b.getBoundingClientRect().left-left))[0];if(nearest&&Number(nearest.dataset.plan)!==planLimits[selectedPlan()])update(nearest.dataset.plan)});
 update(employees,false);reservePricingSpace();syncThemeControls();
 let measuredWidth=price.getBoundingClientRect().width;
 const observer=window.ResizeObserver?new window.ResizeObserver(()=>{
  const width=price.getBoundingClientRect().width;
  if(Math.abs(width-measuredWidth)>.5){measuredWidth=width;reservePricingSpace()}
 }):null;
 observer?.observe(price);
 window.addEventListener('resize',reservePricingSpace);
 document.fonts?.addEventListener?.('loadingdone',reservePricingSpace);
 const stopMotion=revealSections($('.site-page')),stopOrbit=mountOrbit($('.site-page'),showcase.items);pageCleanup(()=>{stopMotion();stopOrbit();priceAnimation?.cancel();observer?.disconnect();window.removeEventListener('resize',reservePricingSpace);document.fonts?.removeEventListener?.('loadingdone',reservePricingSpace);downloadAbort.abort()},ticket);
 document.title='BarOS — обучение команды ресторана, бара и кафе';
 const main=$('#site-main');main.tabIndex=-1;main.focus({preventScroll:true});
 if(location.hash){const el=document.getElementById(location.hash.slice(1));el?.scrollIntoView()}else window.scrollTo({top:0,behavior:'instant'});
}
