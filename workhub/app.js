const STORAGE_KEY="workhub.v1";
const seed={
  version:1,
  strictMode:true,
  xp:320,
  projects:[
    {id:"baros",name:"BarOS до MVP",progress:55,confidence:"estimated",color:"#ef6b7e",next:"Довести до MVP: AI-методист, загрузка файлов, права/ограничения, PWA/иконки и финальное тестирование.",note:"Оценка по обсуждённым реализованным модулям и оставшимся требованиям. Не подтверждённый процент."},
    {id:"2gis",name:"2GIS: Настойка + Бульдог",progress:38,confidence:"user",color:"#f0bd72",next:"Продолжить работу в 2GIS; отдельно закрыть товары «Настойки», фото и оставшиеся карточки/настройки.",note:"35–40% — текущая оценка пользователя. В интерфейсе показана середина диапазона: 38%."},
    {id:"barhub",name:"BarHub 2027 — обучение",progress:20,confidence:"estimated",color:"#75bdd8",next:"Продолжить обучение меню и базовых категорий; затем вернуться к командной подготовке и R&D.",note:"Подготовка начата, но большая часть программы ещё впереди. Проект временно снижен по приоритету."},
    {id:"marketing",name:"Стратегия маркетинга",progress:15,confidence:"estimated",color:"#e8798c",next:"Собрать стратегию «Настойки» и «Бульдога»: цели, сегменты, контент, офферы, каналы, метрики и 30-дневный план.",note:"Есть анализ отзывов и операционные работы, но целостная стратегия ещё не завершена."},
    {id:"menu",name:"Сдача меню → повышение ставки",progress:25,confidence:"estimated",color:"#aab8ff",next:"Продолжить изучение и провести проверочный тест до уверенного прохождения полной сдачи.",note:"Изучение уже идёт, но достоверного процента выученного меню нет; 25% — консервативная рабочая оценка."},
    {id:"agayo",name:"Доделать сайт AGAYO",progress:70,confidence:"estimated",color:"#ff9f72",next:"Закрыть промокоды, YooKassa/провайдеры, редактирование галереи/отзывов, мобайл-админку и финальный QA.",note:"Основной сайт и админ-функции уже существуют; процент оценочный по списку известных хвостов."}
  ],
  tasks:[
    {id:crypto.randomUUID(),title:"Сформировать чек-лист MVP BarOS",projectId:"baros",priority:"high",status:"active",xp:180,estimate:35,deadline:"",notes:"Зафиксировать, что точно входит в MVP и что уходит после релиза.",createdAt:Date.now()},
    {id:crypto.randomUUID(),title:"Продолжить 2GIS: товары и фото",projectId:"2gis",priority:"high",status:"active",xp:160,estimate:45,deadline:"",notes:"Товары «Настойки» + разобраться с оставшимися фотографиями.",createdAt:Date.now()},
    {id:crypto.randomUUID(),title:"Сделать 1 блок маркетинговой стратегии",projectId:"marketing",priority:"high",status:"active",xp:180,estimate:50,deadline:"",notes:"Не вся стратегия сразу: один законченный блок.",createdAt:Date.now()},
    {id:crypto.randomUUID(),title:"25 минут повторения меню",projectId:"menu",priority:"high",status:"active",xp:120,estimate:25,deadline:"",notes:"После сессии — 10 вопросов без подсказок.",createdAt:Date.now()},
    {id:crypto.randomUUID(),title:"BarHub: один учебный модуль",projectId:"barhub",priority:"medium",status:"active",xp:140,estimate:35,deadline:"",notes:"Без попытки закрыть весь BarHub за день.",createdAt:Date.now()},
    {id:crypto.randomUUID(),title:"AGAYO: закрыть один технический хвост",projectId:"agayo",priority:"medium",status:"active",xp:160,estimate:45,deadline:"",notes:"Выбрать один хвост и довести до состояния 'проверено'.",createdAt:Date.now()}
  ],
  debts:[
    {id:"tbank",name:"Т-Банк — кредитная карта",amount:50000,dueAmount:3600,dueDate:"2026-10-04",notes:"Баланс указан по последним данным; ближайший обязательный платёж требует актуализации."},
    {id:"alpha",name:"Альфа-Банк — кредитная карта",amount:32000,dueAmount:1500,dueDate:"2026-10-06",notes:"1 500 ₽ до 6 октября по последним данным."},
    {id:"amoney",name:"А-Деньги",amount:7000,dueAmount:0,dueDate:"2026-10-05",notes:"Последний зафиксированный остаток — 7 000 ₽; начисления меняют сумму, поэтому требуется актуализация."},
    {id:"split",name:"Яндекс Сплит",amount:18000,dueAmount:0,dueDate:"",notes:"Без процентов; дата не зафиксирована."},
    {id:"business",name:"Бизнес-счёт Т-Банк",amount:3000,dueAmount:0,dueDate:"",notes:"Без процентов; можно тянуть ограниченное время."},
    {id:"tax",name:"Налоги",amount:600,dueAmount:0,dueDate:"",notes:"Последняя известная сумма."},
    {id:"person",name:"Долг человеку",amount:25000,dueAmount:0,dueDate:"",notes:"Текущий остаток требует подтверждения: в истории были разные промежуточные суммы."}
  ],
  payments:[{id:crypto.randomUUID(),name:"ВТБ — погашено",amount:70000,date:"2026-09-01",notes:"Подтверждённо закрыт кредит ВТБ; дата служебная, точная дата закрытия не подтверждена."}],
  sessions:[],
  unlocked:["start"],
  dailyLog:{},
  settings:{companion:true,notifications:false}
};
let state=load();
let currentTaskFilter="active";
let currentFinFilter="debts";
let timer={total:1500,left:1500,running:false,tick:null,startedAt:null,taskId:null,elapsed:0};
let deferredPrompt=null;

