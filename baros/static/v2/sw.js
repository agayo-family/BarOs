const CACHE = 'baros-v2-20261102-5';
const RECONNECT = '/static/v2/reconnect.js?v=2.13.2';
const ASSETS = ['/static/v2/landing.css?v=2.13.1','/static/v2/audit.css?v=2.13.1','/static/v2/shell.js?v=2.13.1','/static/v2/growth.css?v=2.13.1','/static/v2/style.css?v=2.13.1','/static/v2/app.js?v=2.13.1','/static/v2/experience.css?v=2.13.1','/static/v2/shifts.css?v=2.13.1','/static/v2/games.css?v=2.13.1','/static/v2/theme-init.js?v=2.13.1','/static/v2/icon-192.png',RECONNECT];

function recoveryPage(){
  return new Response(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>BarOS — подключение</title><script src="${RECONNECT}" defer></script><noscript><meta http-equiv="refresh" content="30"></noscript><style>
  :root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif;color:#24213d;background:#f7f7fb}*{box-sizing:border-box}body{margin:0;padding:24px;min-height:100vh;display:grid;place-items:center}main{width:min(100%,520px);padding:clamp(24px,6vw,48px);border:1px solid #e6e2f2;border-radius:28px;background:#fff;box-shadow:0 20px 70px #30215209}.brand{font-weight:800;font-size:24px;letter-spacing:-1px;color:#5b47d6}.brand span{color:#a996f3}h1{font-size:clamp(25px,5vw,32px);line-height:1.2;letter-spacing:-.6px;margin:24px 0 16px}p{margin:16px 0}.muted{color:#646079;font-size:14px}.status{display:flex;gap:12px;align-items:flex-start}.spinner{width:20px;height:20px;flex:0 0 20px;margin-top:5px;border:2px solid #e8e2ff;border-top-color:#5b47d6;border-radius:50%;animation:spin 1s linear infinite}a{display:inline-block;margin-top:8px;padding:12px 20px;border-radius:12px;background:#5b47d6;color:#fff;text-decoration:none;font-weight:600}a:focus-visible{outline:3px solid #a996f3;outline-offset:4px}a[aria-disabled=true]{opacity:.65}body[data-state=paused] .spinner{animation-play-state:paused}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}@media(prefers-color-scheme:dark){:root{color:#edeaf8;background:#15131f}main{background:#211e30;border-color:#383149}.muted{color:#b5afca}.brand{color:#b9a6ff}}
  </style></head><body><main><div class="brand" aria-label="BarOS">BarOS<span>•</span></div><h1 id="connection-title">Подключаемся к BarOS</h1><div class="status"><span class="spinner" aria-hidden="true"></span><p id="connection-status" role="status" aria-live="polite">Связь с сайтом прервалась. Проверяем подключение — страница откроется автоматически.</p></div><p class="muted">Это не удаляет уже сохранённые данные.</p><a href="" id="connection-retry">Проверить связь</a><noscript><p>Страница повторит попытку через 30 секунд. Для быстрого восстановления включите JavaScript.</p></noscript></main></body></html>`,{status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Retry-After':'8','X-BarOS-Recovery':'1','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"}});
}

async function navigation(request){
  // Retry only safe page reads. A single short gateway/network failure should
  // not replace a working page with an error; never replay an API call or write.
  for(const delay of [0,400,1200]){
    if(delay){if(self.navigator?.onLine===false)break;await new Promise(resolve=>setTimeout(resolve,delay))}
    try{
      const response=await fetch(request);
      if(response.status<500)return response;
      if(![502,503,504].includes(response.status))break;
    }catch{}
  }
  return recoveryPage();
}
self.addEventListener('install', e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>clients.claim())));
self.addEventListener('fetch', e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==self.location.origin)return;
  // Never cache API responses, sessions, lesson contents or personal statistics.
  if(u.pathname+u.search===RECONNECT) e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request,{cache:'no-cache'})));
  else if(u.pathname.startsWith('/static/v2/')) e.respondWith(fetch(e.request,{cache:'no-cache'}).then(response=>{if(response.ok){const copy=response.clone();e.waitUntil(caches.open(CACHE).then(cache=>cache.put(e.request,copy)))}return response}).catch(()=>caches.match(e.request).then(hit=>hit||Response.error())));
  else if(e.request.mode==='navigate'&&!u.pathname.startsWith('/api/')&&u.pathname!=='/health') e.respondWith(navigation(e.request));
});
self.addEventListener('push',e=>{let p={title:'BarOS',body:'У вас новое уведомление',url:'/app/notices'};try{p={...p,...e.data.json()}}catch{};e.waitUntil(self.registration.showNotification(p.title,{body:p.body,icon:'/static/v2/icon-192.png',badge:'/static/v2/icon-192.png',data:{url:p.url},tag:p.url}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const target=new URL(e.notification.data?.url||'/app/notices',self.location.origin);if(target.origin!==self.location.origin)return;e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{for(const c of cs){if('focus'in c){c.navigate(target.href);return c.focus()}}return clients.openWindow(target.href)}))});
