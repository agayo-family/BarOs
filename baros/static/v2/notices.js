import {$,$$,api,btn,empty,esc,fmtDate,go,icon,notice,on,pageHead,state,toast} from './core.js?v=2.14.0';

function applyCount(unread){
 if(!state.me)return;
 state.me.unread=unread;
 for(const count of $$('[data-unread-count]')){
  count.hidden=unread===0;count.textContent=String(unread);
 }
 for(const dot of $$('[data-notice-dot]'))dot.hidden=unread===0;
 const bell=$('.topbar .bell');
 bell?.setAttribute('aria-label',unread?'Уведомления, непрочитанных: '+unread:'Уведомления');
}

function publishCount(unread){
 applyCount(unread);
 try{localStorage.setItem('baros:notice-change',JSON.stringify({account:state.me.account.id,at:Date.now()}))}catch{}
}

export function watchNotices(){
 const refresh=async()=>{
  const id=state.me?.account?.id;if(!id||document.hidden||state.focusAttempt)return;
  try{const {unread}=await api('/notices/count');if(state.me?.account?.id===id)applyCount(unread)}catch{}
 };
 const storage=event=>{
  if(event.key!=='baros:notice-change')return;
  try{if(JSON.parse(event.newValue)?.account===state.me?.account?.id)refresh()}catch{}
 };
 window.addEventListener('storage',storage);
 document.addEventListener('visibilitychange',refresh);
 const interval=window.setInterval(refresh,45000);
 return ()=>{
  window.clearInterval(interval);
  window.removeEventListener('storage',storage);
  document.removeEventListener('visibilitychange',refresh);
 };
}

export async function noticesPage(root){
 const [rows,count]=await Promise.all([api('/notices'),api('/notices/count')]);
 let unread=count.unread,filterUnread=unread>0;
 const groups=()=>{
  const byDate=new Map();
  for(const row of rows){
   if(filterUnread&&row.read)continue;
   const day=fmtDate(row.at,true);
   if(!byDate.has(day))byDate.set(day,[]);
   byDate.get(day).push(row);
  }
  return [...byDate];
 };
 function draw(){
  root.innerHTML=pageHead('Уведомления','',btn('Отметить все прочитанными','check','soft','data-read-all '+(unread?'':'disabled')))+
   `<div class="tabs notice-tabs" aria-label="Показ уведомлений"><button data-notice-filter="unread" class="${filterUnread?'active':''}" aria-pressed="${filterUnread}">Непрочитанные${unread?' · '+unread:''}</button>
    <button data-notice-filter="all" class="${!filterUnread?'active':''}" aria-pressed="${!filterUnread}">Все</button></div>
   ${groups().map(([day,items])=>`<section class="notice-day"><h2>${esc(day)}</h2><div class="card">
   ${items.map(row=>`<a class="line-item notice-row ${row.read?'':'unread'}" href="${esc(safePath(row.url))}" data-notice-id="${row.id}">
    <div class="icon-box">${icon(row.title.toLowerCase().includes('обучение')?'book':'bell')}</div>
    <div class="grow"><strong>${esc(row.title)}</strong><p>${esc(row.body)}</p></div>
    <time datetime="${esc(row.at)}">${new Date(row.at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</time>
   </a>`).join('')}</div></section>`).join('')||`<section class="card">${empty(filterUnread?'Всё прочитано':'Пока нет уведомлений',filterUnread?'':'Здесь появятся назначения и напоминания.','bell')}</section>`}
   <section class="card section-space"><details><summary>Уведомления браузера</summary>
   <div class="row section-space">${btn('Включить','bell','soft','data-enable-push')}<span data-push-state></span></div></details></section>`;
  on('[data-notice-filter]','click',(_,b)=>{filterUnread=b.dataset.noticeFilter==='unread';draw();$('[data-notice-filter='+b.dataset.noticeFilter+']',root)?.focus()},root);
  on('[data-read-all]','click',async(_,b)=>{
   b.disabled=true;
   try{
    const result=await api('/notices/read','POST',{});unread=result.unread;
    rows.forEach(row=>{row.read=true});publishCount(unread);draw();
    toast('Уведомления отмечены прочитанными');
   }finally{if(b.isConnected)b.disabled=false}
  },root);
  for(const link of $$('[data-notice-id]',root)){
   link.addEventListener('click',async event=>{
    if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
    const row=rows.find(item=>item.id===Number(link.dataset.noticeId));
    if(!row||row.read)return;
    event.preventDefault();
    if(link.getAttribute('aria-busy')==='true')return;
    link.setAttribute('aria-busy','true');
    try{const result=await api('/notices/'+row.id+'/read','POST',{});row.read=true;publishCount(result.unread);go(link.getAttribute('href'))}
    catch(error){link.removeAttribute('aria-busy');toast(error.message,true)}
   });
  }
  on('[data-enable-push]','click',enablePush,root);
 }
 function safePath(path){return /^\/app(?:\/|$)/.test(path||'')?path:'/app'}
 async function enablePush(){
  if(!('Notification'in window)||!('serviceWorker'in navigator))throw new Error('Этот браузер не поддерживает уведомления');
  if(await Notification.requestPermission()!=='granted')throw new Error('Разрешите уведомления в настройках браузера');
  const reg=await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const key=await api('/push/key');
  const padded=key.public_key.padEnd(Math.ceil(key.public_key.length/4)*4,'=').replace(/-/g,'+').replace(/_/g,'/');
  const sub=await reg.pushManager.getSubscription()||await reg.pushManager.subscribe({
   userVisibleOnly:true,applicationServerKey:Uint8Array.from(atob(padded),c=>c.charCodeAt(0)),
  });
  await api('/push','POST',sub.toJSON());
  $('[data-push-state]',root).textContent='Включены';
 }
 applyCount(unread);
 draw();
}
