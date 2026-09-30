(function(){
  const tip=document.createElement('div'); tip.className='tooltip'; document.body.appendChild(tip);
  function show(el){tip.textContent=el.dataset.definition||''; const r=el.getBoundingClientRect(); tip.style.display='block'; const w=tip.offsetWidth,h=tip.offsetHeight; let left=Math.min(window.innerWidth-w-12,Math.max(12,r.left)); let top=r.bottom+8; if(top+h>window.innerHeight-12) top=Math.max(12,r.top-h-8); tip.style.left=left+'px';tip.style.top=top+'px'}
  function hide(){tip.style.display='none'}
  document.addEventListener('mouseover',e=>{const el=e.target.closest('.term');if(el)show(el)});
  document.addEventListener('focusin',e=>{const el=e.target.closest('.term');if(el)show(el)});
  document.addEventListener('mouseout',e=>{if(e.target.closest('.term'))hide()});
  document.addEventListener('focusout',e=>{if(e.target.closest('.term'))hide()});
  document.addEventListener('click',e=>{const el=e.target.closest('.term'); if(el){e.preventDefault(); e.stopPropagation(); if(tip.style.display==='block') hide(); else show(el)} else hide()});
})();


(function(){
  // Gentle reveal animations.
  const reveal=()=>document.querySelectorAll('.reveal').forEach((el,i)=>{
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){el.classList.add('is-visible');return;}
    const io=new IntersectionObserver(entries=>entries.forEach(entry=>{
      if(entry.isIntersecting){setTimeout(()=>entry.target.classList.add('is-visible'),Math.min(i*35,180));io.unobserve(entry.target);}
    }),{threshold:.05});
    io.observe(el);
  });
  reveal();

  // Copy manager invite links.
  document.addEventListener('click',async e=>{
    const b=e.target.closest('[data-copy]');
    if(!b)return;
    try{
      await navigator.clipboard.writeText(b.dataset.copy||'');
      const old=b.textContent;b.textContent='Скопировано';b.classList.add('copied');
      setTimeout(()=>{b.textContent=old;b.classList.remove('copied')},1600);
    }catch(_){window.prompt('Скопируйте ссылку',b.dataset.copy||'');}
  });

  // Lightweight confirmation for destructive actions.
  document.addEventListener('submit',e=>{
    const form=e.target.closest('.confirm-form');
    if(form && !window.confirm(form.dataset.confirmText||'Подтвердить действие?')) e.preventDefault();
    const hard=e.target.closest('.hard-delete-form');
    if(hard && !window.confirm('Полное удаление необратимо. Данные заведения будут удалены навсегда. Продолжить?')) e.preventDefault();
  });

  // Progressive Web App install.
  let deferredPrompt=null;
  const installButton=document.getElementById('pwa-install');
  window.addEventListener('beforeinstallprompt',e=>{
    e.preventDefault();deferredPrompt=e;
    if(installButton) installButton.hidden=false;
  });
  if(installButton) installButton.addEventListener('click',async()=>{
    if(!deferredPrompt)return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt=null;installButton.hidden=true;
  });
  window.addEventListener('appinstalled',()=>{if(installButton)installButton.hidden=true;deferredPrompt=null;});

  if('serviceWorker' in navigator){
    window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
  }
})();


(function(){
  const tabs=[...document.querySelectorAll('[data-platform-tab]')];
  const panels=[...document.querySelectorAll('[data-platform-panel]')];
  if(!tabs.length || !panels.length) return;

  function activate(name, updateHash=true){
    tabs.forEach(t=>t.classList.toggle('is-active',t.dataset.platformTab===name));
    panels.forEach(p=>{
      const active=p.dataset.platformPanel===name;
      p.classList.toggle('is-active',active);
      p.hidden=!active;
    });
    if(updateHash && history.replaceState) history.replaceState(null,'','#'+name);
  }

  tabs.forEach(tab=>tab.addEventListener('click',()=>activate(tab.dataset.platformTab)));
  const initial=(location.hash||'').replace('#','');
  if(['venues','create','audit'].includes(initial)) activate(initial,false);
  else if(new URLSearchParams(location.search).get('error')) activate('create',false);
  else activate('venues',false);
})();