function load(){
  try{
    const raw=localStorage.getItem(STORAGE_KEY);
    if(!raw) return structuredClone(seed);
    const parsed=JSON.parse(raw);
    return {...structuredClone(seed),...parsed,settings:{...seed.settings,...(parsed.settings||{})}};
  }catch(e){return structuredClone(seed)}
}
function save(){localStorage.setItem(STORAGE_KEY,JSON.stringify(state));}
function money(n){return new Intl.NumberFormat("ru-RU").format(Math.max(0,Math.round(Number(n)||0)))+" ₽"}
function esc(s=""){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[m]))}
function project(id){return state.projects.find(p=>p.id===id)}
function todayKey(d=new Date()){return d.toISOString().slice(0,10)}
function durationMin(session){return Math.max(0,Math.round((session.seconds||0)/60))}
function confidenceLabel(c){return c==="user"?"оценка пользователя":c==="confirmed"?"подтверждено":"оценочно"}
function showToast(msg){const el=document.querySelector("#toast");el.textContent=msg;el.classList.remove("hidden");clearTimeout(showToast.t);showToast.t=setTimeout(()=>el.classList.add("hidden"),2500)}
function notify(title,body){
  if(state.settings.notifications && "Notification" in window && Notification.permission==="granted"){
    try{new Notification(title,{body,icon:"./icon.svg"})}catch(e){}
  }
}
function page(name){
  document.querySelectorAll(".page").forEach(x=>x.classList.toggle("active",x.dataset.pageView===name));
  document.querySelectorAll("#nav button").forEach(x=>x.classList.toggle("active",x.dataset.page===name));
  const titles={home:"Главная",quests:"Квесты",projects:"Проекты",focus:"Фокус",finance:"Финансы",analytics:"Аналитика",achievements:"Ачивки",settings:"Настройки"};
  document.querySelector("#pageTitle").textContent=titles[name]||"WorkHub";
  document.querySelector(".sidebar").classList.remove("open");
  renderAll();
}
function renderAll(){
  renderHeader(); renderProjects(); renderTasks(); renderFinance(); renderFocus(); renderAnalytics(); renderAchievements(); renderXp();
}
function renderHeader(){
  const d=new Date();
  document.querySelector("#todayLabel").textContent=d.toLocaleDateString("ru-RU",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
}
function renderXp(){
  const level=Math.floor(state.xp/1000)+1, within=state.xp%1000;
  document.querySelector("#levelLabel").textContent="Уровень "+level;
  document.querySelector("#levelMini").textContent="Lv. "+level;
  document.querySelector("#xpLabel").textContent=within+" / 1000 XP";
  document.querySelector("#xpBar").style.width=(within/10)+"%";
}
function renderProjects(){
  const overview=document.querySelector("#projectOverview");
  overview.innerHTML=state.projects.map(p=>`<div class="project-row">
    <div class="project-title"><strong>${esc(p.name)}</strong><span class="confidence ${p.confidence}">${confidenceLabel(p.confidence)}</span></div>
    <div class="bar"><i style="width:${p.progress}%;background:${p.color||"var(--accent)"}"></i></div>
    <strong>${p.progress}%</strong>
  </div>`).join("");
  const cards=document.querySelector("#projectCards");
  cards.innerHTML=state.projects.map(p=>`<article class="project-card">
    <span class="confidence ${p.confidence}">${confidenceLabel(p.confidence)}</span>
    <h3>${esc(p.name)}</h3><div class="progress-value">${p.progress}%</div>
    <div class="bar large"><i style="width:${p.progress}%;background:${p.color||"var(--accent)"}"></i></div>
    <p class="project-next"><strong>Следующий шаг:</strong> ${esc(p.next||"Не задан")}</p>
    <p class="muted tiny">${esc(p.note||"")}</p>
    <footer><span></span><button class="ghost" data-edit-project="${p.id}">Изменить</button></footer>
  </article>`).join("");
}
function taskHtml(t,compact=false){
  const p=project(t.projectId);
  return `<div class="task-item ${t.status==="done"?"done":""}">
    <button class="task-check ${t.status==="done"?"checked":""}" data-toggle-task="${t.id}" aria-label="Готово">${t.status==="done"?"✓":""}</button>
    <div><strong>${esc(t.title)}</strong><div class="task-meta">${p?esc(p.name):"Без проекта"} · ${t.estimate||0} мин · +${t.xp||0} XP${t.deadline?" · "+new Date(t.deadline).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):""}</div></div>
    <span class="priority ${t.priority}">${t.priority==="high"?"Высокий":t.priority==="medium"?"Средний":"Низкий"}</span>
  </div>`
}
function renderTasks(){
  const active=state.tasks.filter(t=>t.status==="active").slice(0,5);
  document.querySelector("#todayTasks").innerHTML=active.length?active.map(t=>taskHtml(t,true)).join(""):'<p class="muted">Активных квестов нет.</p>';
  const filtered=state.tasks.filter(t=>currentTaskFilter==="all"||t.status===currentTaskFilter);
  document.querySelector("#questBoard").innerHTML=filtered.length?filtered.map(t=>{
    const p=project(t.projectId);
    return `<article class="quest-card">
      <div class="section-head" style="margin:0"><span class="priority ${t.priority}">${t.priority==="high"?"Высокий":t.priority==="medium"?"Средний":"Низкий"}</span><span class="xp">+${t.xp||0} XP</span></div>
      <h3>${esc(t.title)}</h3><p class="muted tiny">${p?esc(p.name):"Без проекта"} · ${t.estimate||0} мин</p>
      <p>${esc(t.notes||"")}</p>
      <footer><span class="muted tiny">${t.status==="active"?"Активен":t.status==="done"?"Готов":"Отменён"}</span>
      <div class="quest-actions">
        ${t.status==="active"?`<button class="ghost" data-status-task="${t.id}" data-status="done">✓</button><button class="ghost" data-status-task="${t.id}" data-status="cancelled">×</button>`:''}
        <button class="ghost" data-edit-task="${t.id}">✎</button>
      </div></footer>
    </article>`
  }).join(""):'<p class="muted">Здесь пока пусто.</p>';
  const select=document.querySelector("#focusTaskSelect");
  const old=select.value;
  select.innerHTML='<option value="">Без привязки к квесту</option>'+state.tasks.filter(t=>t.status==="active").map(t=>`<option value="${t.id}">${esc(t.title)}</option>`).join("");
  if([...select.options].some(o=>o.value===old)) select.value=old;
}
function debtSum(){return state.debts.reduce((a,d)=>a+(Number(d.amount)||0),0)}
function paidSum(){return state.payments.reduce((a,p)=>a+(Number(p.amount)||0),0)}
function renderFinance(){
  const rem=debtSum(), paid=paidSum(), total=rem+paid, pct=total?Math.round(paid/total*100):100;
  document.querySelector("#debtRemaining").textContent=money(rem);
  document.querySelector("#debtPaid").textContent=money(paid);
  document.querySelector("#debtBar").style.width=pct+"%";
  document.querySelector("#debtConfidence").textContent="Погашено — только подтверждённая в штабе сумма; часть истории платежей может отсутствовать.";
  document.querySelector("#financeRemainingBig").textContent=money(rem);
  document.querySelector("#financePaidBig").textContent=money(paid);
  document.querySelector("#financePercent").textContent=pct+"%";
  document.querySelector("#financeDonut").style.background=`conic-gradient(var(--accent) ${pct}%,#262630 0)`;
  document.querySelector("#financeNote").textContent="Текущий остаток содержит позиции, которые нужно периодически актуализировать.";
  const wrap=document.querySelector("#financeTableWrap");
  if(currentFinFilter==="debts"){
    wrap.innerHTML=`<table class="finance-table"><thead><tr><th>Долг</th><th>Остаток</th><th>Ближайший платёж</th><th>Срок</th><th></th></tr></thead><tbody>${state.debts.map(d=>`<tr><td><strong>${esc(d.name)}</strong><div class="muted tiny">${esc(d.notes||"")}</div></td><td class="money-negative">${money(d.amount)}</td><td>${d.dueAmount?money(d.dueAmount):"—"}</td><td>${d.dueDate||"—"}</td><td><button class="ghost" data-pay-debt="${d.id}">Внести</button></td></tr>`).join("")}</tbody></table>`;
  }else{
    wrap.innerHTML=`<table class="finance-table"><thead><tr><th>Платёж</th><th>Сумма</th><th>Дата</th><th>Комментарий</th></tr></thead><tbody>${state.payments.slice().reverse().map(p=>`<tr><td>${esc(p.name)}</td><td class="money-positive">${money(p.amount)}</td><td>${p.date||"—"}</td><td class="muted">${esc(p.notes||"")}</td></tr>`).join("")}</tbody></table>`;
  }
}
function renderFocus(){
  const fmt=s=>String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");
  document.querySelector("#focusTimer").textContent=fmt(timer.left);
  document.querySelector("#miniTimer").textContent=fmt(timer.left);
  const sessions=state.sessions.slice().reverse().slice(0,10);
  document.querySelector("#focusSessions").innerHTML=sessions.length?sessions.map(s=>`<div class="task-item"><span>◉</span><div><strong>${durationMin(s)} мин</strong><div class="task-meta">${new Date(s.startedAt).toLocaleString("ru-RU")} · ${s.taskId?(state.tasks.find(t=>t.id===s.taskId)?.title||"Квест"):"Без квеста"}</div></div><span class="muted">${s.completed?"завершено":"сохранено"}</span></div>`).join(""):'<p class="muted">Сессий пока нет.</p>';
}
function focusStart(){
  if(timer.running){focusPause();return}
  timer.running=true;timer.startedAt=timer.startedAt||Date.now();timer.taskId=document.querySelector("#focusTaskSelect").value||null;
  timer.tick=setInterval(()=>{timer.left--;timer.elapsed++;renderFocus();if(timer.left<=0){completeFocus()}},1000);
  document.querySelector("#focusStart").textContent="Ⅱ";document.querySelector("#miniFocusStart").textContent="Ⅱ Пауза";
}
function focusPause(){timer.running=false;clearInterval(timer.tick);document.querySelector("#focusStart").textContent="▶";document.querySelector("#miniFocusStart").textContent="▶ Начать"}
function completeFocus(){
  focusPause();state.sessions.push({id:crypto.randomUUID(),startedAt:timer.startedAt||Date.now(),seconds:timer.total,taskId:timer.taskId,completed:true});state.xp+=50;save();
  showToast("Фокус завершён: +50 XP");notify("WorkHub","Фокус-сессия завершена. +50 XP");
  resetFocus(false);unlockChecks();renderAll();
}
function saveFocus(){
  if(timer.elapsed<60){showToast("Сохрани хотя бы 1 минуту фактического фокуса.");return}
  state.sessions.push({id:crypto.randomUUID(),startedAt:timer.startedAt||Date.now(),seconds:timer.elapsed,taskId:timer.taskId,completed:false});state.xp+=Math.min(40,Math.floor(timer.elapsed/60));save();
  showToast("Фактическое время сохранено.");resetFocus(false);renderAll();
}
function resetFocus(render=true){focusPause();timer.left=timer.total;timer.startedAt=null;timer.elapsed=0;timer.taskId=null;if(render)renderFocus()}
function renderAnalytics(){
  const now=Date.now(), weekAgo=now-7*86400000, recent=state.sessions.filter(s=>s.startedAt>=weekAgo);
  const mins=recent.reduce((a,s)=>a+durationMin(s),0);
  document.querySelector("#weekFocus").textContent=(mins/60).toFixed(1).replace(".",",")+" ч";
  const done=state.tasks.filter(t=>t.status==="done" && (t.completedAt||0)>=weekAgo).length;
  document.querySelector("#weekDone").textContent=done;
  document.querySelector("#metricFocus7").textContent=(mins/60).toFixed(1).replace(".",",")+" ч";
  document.querySelector("#metricDone7").textContent=done;
  const byHour=Array.from({length:24},()=>0);
  recent.forEach(s=>{byHour[new Date(s.startedAt).getHours()]+=durationMin(s)});
  const max=Math.max(1,...byHour);
  document.querySelector("#hourChart").innerHTML=byHour.map((v,h)=>`<div class="hour-col"><i style="height:${Math.max(2,v/max*190)}px"></i><span>${h}</span></div>`).join("");
  const best=byHour.indexOf(Math.max(...byHour));
  document.querySelector("#metricBestHour").textContent=Math.max(...byHour)>0?`${String(best).padStart(2,"0")}:00`:"—";
  const days=[0,0,0,0,0,0,0], labels=["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
  recent.forEach(s=>{let d=new Date(s.startedAt).getDay();d=d===0?6:d-1;days[d]+=durationMin(s)});
  const dm=Math.max(1,...days);document.querySelector("#weekBars").innerHTML=days.map((v,i)=>`<span style="height:${Math.max(8,v/dm*100)}%"><em>${labels[i]}</em></span>`).join("");
  document.querySelector("#progressChart").innerHTML=state.projects.map(p=>`<div class="row"><span>${esc(p.name)}</span><div class="bar"><i style="width:${p.progress}%;background:${p.color}"></i></div><strong>${p.progress}%</strong></div>`).join("");
  const activeDays=new Set(state.sessions.filter(s=>s.startedAt>=weekAgo).map(s=>todayKey(new Date(s.startedAt)))).size;
  document.querySelector("#metricStreak").textContent=activeDays+" дн.";
}
const achievementDefs=[
  {id:"start",icon:"🎮",title:"Новая игра",desc:"Запустить рабочий штаб.",xp:0,test:()=>true},
  {id:"firstQuest",icon:"⚔️",title:"Первый квест",desc:"Закрыть первую задачу.",xp:100,test:()=>state.tasks.some(t=>t.status==="done")},
  {id:"focus25",icon:"🧠",title:"Не отвлекаться",desc:"Завершить 25 минут фокуса.",xp:150,test:()=>state.sessions.some(s=>s.completed&&s.seconds>=1500)},
  {id:"threeQuests",icon:"🔥",title:"Комбо x3",desc:"Закрыть 3 квеста.",xp:200,test:()=>state.tasks.filter(t=>t.status==="done").length>=3},
  {id:"debtPayment",icon:"₽",title:"Минус один кусок долга",desc:"Внести новый платёж по долгу.",xp:180,test:()=>state.payments.length>=2},
  {id:"barosMvp",icon:"💻",title:"MVP BarOS",desc:"Довести BarOS до 100%.",xp:800,test:()=>project("baros")?.progress>=100},
  {id:"menuPass",icon:"🍸",title:"Ставка повышена",desc:"Подтвердить сдачу меню.",xp:600,test:()=>project("menu")?.progress>=100},
  {id:"agayoDone",icon:"🌐",title:"AGAYO shipped",desc:"Довести сайт AGAYO до 100%.",xp:700,test:()=>project("agayo")?.progress>=100}
];
function unlockChecks(){
  let gained=0;
  achievementDefs.forEach(a=>{if(a.test()&&!state.unlocked.includes(a.id)){state.unlocked.push(a.id);state.xp+=a.xp;gained+=a.xp;showCompanion("Ачивка: "+a.title,`Готово. +${a.xp} XP. Это уже факт, не обещание.`)}});
  if(gained) save();
}
function renderAchievements(){
  document.querySelector("#achievementGrid").innerHTML=achievementDefs.map(a=>{const unlocked=state.unlocked.includes(a.id)||a.test();return `<article class="achievement ${unlocked?"":"locked"}"><div class="badge">${a.icon}</div><h3>${esc(a.title)}</h3><p>${esc(a.desc)}</p><span class="xp">${unlocked?"Получено":"+"+a.xp+" XP"}</span></article>`}).join("");
}
function showCompanion(title,text){
  if(!state.settings.companion)return;
  document.querySelector("#companionTitle").textContent=title;document.querySelector("#companionText").textContent=text;document.querySelector("#companionBanner").classList.remove("hidden");
}
function maybeCompanion(){
  const stalled=state.tasks.filter(t=>t.status==="active" && Date.now()-(t.createdAt||Date.now())>3*86400000);
  if(stalled.length)showCompanion("Квест завис","`"+stalled[0].title+"` висит больше 3 дней. Не надо закрывать всё — сделай следующий шаг на 15–25 минут.");
}
function completeTask(id,status="done"){
  const t=state.tasks.find(x=>x.id===id);if(!t)return;
  if(t.status==="done"&&status==="done")return;
  t.status=status;if(status==="done"){t.completedAt=Date.now();state.xp+=Number(t.xp)||0;showToast("Квест закрыт: +"+(t.xp||0)+" XP");notify("Квест закрыт",t.title);showCompanion("Квест закрыт",t.title+" — готово. Хорошо. Теперь не разгоняйся хаотично: выбери следующий один шаг.");}
  save();unlockChecks();renderAll();
}
function openTask(id=null){
  const d=document.querySelector("#taskDialog"),t=state.tasks.find(x=>x.id===id);
  document.querySelector("#taskDialogTitle").textContent=t?"Изменить квест":"Новый квест";
  document.querySelector("#taskId").value=t?.id||"";document.querySelector("#taskTitle").value=t?.title||"";
  document.querySelector("#taskProject").innerHTML='<option value="">Без проекта</option>'+state.projects.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join("");
  document.querySelector("#taskProject").value=t?.projectId||"";document.querySelector("#taskPriority").value=t?.priority||"medium";document.querySelector("#taskXp").value=t?.xp||100;document.querySelector("#taskEstimate").value=t?.estimate||25;document.querySelector("#taskDeadline").value=t?.deadline||"";document.querySelector("#taskNotes").value=t?.notes||"";d.showModal();
}
function saveTask(){
  const id=document.querySelector("#taskId").value, title=document.querySelector("#taskTitle").value.trim();if(!title)return;
  const data={title,projectId:document.querySelector("#taskProject").value,priority:document.querySelector("#taskPriority").value,xp:Number(document.querySelector("#taskXp").value)||0,estimate:Number(document.querySelector("#taskEstimate").value)||0,deadline:document.querySelector("#taskDeadline").value,notes:document.querySelector("#taskNotes").value.trim()};
  if(id){Object.assign(state.tasks.find(t=>t.id===id),data)}else state.tasks.push({id:crypto.randomUUID(),status:"active",createdAt:Date.now(),...data});
  save();renderAll();
}
function openProject(id=null){
  const p=state.projects.find(x=>x.id===id);document.querySelector("#projectId").value=p?.id||"";document.querySelector("#projectName").value=p?.name||"";document.querySelector("#projectProgress").value=p?.progress||0;document.querySelector("#projectProgressLabel").textContent=(p?.progress||0)+"%";document.querySelector("#projectConfidence").value=p?.confidence||"estimated";document.querySelector("#projectNext").value=p?.next||"";document.querySelector("#projectDialog").showModal();
}
function saveProject(){
  const id=document.querySelector("#projectId").value,name=document.querySelector("#projectName").value.trim();if(!name)return;
  let progress=Number(document.querySelector("#projectProgress").value)||0;
  if(state.strictMode&&progress===100&&id){
    const undone=state.tasks.some(t=>t.projectId===id&&t.status==="active");if(undone){progress=99;showToast("Честный режим: есть активные обязательные квесты, максимум 99%.")}
  }
  const data={name,progress,confidence:document.querySelector("#projectConfidence").value,next:document.querySelector("#projectNext").value.trim()};
  if(id)Object.assign(project(id),data);else state.projects.push({id:crypto.randomUUID(),color:"#ef7182",note:"Создано пользователем.",...data});
  save();unlockChecks();renderAll();
}
function openFinance(){document.querySelector("#financeForm").reset();document.querySelector("#financeDialog").showModal()}
function saveFinance(){
  const name=document.querySelector("#financeName").value.trim();if(!name)return;
  state.debts.push({id:crypto.randomUUID(),name,amount:Number(document.querySelector("#financeAmount").value)||0,dueAmount:Number(document.querySelector("#financeDueAmount").value)||0,dueDate:document.querySelector("#financeDueDate").value,notes:document.querySelector("#financeNotes").value.trim()});save();renderAll();
}
function payDebt(id){
  const d=state.debts.find(x=>x.id===id);if(!d)return;const raw=prompt(`Сколько внесено в «${d.name}»? Текущий остаток: ${money(d.amount)}`);if(raw===null)return;const amount=Number(String(raw).replace(",",".").replace(/\s/g,""));if(!Number.isFinite(amount)||amount<=0){showToast("Некорректная сумма");return}
  const paid=Math.min(amount,d.amount);d.amount=Math.max(0,d.amount-paid);state.payments.push({id:crypto.randomUUID(),name:d.name,amount:paid,date:todayKey(),notes:"Внесено через WorkHub"});state.xp+=20;save();unlockChecks();renderAll();showToast("Платёж записан. +20 XP");
}
function summary(){
  return `WORKHUB — актуальная сводка
Проекты:
${state.projects.map(p=>`- ${p.name}: ${p.progress}% (${confidenceLabel(p.confidence)}). Следующий шаг: ${p.next}`).join("\n")}

Активные квесты:
${state.tasks.filter(t=>t.status==="active").map(t=>`- ${t.title} [${t.priority}]`).join("\n")||"- нет"}

Финансы:
- Осталось по списку: ${money(debtSum())}
- Подтверждённо погашено в истории WorkHub: ${money(paidSum())}
- Позиции: ${state.debts.map(d=>d.name+" "+money(d.amount)).join("; ")}

Фокус за 7 дней: ${state.sessions.filter(s=>s.startedAt>=Date.now()-7*86400000).reduce((a,s)=>a+durationMin(s),0)} мин.
XP: ${state.xp}.`;
}
async function miniWindow(){
  const html=`<style>body{margin:0;background:#0c0c0f;color:#fff;font:14px system-ui;padding:14px}.box{border:1px solid #33333d;border-radius:16px;background:#15151b;padding:14px}h2{margin:0 0 8px}.timer{font-size:36px;font-weight:800;color:#f36c80}.muted{color:#92939c}button{background:#d94b60;color:white;border:0;border-radius:10px;padding:9px 12px}ul{padding-left:18px}</style><div class="box"><h2>WorkHub · Фокус</h2><div class="timer" id="t">${document.querySelector("#focusTimer").textContent}</div><p class="muted">Текущий квест</p><strong>${esc(state.tasks.find(t=>t.id===document.querySelector("#focusTaskSelect").value)?.title||"Без привязки")}</strong><ul>${state.tasks.filter(t=>t.status==="active").slice(0,3).map(t=>"<li>"+esc(t.title)+"</li>").join("")}</ul></div>`;
  try{
    if("documentPictureInPicture" in window){
      const w=await window.documentPictureInPicture.requestWindow({width:380,height:300});w.document.body.innerHTML=html;
      const sync=setInterval(()=>{if(w.closed){clearInterval(sync);return}const t=w.document.querySelector("#t");if(t)t.textContent=document.querySelector("#focusTimer").textContent},1000);
    }else{
      const w=window.open("","WorkHubMini","width=380,height=330,alwaysRaised=yes");if(!w){showToast("Браузер заблокировал окно.");return}w.document.write(html);
    }
  }catch(e){showToast("Мини-окно недоступно в этом браузере.");}
}
document.addEventListener("click",e=>{
  const b=e.target.closest("button,[data-goto]");if(!b)return;
  if(b.dataset.page)page(b.dataset.page);if(b.dataset.goto)page(b.dataset.goto);
  if(b.dataset.toggleTask){const t=state.tasks.find(x=>x.id===b.dataset.toggleTask);completeTask(t.id,t.status==="done"?"active":"done")}
  if(b.dataset.statusTask)completeTask(b.dataset.statusTask,b.dataset.status);
  if(b.dataset.editTask)openTask(b.dataset.editTask);
  if(b.dataset.editProject)openProject(b.dataset.editProject);
  if(b.dataset.payDebt)payDebt(b.dataset.payDebt);
});
document.querySelector("#menuBtn").onclick=()=>document.querySelector(".sidebar").classList.toggle("open");
document.querySelector("#quickAddBtn").onclick=()=>openTask();document.querySelector("#addTaskBtn").onclick=()=>openTask();
document.querySelector("#addProjectBtn").onclick=()=>openProject();document.querySelector("#addDebtBtn").onclick=openFinance;
document.querySelector("#saveTaskBtn").onclick=saveTask;document.querySelector("#saveProjectBtn").onclick=saveProject;document.querySelector("#saveFinanceBtn").onclick=saveFinance;
document.querySelector("#projectProgress").oninput=e=>document.querySelector("#projectProgressLabel").textContent=e.target.value+"%";
document.querySelectorAll("[data-task-filter]").forEach(b=>b.onclick=()=>{currentTaskFilter=b.dataset.taskFilter;document.querySelectorAll("[data-task-filter]").forEach(x=>x.classList.toggle("active",x===b));renderTasks()});
document.querySelectorAll("[data-fin-filter]").forEach(b=>b.onclick=()=>{currentFinFilter=b.dataset.finFilter;document.querySelectorAll("[data-fin-filter]").forEach(x=>x.classList.toggle("active",x===b));renderFinance()});
document.querySelectorAll("[data-focus-min]").forEach(b=>b.onclick=()=>{document.querySelectorAll("[data-focus-min]").forEach(x=>x.classList.toggle("active",x===b));timer.total=Number(b.dataset.focusMin)*60;resetFocus()});
document.querySelector("#focusStart").onclick=focusStart;document.querySelector("#miniFocusStart").onclick=()=>{page("focus");focusStart()};document.querySelector("#focusReset").onclick=()=>resetFocus();document.querySelector("#focusSave").onclick=saveFocus;document.querySelector("#focusMiniWindow").onclick=miniWindow;document.querySelector("#quickMiniBtn").onclick=miniWindow;
document.querySelector("#companionClose").onclick=()=>document.querySelector("#companionBanner").classList.add("hidden");
document.querySelector("#strictMode").checked=state.strictMode;document.querySelector("#strictMode").onchange=e=>{state.strictMode=e.target.checked;save()};
document.querySelector("#notifyBtn").onclick=async()=>{if(!("Notification" in window)){showToast("Системные уведомления не поддерживаются.");return}const p=await Notification.requestPermission();state.settings.notifications=p==="granted";save();showToast(p==="granted"?"Уведомления включены":"Разрешение не выдано")};
document.querySelector("#exportBtn").onclick=()=>{const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="workhub-backup-"+todayKey()+".json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};
document.querySelector("#importInput").onchange=async e=>{const f=e.target.files[0];if(!f)return;try{const parsed=JSON.parse(await f.text());state={...structuredClone(seed),...parsed};save();renderAll();showToast("Данные импортированы")}catch(err){showToast("Не удалось импортировать JSON")}};
document.querySelector("#copySummaryBtn").onclick=async()=>{await navigator.clipboard.writeText(summary());showToast("Сводка скопирована")};
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredPrompt=e;document.querySelector("#installBtn").classList.remove("hidden")});
document.querySelector("#installBtn").onclick=async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;document.querySelector("#installBtn").classList.add("hidden")};
if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
const initialPage=new URLSearchParams(location.search).get("page");
if(initialPage && ["home","quests","projects","focus","finance","analytics","achievements","settings"].includes(initialPage)) page(initialPage);
else renderAll();
unlockChecks();setTimeout(maybeCompanion,1200);
