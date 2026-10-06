const CACHE='tincture-lab-v1';
const ASSETS=['./','./index.html','./styles.css','./app.js','./logic.mjs','./manifest.webmanifest','./icon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  e.respondWith(fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))));
});
self.addEventListener('periodicsync',e=>{if(e.tag==='expiry-check') e.waitUntil(checkExpiry())});
async function checkExpiry(){
  try{
    const req=indexedDB.open('tincture-lab-db',1);
    const db=await new Promise((res,rej)=>{req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error)});
    const tx=db.transaction('kv','readonly');const store=tx.objectStore('kv');const get=store.get('state');
    const state=await new Promise((res,rej)=>{get.onsuccess=()=>res(get.result?.value);get.onerror=()=>rej(get.error)});
    const now=Date.now(); const soon=(state?.batches||[]).filter(b=>!b.stoppedAt && new Date(b.expiresAt).getTime()-now<=3*86400000 && new Date(b.expiresAt).getTime()>=now);
    if(soon.length) await self.registration.showNotification('Tincture Lab: сроки годности',{body:String(soon.length)+' партий испортятся в течение 3 дней',icon:'./icon.svg',badge:'./icon.svg',tag:'expiry'});
  }catch(e){}
}
