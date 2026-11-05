import {modal,esc,icon} from './core.js?v=2.14.0';

const rub=n=>new Intl.NumberFormat('ru-RU').format(n)+' ₽';
export function showSalesContact(pricing={},selection={}){
 const mode=selection.mode==='self'?'self':'managed';
 const count=Number.isInteger(selection.employees)&&selection.employees>0?selection.employees:null;
 const plan=pricing.modes?.[mode],tier=count?plan?.tiers.find(t=>count<=t.employees):null;
 const summary=count?`${plan?.title||'Подключение BarOS'} · ${count} сотрудников`:null;
 const detail=tier?`${rub(tier.monthly)} в месяц${tier.preparation?' · подготовка от '+rub(tier.preparation):''}`:count?'Условия под вашу команду':null;
 const subject='Платный пилот BarOS'+(count?': '+count+' сотрудников':'');
 const body=['Здравствуйте! Хочу обсудить платный пилот BarOS.','',summary||'',detail||'','Название заведения:','Город:','Количество сотрудников: '+(count||''),'Первая должность и задача обучения:'].filter((line,i)=>line||i<3).join('\n');
 const email=pricing.contact_email||'';
 const emailLink=email?'mailto:'+email+'?subject='+encodeURIComponent(subject)+'&body='+encodeURIComponent(body):null;
 const m=modal('Начнём с задачи вашего заведения',`<div class="sales-contact"><span class="sales-kicker">ПЛАТНЫЙ ПИЛОТ BAROS</span><p class="sales-lead">Выберите одну должность и тему. Обсудим, как превратить ваши материалы в понятное обучение и увидеть результат команды.</p>${summary?`<div class="sales-selection"><span>Ваш расчёт</span><strong>${esc(summary)}</strong><small>${esc(detail)}</small></div>`:''}<div class="sales-options"><a class="sales-option sales-telegram" href="https://t.me/Frooppe" target="_blank" rel="noopener noreferrer"><span class="sales-channel-icon">${icon('interview')}</span><span><strong>Написать в Telegram</strong><small>@Frooppe</small></span>${icon('arrow')}</a>${emailLink?`<a class="sales-option" href="${esc(emailLink)}"><span class="sales-channel-icon">${icon('file')}</span><span><strong>Обсудить по почте</strong><small>${esc(email)}</small></span>${icon('arrow')}</a>`:''}</div><p class="sales-prompt">В сообщении укажите название и город заведения, размер команды и то, чему хотите научить сотрудников в первую очередь.</p><div class="sales-next"><span>Что согласуем</span><p>Объём обучения · срок пилота · критерии результата · стоимость</p></div><p class="sales-note">Сначала согласуем условия и счёт. Автоматических списаний нет.</p></div>`);
 m.root.querySelector('.modal').classList.add('sales-modal');
 return m;
}
