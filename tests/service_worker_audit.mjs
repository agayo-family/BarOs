import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../baros/static/v2/sw.js',import.meta.url),'utf8');
const origin='https://baros.example';
function harness(fetcher,online=true){
 const handlers={},calls=[],delays=[];
 const self={location:{origin},navigator:{onLine:online},addEventListener:(name,fn)=>handlers[name]=fn};
 const caches={match:async()=>new Response('cached asset'),open:async()=>({put:async()=>{},addAll:async()=>{}})};
 vm.runInNewContext(source,{self,caches,URL,Response,setTimeout:(fn,ms)=>{delays.push(ms);queueMicrotask(fn)},fetch:async request=>{calls.push(request);return fetcher(request)}});
 return {calls,delays,handle(path,method='GET',mode='navigate'){
  const request={url:new URL(path,origin).href,method,mode};let response;
  handlers.fetch({request,respondWith:p=>response=p,waitUntil:()=>{}});return {request,response};
 }};
}
async function recovery(fetcher){
 const h=harness(fetcher),{request,response}=h.handle('/join?invitation=preserve-me');
 const r=await response,text=await r.text();
 assert.equal(r.status,503);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('retry-after'),'8');assert.equal(r.headers.get('x-baros-recovery'),'1');
 assert(text.includes('<noscript><meta http-equiv="refresh" content="30"></noscript>'));assert(text.includes('href=""'));assert(text.includes('Подключаемся к BarOS'));assert(!text.includes('Вы вне сети'));
 assert(text.includes('/static/v2/reconnect.js?v=2.13.2'));assert(r.headers.get('content-security-policy').includes("script-src 'self'"));
 assert.equal(h.calls.length,3,'Transient navigation failures are retried at most twice');assert.deepEqual(h.delays,[400,1200]);
 assert.equal(h.calls[0],request,'Original URL and credential handling remain intact');
}
await recovery(()=>{throw new TypeError('network unavailable')});
await recovery(()=>new Response('temporary server failure',{status:503}));
await recovery(()=>new Response('bad gateway',{status:502}));
for(const status of [502,503,504,'network']){
 let count=0;const success=new Response('original page');
 const h=harness(()=>{if(++count===1){if(status==='network')throw new TypeError('network');return new Response('temporary',{status})}return success});
 assert.equal(await h.handle('/join?invitation=preserve-me').response,success,'Short outage is absorbed without displaying recovery');assert.equal(h.calls.length,2);
 assert.equal(h.calls[0],h.calls[1],'The original request, credentials and URL are retained');
}
const internal=harness(()=>new Response('internal error',{status:500}));assert.equal((await internal.handle('/app').response).status,503);assert.equal(internal.calls.length,1,'Do not multiply an application error');
const offline=harness(()=>{throw new TypeError('offline')},false);assert.equal((await offline.handle('/app').response).status,503);assert.equal(offline.calls.length,1,'Do not retry known offline reads');
for(const status of [200,401,404]){
 const original=new Response('original page',{status});const h=harness(()=>original);
 assert.equal(await h.handle('/app').response,original,'Existing pages and meaningful client errors are retained');
}
const bypass=harness(()=>{throw Error('Must not intercept')});
for(const [path,method,mode] of [['/api/me','GET','cors'],['/api/auth/login','POST','cors'],['/api/support','GET','navigate'],['/health','GET','navigate'],['https://outside.example/app','GET','navigate']])assert.equal(bypass.handle(path,method,mode).response,undefined);
assert.equal(bypass.calls.length,0,'Private APIs, writes, health checks and other origins are untouched');
const assets=harness(()=>{throw new TypeError('network unavailable')});assert.equal(await (await assets.handle('/static/v2/style.css','GET','cors').response).text(),'cached asset');
const helper=harness(()=>{throw Error('Recovery script must work while the server is asleep')});assert.equal(await (await helper.handle('/static/v2/reconnect.js?v=2.13.2','GET','cors').response).text(),'cached asset');assert.equal(helper.calls.length,0);

