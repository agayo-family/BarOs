import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../baros/static/v2/sw.js',import.meta.url),'utf8');
const origin='https://baros.example';
function harness(fetcher){
 const handlers={},calls=[];
 const self={location:{origin},addEventListener:(name,fn)=>handlers[name]=fn};
 const caches={match:async()=>new Response('cached asset'),open:async()=>({put:async()=>{},addAll:async()=>{}})};
 vm.runInNewContext(source,{self,caches,URL,Response,fetch:async request=>{calls.push(request);return fetcher(request)}});
 return {calls,handle(path,method='GET',mode='navigate'){
  const request={url:new URL(path,origin).href,method,mode};let response;
  handlers.fetch({request,respondWith:p=>response=p,waitUntil:()=>{}});return {request,response};
 }};
}
async function recovery(fetcher){
 const h=harness(fetcher),{request,response}=h.handle('/join?invitation=preserve-me');
 const r=await response,text=await r.text();
 assert.equal(r.status,503);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('retry-after'),'8');assert.equal(r.headers.get('x-baros-recovery'),'1');
 assert(text.includes('<meta http-equiv="refresh" content="8">'));assert(text.includes('href=""'));assert(text.includes('Не удаётся открыть BarOS'));assert(!text.includes('Вы вне сети'));
 assert.equal(h.calls[0],request,'Original URL and credential handling remain intact');
}
await recovery(()=>{throw new TypeError('network unavailable')});
await recovery(()=>new Response('temporary server failure',{status:503}));
await recovery(()=>new Response('bad gateway',{status:502}));
for(const status of [200,401,404]){
 const original=new Response('original page',{status});const h=harness(()=>original);
 assert.equal(await h.handle('/app').response,original,'Existing pages and meaningful client errors are retained');
}
const bypass=harness(()=>{throw Error('Must not intercept')});
for(const [path,method,mode] of [['/api/me','GET','cors'],['/api/auth/login','POST','cors'],['/api/support','GET','navigate'],['/health','GET','navigate'],['https://outside.example/app','GET','navigate']])assert.equal(bypass.handle(path,method,mode).response,undefined);
assert.equal(bypass.calls.length,0,'Private APIs, writes, health checks and other origins are untouched');
const assets=harness(()=>{throw new TypeError('network unavailable')});assert.equal(await (await assets.handle('/static/v2/style.css','GET','cors').response).text(),'cached asset');
console.log('SERVICE WORKER PASS: network and HTTP failure recovery, uncached response, automatic retry, preserved route, private API/write/health bypass and static asset fallback');
