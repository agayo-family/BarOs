const CACHE='tincture-lab-shared-20261014-v2';
const ASSETS=['./','./index.html','./styles.css','./app.js','./logic.mjs','./recipes.mjs','./imports.mjs','./vendor/xlsx.full.min.js','./manifest.webmanifest','./icon.svg'];
const STATIC_URLS=new Set(ASSETS.map(path=>new URL(path,self.location.href).href));
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('tincture-lab-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  // Only the public application shell is cached. Authentication and working
  // data always go directly to the server and have no offline cached response.
  if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||!STATIC_URLS.has(url.href))return;
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy)).catch(()=>{});}
    return response;
  }).catch(async()=>{
    const cached=await caches.match(event.request);if(cached)return cached;
    return new Response('Для открытия приложения нужен интернет',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  }));
});