// Exercise real recovery code with a controllable clock and minimal browser
// objects: no hidden network requests, actual waits, persisted URLs or writes.
function reconnect(fetcher,{online=true}={}){
 let now=0,sequence=0,reloads=0;const timers=new Map(),calls=[],events={};
 const element=()=>({textContent:'',attributes:new Map(),setAttribute(k,v){this.attributes.set(k,v)},removeAttribute(k){this.attributes.delete(k)},addEventListener(k,fn){this[k]=fn}});
 const title=element(),status=element(),retry=element(),body={dataset:{}};
 const document={hidden:false,body,querySelector:s=>({'#connection-title':title,'#connection-status':status,'#connection-retry':retry}[s]),addEventListener:(name,fn)=>events[name]=fn};
 const navigator={onLine:online};
 const location={href:origin+'/join?invitation=keep-me#details',origin,reload:()=>reloads++};
 const context={document,navigator,location,URL,AbortController,Date:{now:()=>now},setTimeout:(fn,ms)=>{const id=++sequence;timers.set(id,{at:now+ms,fn});return id},clearTimeout:id=>timers.delete(id),fetch:async(url,options)=>{calls.push({url,options});return fetcher(url,options)},window:{addEventListener:(name,fn)=>events[name]=fn}};
 vm.runInNewContext(readFileSync(new URL('../baros/static/v2/reconnect.js',import.meta.url),'utf8'),context);
 async function flush(){for(let i=0;i<30;i++)await Promise.resolve()}
 return {calls,title,status,retry,document,navigator,events,timers,location,get reloads(){return reloads},async advance(ms){const end=now+ms;let guard=0;while(true){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;assert(++guard<100,'Bounded retry loop');now=next[1].at;timers.delete(next[0]);next[1].fn();await flush()}now=end;await flush()},async event(name){events[name]?.();await flush()},async click(){retry.click({preventDefault(){}});await flush()}};
}
function response(body,type='text/html',status=200){const r=new Response(body,{status,headers:{'content-type':type}});Object.defineProperty(r,'url',{value:origin+'/join?invitation=keep-me'});return r}
const ready=()=>response('{"status":"ok","service":"baros"}','application/json');
const shell=()=>response('<html><head><meta name="baros-shell" content="1"></head><body>BarOS</body></html>');
const restored=reconnect(url=>url==='/health'?ready():shell());await restored.advance(2000);assert.equal(restored.reloads,1);assert.equal(restored.calls.length,2);assert.equal(restored.calls[1].url,restored.location.href);assert(restored.calls.every(c=>c.options.cache==='no-store'));assert.equal(restored.calls[0].options.credentials,'omit');assert.equal(restored.calls[1].options.credentials,'same-origin');assert.equal(restored.timers.size,0);
const placeholder=reconnect(()=>response('<html>Hosting loading page</html>'));await placeholder.advance(95000);assert.equal(placeholder.reloads,0,'A 200 hosting interstitial is not a ready BarOS service');assert(placeholder.title.textContent.includes('не удаётся'));assert(placeholder.calls.length<10,'Back off rather than reloading every eight seconds');
const failedPage=reconnect(url=>url==='/health'?ready():response('bad gateway','text/html',502));await failedPage.advance(80000);assert.equal(failedPage.reloads,0,'Do not reload just because health works while navigation fails');
const otherPage=reconnect(url=>url==='/health'?ready():response('<html>Hosting loading page</html>'));await otherPage.advance(2000);assert.equal(otherPage.reloads,0,'Verify the actual HTML shell before leaving recovery');
const returned=reconnect(url=>url==='/health'?ready():shell(),{online:false});await returned.advance(5000);assert.equal(returned.calls.length,0);assert(returned.title.textContent.includes('подключения'));returned.navigator.onLine=true;await returned.event('online');assert.equal(returned.reloads,1,'Return immediately after an online event');
const hidden=reconnect(()=>response('unavailable','text/plain',503));hidden.document.hidden=true;await hidden.event('visibilitychange');await hidden.advance(80000);assert.equal(hidden.calls.length,0,'A hidden recovery tab does not poll');hidden.document.hidden=false;await hidden.event('visibilitychange');assert.equal(hidden.calls.length,1);await hidden.event('pagehide');await hidden.advance(200000);assert.equal(hidden.calls.length,1,'No polling after leaving');
const bounded=reconnect(()=>response('unavailable','text/plain',503));await bounded.advance(240000);const count=bounded.calls.length;await bounded.advance(240000);assert.equal(bounded.calls.length,count,'Stop automatic checks after three minutes');assert.equal(bounded.document.body.dataset.state,'paused');await bounded.click();assert.equal(bounded.calls.length,count+1);await bounded.advance(2000);assert.equal(bounded.calls.length,count+2,'Manual retry starts a fresh bounded recovery session');
let release;const inFlight=reconnect(()=>new Promise(resolve=>release=resolve));await inFlight.advance(2000);await inFlight.click();assert.equal(inFlight.calls.length,1,'Repeated clicks never overlap or multiply probes');release(response('unavailable','text/plain',503));await inFlight.event('pagehide');
console.log('SERVICE WORKER PASS: bounded transparent gateway retries, cached recovery helper, readiness and real-shell verification, offline/online recovery, visibility cleanup, manual retry, no reload storm and private API/write/health bypass');
