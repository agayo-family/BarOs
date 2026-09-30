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
  if(['venues','create','ai','audit'].includes(initial)) activate(initial,false);
  else if(new URLSearchParams(location.search).get('error')) activate('create',false);
  else activate('venues',false);
})();


(function(){
  const forms=[...document.querySelectorAll('.ajax-create-form')];
  if(!forms.length) return;

  const toast=document.getElementById('editor-toast');
  let toastTimer=null;
  function showToast(message,kind='ok'){
    if(!toast) return;
    toast.textContent=message;
    toast.dataset.kind=kind;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>toast.classList.remove('show'),2200);
  }

  function appendLesson(data){
    const list=document.getElementById('lesson-list');
    const empty=document.getElementById('lesson-empty');
    if(empty) empty.remove();
    if(!list) return;
    const item=document.createElement('div');
    item.className='file editor-item editor-item-new';
    item.dataset.lessonId=data.id;
    const strong=document.createElement('strong');
    strong.textContent=data.sort_order+'. '+data.title;
    const preview=document.createElement('div');
    preview.className='muted small';
    const body=data.body||'';
    preview.textContent=body.length>220?body.slice(0,219)+'…':body;
    item.append(strong,preview);
    list.appendChild(item);
    const count=document.getElementById('lesson-count');
    if(count) count.textContent=String(Number(count.textContent||0)+1);
  }

  function appendQuestion(data,countValue){
    const list=document.getElementById('question-list');
    const empty=document.getElementById('question-empty');
    if(empty) empty.remove();
    if(!list) return;
    const item=document.createElement('div');
    item.className='file editor-item question-item editor-item-new';
    item.dataset.questionId=data.id;
    const pill=document.createElement('span');
    pill.className='pill';
    pill.textContent=data.type_label||data.question_type||'question';
    const text=document.createElement('span');
    text.textContent=data.prompt;
    item.append(pill,document.createTextNode(' '),text);
    list.appendChild(item);
    ['question-count','question-count-inline'].forEach(id=>{
      const el=document.getElementById(id);
      if(el) el.textContent=String(countValue);
    });
  }

  forms.forEach(form=>{
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      const button=form.querySelector('button[type="submit"]');
      const label=button?.querySelector('.button-label');
      const original=label?.textContent||button?.textContent||'Сохранить';
      if(button) button.disabled=true;
      if(label) label.textContent='Сохраняю…';

      try{
        const response=await fetch(form.action,{
          method:'POST',
          body:new FormData(form),
          headers:{'X-BarOS-Ajax':'1','Accept':'application/json'},
          credentials:'same-origin'
        });
        if(!response.ok) throw new Error('HTTP '+response.status);
        const payload=await response.json();
        if(!payload.ok) throw new Error('Save failed');
        if(form.dataset.createKind==='lesson') appendLesson(payload.lesson);
        if(form.dataset.createKind==='question') appendQuestion(payload.question,payload.count);
        form.reset();
        const first=form.querySelector('input:not([type="hidden"]),textarea,select');
        if(first) first.focus({preventScroll:true});
        showToast(form.dataset.createKind==='lesson'?'Урок добавлен без перезагрузки':'Вопрос добавлен без перезагрузки');
      }catch(error){
        showToast('Не удалось сохранить. Попробуйте ещё раз.','error');
      }finally{
        if(button) button.disabled=false;
        if(label) label.textContent=original;
      }
    });
  });
})();


