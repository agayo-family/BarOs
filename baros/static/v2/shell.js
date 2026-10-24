/* Shared navigation behaviour, independent of API data. */
export function mountShell(){
 const sidebar=document.querySelector('#sidebar'),menu=document.querySelector('#mobile-menu'),overlay=document.querySelector('#mobile-overlay');
 const main=document.querySelector('.shell-main'),bottom=document.querySelector('.bottom-nav');
 if(!sidebar)return ()=>{};
 const media=window.matchMedia?.('(max-width: 1024px)');
 const mobile=()=>media?.matches??window.innerWidth<=1024;
 let opened=false,previous=null,oldOverflow='';
 const inert=(node,value)=>{if(node){node.inert=value;node.toggleAttribute('inert',value)}};
 function close(restore=false){
  const wasOpen=opened;opened=false;sidebar.classList.remove('open');overlay?.classList.remove('open');
  menu?.setAttribute('aria-expanded','false');inert(sidebar,mobile());inert(main,false);inert(bottom,false);
  inert(document.querySelector('#companion-root'),false);
  if(wasOpen&&!document.querySelector('.modal'))document.body.style.overflow=oldOverflow;
  if(restore&&wasOpen)(previous?.isConnected?previous:menu)?.focus({preventScroll:true});
 }
 function open(){
  if(!mobile())return;
  previous=menu;oldOverflow=document.body.style.overflow;opened=true;
  inert(sidebar,false);sidebar.classList.add('open');overlay?.classList.add('open');
  menu?.setAttribute('aria-expanded','true');inert(main,true);inert(bottom,true);
  inert(document.querySelector('#companion-root'),true);document.body.style.overflow='hidden';
  sidebar.querySelector('nav a')?.focus({preventScroll:true});
 }
 const toggle=()=>opened?close(true):open();
 menu?.setAttribute('aria-controls','sidebar');menu?.setAttribute('aria-expanded','false');
 menu?.addEventListener('click',toggle);overlay?.addEventListener('click',()=>close(true));
 const click=e=>{if(e.target.closest('.sidebar a,.sidebar [data-support],.bottom-nav a'))close(false)};
 document.addEventListener('click',click);
 const key=e=>{
  if(document.querySelector('.modal'))return;
  if(opened&&e.key==='Escape'){e.preventDefault();close(true);return}
  if(opened&&e.key==='Tab'){
   const list=[...sidebar.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled])')].filter(x=>!x.hidden&&window.getComputedStyle(x).display!=='none');
   const first=list[0],last=list.at(-1);
   if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}
   else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}
   return;
  }
  const list=e.target.closest?.('[role=tablist]');
  if(list&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){
   const tabs=[...list.querySelectorAll('[role=tab]:not([disabled])')];const index=tabs.indexOf(e.target);
   if(index<0)return;e.preventDefault();
   const next=tabs[e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];
   const id=next.id;next.click();(id?document.getElementById(id):next)?.focus({preventScroll:true});
  }
 };
 document.addEventListener('keydown',key);
 const resize=()=>close(false);media?.addEventListener?.('change',resize);close(false);
 document.querySelectorAll('.table-wrap').forEach(table=>{table.tabIndex=0;table.setAttribute('role','region');table.setAttribute('aria-label','Таблица. При необходимости прокрутите её по горизонтали.')});
 return ()=>{close(false);menu?.removeEventListener('click',toggle);document.removeEventListener('click',click);document.removeEventListener('keydown',key);media?.removeEventListener?.('change',resize)};
}
