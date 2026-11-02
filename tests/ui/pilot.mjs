import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const NativeFormData=globalThis.FormData,nativeFetch=globalThis.fetch;
const base=process.env.BAROS_AUDIT_URL||'http://127.0.0.1:8147';
const dom=new JSDOM('<div id="app"></div><div id="modal-root"></div><div id="toast-root"></div>',{url:base+'/app',pretendToBeVisual:true});
for(const key of ['window','document','location','history','localStorage','sessionStorage','FormData','Event','CustomEvent','MouseEvent','HTMLElement'])globalThis[key]=dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});globalThis.confirm=()=>true;dom.window.scrollTo=()=>{};dom.window.HTMLElement.prototype.scrollIntoView=function(){};
const requests=[];
globalThis.fetch=async(path,options={})=>{const url=new URL(path,base).href,headers=new Headers(options.headers||{}),cookie=dom.cookieJar.getCookieStringSync(base);if(cookie)headers.set('cookie',cookie);const res=await nativeFetch(url,{...options,headers});for(const c of res.headers.getSetCookie())dom.cookieJar.setCookieSync(c,base);requests.push({path:new URL(url).pathname,status:res.status});return res};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,desc){for(let i=0;i<250;i++){if(test())return;await sleep(20)}throw new Error(desc+' '+document.body.textContent.slice(-1500))}
const e=s=>{const x=document.querySelector(s);assert(x,'Missing '+s);return x};
const click=s=>e(s).click();
function input(s,value){const x=e(s);x.value=value;x.dispatchEvent(new Event('input',{bubbles:true}));x.dispatchEvent(new Event('change',{bubbles:true}))}
const submit=s=>e(s).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
async function raw(path,body){const r=await fetch('/api'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert(r.ok,await r.clone().text());return r.json()}
await raw('/auth/setup',{token:'baros-ui-audit-only',name:'Audit owner',login:'pilot.owner',password:'audit-owner-password'});
const core=await import('./ui/core.js?v=2.13.0');await core.reloadMe();
const venue=await core.api('/venues','POST',{name:'Pilot UI venue'}),invite=await core.api('/venues/'+venue.id+'/invite','POST',{});
await core.api('/auth/logout','POST',{});core.state.me=null;
await raw('/invites/'+invite.url.split('/').at(-1),{name:'Pilot manager',organization:venue.name});await core.reloadMe();
const source=new NativeFormData();source.append('roles','["all"]');source.append('file',new Blob(['# Подача напитка\nСверьте состав заказа и уточните пожелания гостя перед подачей напитка.\n# Работа с вопросами\nЕсли точного правила нет, обратитесь к управляющему и сообщите гостю следующий шаг.']),'standard.txt');
let r=await fetch('/api/sources',{method:'POST',headers:{'x-csrf-token':core.state.me.csrf},body:source});assert(r.ok,await r.clone().text());
await import('./ui/app.js');await until(()=>document.querySelector('.sidebar'),'Manager app');
core.go('/app/drafts');await until(()=>document.querySelector('[data-draft-source]'),'Source in drafts');click('[data-draft-source]');click('[data-draft-build]');input('#source-build [name=title]','Курс из материала');click('#source-build [name=positions][value=bartender]');assert(!e('#source-build [name=positions][value=all]').checked);submit('#source-build');await until(()=>!document.querySelector('#source-build')&&document.querySelector('[data-draft-list]')?.textContent.includes('Курс из материала'),'Source assembly draft rendered');
const drafts=await core.api('/drafts');assert.equal(drafts.items.length,2);assert(drafts.items.every(d=>!d.published));
const course=drafts.items.find(d=>d.kind==='course');assert.deepEqual(course.positions,['bartender']);core.go('/app/courses/'+course.id);await until(()=>document.querySelector('.photo-picker [type=file]'),'Lesson photo picker');
assert.equal(document.querySelector('.photo-picker [type=file]').accept,'image/jpeg,image/png,image/webp');
const {mediaText}=await import('./ui/media.js?v=2.13.0');const html=mediaText('![<script>](/api/media/abcdefghijklmnopqrstuvwx) <script>alert(1)</script> ![](https://bad.test/x.png)');
assert(html.includes('src="/api/media/abcdefghijklmnopqrstuvwx"'));assert(!html.includes('<script>'));assert(!html.includes('src="https://'));assert(html.includes('&lt;script&gt;'));
core.go('/legal/privacy');await until(()=>document.querySelector('[data-legal-ack]'),'Legal document and acknowledgement');assert(e('.legal-document').textContent.includes('121524098311'));click('[data-legal-ack]');await until(()=>document.querySelector('.legal-accepted'),'Persist acknowledgement');
assert.equal((await core.api('/legal/acknowledgements')).length,1);
core.go('/about?employees=50');await until(()=>document.querySelector('#team-size'),'Pricing page');assert(e('#price-result').textContent.replace(/\s/g,'').includes('9900'));click('[data-mode=self]');assert(e('#price-result').textContent.replace(/\s/g,'').includes('4900'));assert(!e('#price-result').querySelector('.site-setup-price'));click('[data-plan-step="1"]');assert(e('#price-result').textContent.replace(/\s/g,'').includes('7900'));assert.equal(new URL(location.href).searchParams.get('mode'),'self');e('[data-plan="100"]').focus();e('[data-plan="100"]').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(document.activeElement.dataset.plan,'200');assert(e('#price-result').textContent.replace(/\s/g,'').includes('12900'));click('[data-team="100"]');click('[data-mode=managed]');assert(e('#price-result').textContent.replace(/\s/g,'').includes('14900'));assert(e('.site-setup-price').textContent.replace(/\s/g,'').includes('49900'));
await core.api('/auth/logout','POST',{});core.state.me=null;core.go('/login');await until(()=>document.querySelector('#auth-form'),'Public login');assert(!document.querySelector('a[href="/owner-recovery"]'));assert(document.querySelector('a[href="/legal/privacy"]'));
assert(!requests.some(r=>r.status>=500));console.log('PILOT API + DOM PASS: source assembly, lesson photo control, escaped private images, versioned legal acknowledgement, two pricing modes, carousel pricing, hidden recovery navigation; requests='+requests.length);
dom.window.close();process.exit(0);