(function(){
  const form=document.querySelector('.ai-generation-form');
  const list=document.getElementById('ai-generation-list');
  if(!form || !list) return;

  const countEl=document.getElementById('ai-generation-count');
  const polling=new Map();

  function statusInfo(status){
    if(status==='pending') return {label:'В ПРОЦЕССЕ',cls:'status-readonly'};
    if(status==='complete') return {label:'ГОТОВ',cls:'status-active'};
    if(status==='imported') return {label:'ИМПОРТИРОВАН',cls:'status-active'};
    if(status==='error') return {label:'ОШИБКА',cls:'status-suspended'};
    if(status==='limited') return {label:'ЛИМИТ',cls:'status-readonly'};
    if(status==='disabled') return {label:'AI OFF',cls:'status-archived'};
    return {label:String(status||'').toUpperCase(),cls:'status-archived'};
  }

  function createCard(g,statusUrl,detailUrl){
    const empty=document.getElementById('ai-empty-history');
    if(empty) empty.remove();

    const card=document.createElement('article');
    card.className='card premium-card ai-generation-card ai-generation-card-new';
    card.dataset.generationId=g.id;
    card.dataset.status=g.status;
    card.dataset.statusUrl=statusUrl||('/ai/training-draft/'+g.id+'/status');

    card.innerHTML=
      '<div class="row space mobile-stack">'+
        '<div class="ai-generation-main">'+
          '<div class="row wrap"><strong class="ai-generation-title"></strong><span class="status-chip ai-gen-status"></span></div>'+
          '<div class="small muted ai-generation-subtitle"></div>'+
        '</div>'+
        '<div class="ai-generation-actions"><a class="btn secondary small-btn ai-open-draft">Готовится…</a></div>'+
      '</div>'+
      '<div class="ai-progress-wrap">'+
        '<div class="row space"><span class="small ai-phase-message"></span><span class="small muted ai-progress-label"></span></div>'+
        '<div class="ai-progress"><span></span></div>'+
      '</div>'+
      '<div class="ai-generation-meta"></div>';

    list.prepend(card);
    if(countEl) countEl.textContent=String(Number(countEl.textContent||0)+1);
    updateCard(card,g,detailUrl);
    return card;
  }

  function updateCard(card,g,detailUrl){
    card.dataset.status=g.status;
    const info=statusInfo(g.status);
    const title=card.querySelector('.ai-generation-title');
    const chip=card.querySelector('.ai-gen-status');
    const subtitle=card.querySelector('.ai-generation-subtitle');
    const phase=card.querySelector('.ai-phase-message');
    const progressLabel=card.querySelector('.ai-progress-label');
    const progressBar=card.querySelector('.ai-progress span');
    const open=card.querySelector('.ai-open-draft');
    const meta=card.querySelector('.ai-generation-meta');

    if(title) title.textContent='Черновик '+(g.short_id||String(g.id).slice(0,8));
    if(chip){
      chip.textContent=info.label;
      chip.className='status-chip ai-gen-status '+info.cls;
    }
    if(subtitle){
      const files=(g.progress?.upload_names||[]).length;
      subtitle.textContent=(g.role_label||g.role||'Все роли')+' · '+(g.created_at_label||'только что')+(files?' · '+files+' файл(а)':'');
    }
    const p=Math.max(0,Math.min(100,Number(g.progress?.progress||0)));
    if(phase) phase.textContent=g.progress?.message||'Обновляем статус…';
    if(progressLabel) progressLabel.textContent=p+'%';
    if(progressBar) progressBar.style.width=p+'%';

    if(open){
      const canOpen=Boolean(g.openable);
      open.textContent=canOpen?'Открыть':'Готовится…';
      open.classList.toggle('is-disabled',!canOpen);
      open.setAttribute('aria-disabled',canOpen?'false':'true');
      if(canOpen) open.href=detailUrl||('/ai/training-draft/'+g.id);
      else open.removeAttribute('href');
    }

    if(meta){
      meta.replaceChildren();
      if(g.status==='pending'){
        const live=document.createElement('span');
        live.className='ai-live-indicator';
        live.innerHTML='<i></i><span></span>';
        live.querySelector('span').textContent='AI работает в фоне — можно продолжать работу в BarOS';
        meta.appendChild(live);
      }else if(g.status==='complete' || g.status==='imported'){
        [
          [g.courses,'курсов'],
          [g.lessons,'уроков'],
          [g.questions,'вопросов'],
          [g.glossary,'терминов']
        ].forEach(([value,label])=>{
          const span=document.createElement('span');
          const strong=document.createElement('strong');
          strong.textContent=String(value||0);
          span.append(strong,document.createTextNode(' '+label));
          meta.appendChild(span);
        });
      }else if(g.status==='error'){
        const span=document.createElement('span');
        span.className='danger';
        span.textContent='Генерация не завершилась. Откройте карточку, чтобы увидеть результат и повторить.';
        meta.appendChild(span);
      }else{
        const span=document.createElement('span');
        span.className='muted';
        span.textContent=g.summary||'Генерация завершена.';
        meta.appendChild(span);
      }
    }
  }

  function schedulePoll(card,delay=1800){
    const id=card.dataset.generationId;
    if(!id || polling.has(id) || card.dataset.status!=='pending') return;
    const run=async()=>{
      polling.delete(id);
      if(card.dataset.status!=='pending') return;
      try{
        const response=await fetch(card.dataset.statusUrl,{
          headers:{'Accept':'application/json'},
          credentials:'same-origin',
          cache:'no-store'
        });
        if(!response.ok) throw new Error('HTTP '+response.status);
        const payload=await response.json();
        if(payload.ok && payload.generation){
          updateCard(card,payload.generation,payload.detail_url);
        }
      }catch(_){
        const phase=card.querySelector('.ai-phase-message');
        if(phase) phase.textContent='Связь с сервером временно потеряна. Повторяем проверку…';
      }
      if(card.dataset.status==='pending'){
        const next=document.hidden?5000:1800;
        const timer=setTimeout(run,next);
        polling.set(id,timer);
      }
    };
    const timer=setTimeout(run,delay);
    polling.set(id,timer);
  }

  list.querySelectorAll('.ai-generation-card[data-status="pending"]').forEach(card=>schedulePoll(card,400));

  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(form.classList.contains('is-loading')) return;

    const button=form.querySelector('button[type="submit"]');
    const label=button?.querySelector('.button-label');
    const original=label?.textContent||'Создать AI-черновик';
    form.classList.add('is-loading');
    if(button) button.disabled=true;
    if(label) label.textContent='Запускаю задачу…';

    try{
      const response=await fetch(form.action,{
        method:'POST',
        body:new FormData(form),
        headers:{'X-BarOS-Ajax':'1','Accept':'application/json'},
        credentials:'same-origin'
      });
      if(!response.ok) throw new Error('HTTP '+response.status);
      const payload=await response.json();
      if(!payload.ok || !payload.generation) throw new Error('Invalid response');

      const card=createCard(payload.generation,payload.status_url,payload.detail_url);
      card.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'nearest'});
      schedulePoll(card,500);
    }catch(_){
      const notice=document.createElement('div');
      notice.className='notice attention ai-start-error';
      notice.textContent='Не удалось запустить AI-задачу. Обновите страницу и попробуйте ещё раз.';
      form.appendChild(notice);
      setTimeout(()=>notice.remove(),4500);
    }finally{
      form.classList.remove('is-loading');
      if(button) button.disabled=false;
      if(label) label.textContent=original;
    }
  });
})();
