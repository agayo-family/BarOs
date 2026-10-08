const CACHE = 'baros-v2-20261008-4';
const ASSETS = ['/static/v2/style.css?v=2.3.0','/static/v2/app.js?v=2.3.0','/static/v2/experience.css?v=2.3.0','/static/v2/shifts.css?v=2.3.0','/static/v2/games.css?v=2.3.0','/static/v2/theme-init.js?v=2.3.0','/static/v2/icon-192.png'];
self.addEventListener('install', e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>clients.claim())));
self.addEventListener('fetch', e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==self.location.origin)return;
  // Never cache API responses, sessions, lesson contents or personal statistics.
  if(u.pathname.startsWith('/static/v2/')) e.respondWith(fetch(e.request,{cache:'no-cache'}).then(response=>{if(response.ok){const copy=response.clone();e.waitUntil(caches.open(CACHE).then(cache=>cache.put(e.request,copy)))}return response}).catch(()=>caches.match(e.request).then(hit=>hit||Response.error())));
  else if(e.request.mode==='navigate') e.respondWith(fetch(e.request).catch(()=>new Response('<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width"><title>BarOS — нет связи</title><body style="font:18px system-ui;padding:40px;background:#f7f7fb;color:#24213d"><h1>Вы вне сети</h1><p>Для входа, уроков и сохранения теста нужен интернет. Ваши отправленные ответы сохранены на сервере.</p><a href="/app">Попробовать снова</a></body></html>',{headers:{'Content-Type':'text/html; charset=utf-8'}})));
});
self.addEventListener('push',e=>{let p={title:'BarOS',body:'У вас новое уведомление',url:'/app/notices'};try{p={...p,...e.data.json()}}catch{};e.waitUntil(self.registration.showNotification(p.title,{body:p.body,icon:'/static/v2/icon-192.png',badge:'/static/v2/icon-192.png',data:{url:p.url},tag:p.url}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const target=new URL(e.notification.data?.url||'/app/notices',self.location.origin);if(target.origin!==self.location.origin)return;e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{for(const c of cs){if('focus'in c){c.navigate(target.href);return c.focus()}}return clients.openWindow(target.href)}))});
