// Runs only on the service worker's public, uncached recovery document.
// No account data, API responses, URLs or answers are stored in the browser.
(()=>{
  const title=document.querySelector('#connection-title');
  const status=document.querySelector('#connection-status');
  const retry=document.querySelector('#connection-retry');
  if(!title||!status||!retry)return;
  const delays=[2000,4000,8000,15000,30000];
  let started=Date.now(),timer=null,controller=null,attempt=0,stopped=false,opening=false;
  const online=()=>navigator.onLine!==false;
  function copy(){
    if(!online()){
      title.textContent='Ожидаем подключения';
      status.textContent=stopped?'Браузер сообщает об отсутствии сети. После восстановления подключения нажмите «Проверить связь».':'Браузер сообщает об отсутствии сети. Страница восстановится, когда связь появится.';
    }else if(Date.now()-started>=70000){
      title.textContent='Пока не удаётся подключиться';
      status.textContent=stopped?'Связь с сайтом не восстановилась. Проверьте подключение и нажмите «Проверить связь».':'Сайт пока не отвечает. Продолжаем проверять связь автоматически.';
    }else{
      title.textContent='Подключаемся к BarOS';
      status.textContent='Связь с сайтом прервалась. Проверяем подключение — страница откроется автоматически.';
    }
    document.body.dataset.state=(!online()||stopped)?'paused':'waiting';
  }
  function schedule(){
    clearTimeout(timer);
    if(stopped||opening||document.hidden)return;
    if(Date.now()-started>=180000){stopped=true;copy();return}
    timer=setTimeout(check,delays[Math.min(attempt++,delays.length-1)]);
  }
  async function check(){
    clearTimeout(timer);copy();
    if(controller||opening||document.hidden)return;
    if(!online()){schedule();return}
    controller=new AbortController();
    const active=controller,timeout=setTimeout(()=>active.abort(),12000);
    retry.setAttribute('aria-disabled','true');
    try{
      const health=await fetch('/health',{cache:'no-store',credentials:'omit',redirect:'error',signal:active.signal});
      const ready=health.ok&&health.headers.get('content-type')?.includes('application/json')&&await health.json();
      if(ready?.status==='ok'&&ready.service==='baros'){
        // Readiness alone must not cause a reload loop if the page itself fails,
        // or a hosting loading/interstitial page responds with HTTP 200.
        const page=await fetch(location.href,{cache:'no-store',credentials:'same-origin',signal:active.signal});
        if(page.ok&&new URL(page.url).origin===location.origin&&page.headers.get('content-type')?.includes('text/html')&&(await page.text()).includes('<meta name="baros-shell" content="1">')){
          opening=true;status.textContent='Связь восстановлена. Открываем страницу…';location.reload();return;
        }
      }
    }catch{}
    finally{clearTimeout(timeout);if(controller===active)controller=null;retry.removeAttribute('aria-disabled')}
    schedule();
  }
  retry.addEventListener('click',event=>{
    event.preventDefault();if(controller||opening)return;stopped=false;attempt=0;started=Date.now();check();
  });
  window.addEventListener('online',()=>{if(!stopped)check()});
  window.addEventListener('offline',()=>{controller?.abort();copy()});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){clearTimeout(timer);controller?.abort()}
    else if(!stopped)check();
  });
  window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);controller?.abort()},{once:true});
  copy();schedule();
})();
