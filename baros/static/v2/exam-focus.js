import {api, btn, esc, go, notice, state} from './core.js?v=2.14.0';

export function focusRules(fixed=false){
 return notice('До начала убедитесь, что сможете пройти тест без перерыва. Выход из теста, смена вкладки или переход в другое приложение прервут попытку. '+(fixed?'При возвращении работа начнётся заново с теми же заданиями по утверждённой программе.':'При возвращении начнётся новая попытка с другой подборкой вопросов. При небольшом банке некоторые вопросы могут повториться.'),'warning','Во время теста оставайтесь на этой странице');
}

const keyFor=path=>'baros:interrupted-exam:'+state.me?.account?.id+':'+path;
export function hasInterruption(path){
 try{return Boolean(localStorage.getItem(keyFor(path)))}catch{return false}
}
function setInterruption(path,value){
 try{if(value)localStorage.setItem(keyFor(path),'1');else localStorage.removeItem(keyFor(path))}catch{}
}

export async function restartInterrupted(root,path,restart,target){
 root.innerHTML='<section class="card exam-interrupt" role="status"><h1>Попытка прервана</h1><p>Подготавливаем начало новой попытки…</p></section>';
 try{
  const result=await api(path+'/interrupt','POST',{});
  const next=result.interrupted||result.status==='interrupted'?await restart(result):null;
  setInterruption(path,false);
  go(next?target(next.id):location.pathname,true);
 }catch(error){
  root.innerHTML=`<section class="card exam-interrupt"><h1>Попытка прервана</h1><p role="alert">${esc(error.message)}</p>${btn('Повторить','refresh','primary','data-exam-restart')}</section>`;
  root.querySelector('[data-exam-restart]')?.addEventListener('click',()=>restartInterrupted(root,path,restart,target));
 }
}

export function protectAttempt(root,{path,restart,target,onInterrupt=()=>{}}){
 let stopped=false,inactive=false,blurred=false,flight=null,navigating=false,confirming=false;
 const accountId=state.me?.account?.id;
 const focus={
  interrupt(reason){
   if(stopped)return;
   if(!inactive){
    inactive=true;setInterruption(path,true);state.dirty=false;onInterrupt();
    root.innerHTML='<section class="card exam-interrupt" role="status"><h1>Попытка прервана</h1><p>Вопросы и таймер обновятся, когда вы вернётесь к тесту.</p></section>';
    const headers={'content-type':'application/json','x-csrf-token':state.me.csrf};
    flight=fetch('/api'+path+'/interrupt',{method:'POST',headers,body:'{}',credentials:'same-origin',keepalive:true})
     .then(response=>response.ok?response.json():null).catch(()=>null);
   }
   if(reason!=='departure')resume();
  },
  confirm(message){
   confirming=true;
   try{return confirm(message)}finally{setTimeout(()=>{confirming=false},0)}
  },
 };
 function visible(){return !document.hidden&&!blurred}
 async function resume(){
  if(!inactive||!visible()||stopped||navigating||state.me?.account?.id!==accountId)return;
  navigating=true;
  const result=await flight;
  if(stopped)return;
  if(!visible()){navigating=false;return}
  release();
  if(!result){await restartInterrupted(root,path,restart,target);return}
  try{
   const next=result.interrupted||result.status==='interrupted'?await restart(result):null;
   setInterruption(path,false);
   go(next?target(next.id):location.pathname,true);
  }catch{await restartInterrupted(root,path,restart,target)}
 }
 const hide=()=>{if(document.hidden)focus.interrupt('departure');else resume()};
 const blur=()=>{if(confirming)return;blurred=true;focus.interrupt('departure')};
 const returnFocus=()=>{blurred=false;resume()};
 const close=()=>focus.interrupt('departure');
 const online=()=>resume();
 function release(){
  if(stopped)return;
  stopped=true;
  if(state.focusAttempt===focus)state.focusAttempt=null;
  root.classList.remove('exam-focused');
  document.removeEventListener('visibilitychange',hide);
  window.removeEventListener('blur',blur);window.removeEventListener('focus',returnFocus);
  window.removeEventListener('pagehide',close);window.removeEventListener('pageshow',returnFocus);
  window.removeEventListener('online',online);
 }
 state.focusAttempt=focus;
 root.classList.add('exam-focused');
 document.addEventListener('visibilitychange',hide);
 window.addEventListener('blur',blur);window.addEventListener('focus',returnFocus);
 window.addEventListener('pagehide',close);window.addEventListener('pageshow',returnFocus);
 window.addEventListener('online',online);
 if(document.hidden)focus.interrupt('departure');
 return {release,confirm:focus.confirm};
}
