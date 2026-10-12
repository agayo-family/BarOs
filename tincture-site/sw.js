const CACHE='tincture-lab-tk-20261012-v3';
const ASSETS=['./','./index.html','./styles.css','./app.js','./logic.mjs','./recipes.mjs','./imports.mjs','./vendor/xlsx.full.min.js','./manifest.webmanifest','./icon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  // Cache only this app's static resources; cloud records and credentials must
  // never become cached responses. Only document requests get an HTML fallback.
  const url=new URL(e.request.url);
  if(url.origin!==self.location.origin)return;
  e.respondWith(fetch(e.request).then(r=>{if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy)).catch(()=>{});}return r}).catch(async()=>{
    const cached=await caches.match(e.request);if(cached)return cached;
    if(e.request.mode==='navigate')return caches.match('./index.html');
    return new Response('Ресурс недоступен офлайн',{status:503});
  }));
});
self.addEventListener('periodicsync',e=>{if(e.tag==='expiry-check') e.waitUntil(checkExpiry())});
async function checkExpiry(){
  try{
    const req=indexedDB.open('tincture-lab-db',1);
    const db=await new Promise((res,rej)=>{req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error)});
    const tx=db.transaction('kv','readonly');const store=tx.objectStore('kv');const get=store.get('state');
    const state=await new Promise((res,rej)=>{get.onsuccess=()=>res(get.result?.value);get.onerror=()=>rej(get.error)});
    const now=Date.now(); const soon=(state?.batches||[]).filter(b=>!b.stoppedAt && new Date(b.expiresAt).getTime()-now<=3*86400000 && new Date(b.expiresAt).getTime()>=now);
    if(soon.length) await self.registration.showNotification('Tincture Lab: сроки годности',{body:`${soon.length} партий испортятся в течение 3 дней`,icon:'./icon.svg',badge:'./icon.svg',tag:'expiry'});
  }catch(e){}
}
