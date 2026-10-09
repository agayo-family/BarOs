import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const base=process.env.BAROS_AUDIT_URL||'http://127.0.0.1:8147';
const dom=new JSDOM('<div id="app"></div><div id="modal-root"></div><div id="toast-root"></div>',{url:base+'/app',pretendToBeVisual:true});
for(const key of ['window','document','location','history','localStorage','FormData','Event','CustomEvent','MouseEvent','HTMLElement'])globalThis[key]=dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});globalThis.confirm=()=>true;dom.window.scrollTo=()=>{};dom.window.print=()=>{};dom.window.HTMLElement.prototype.scrollIntoView=function(){};
const nativeFetch=globalThis.fetch,requests=[];
globalThis.fetch=async(path,options={})=>{const url=new URL(path,base).href,headers=new Headers(options.headers||{}),cookie=dom.cookieJar.getCookieStringSync(base);if(cookie)headers.set('cookie',cookie);const res=await nativeFetch(url,{...options,headers});for(const c of res.headers.getSetCookie())dom.cookieJar.setCookieSync(c,base);requests.push({path:new URL(url).pathname,method:options.method||'GET',status:res.status});return res};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,desc){for(let i=0;i<250;i++){if(test())return;await sleep(20)}throw new Error(desc+' '+document.body.textContent.slice(-1200))}
const e=s=>{const x=document.querySelector(s);assert(x,'Missing '+s);return x};
const click=s=>e(s).click();
function input(s,value){const x=e(s);x.value=value;x.dispatchEvent(new Event('input',{bubbles:true}));x.dispatchEvent(new Event('change',{bubbles:true}))}
const submit=s=>e(s).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
async function raw(path,body){const r=await fetch('/api'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert(r.ok,await r.clone().text());return r.json()}
await raw('/auth/setup',{token:'baros-ui-audit-only',name:'Audit owner',login:'shift.owner',password:'audit-owner-password'});
const core=await import('./ui/core.js?v=2.5.0');await core.reloadMe();
const venue=await core.api('/venues','POST',{name:'Shift UI venue'}),invite=await core.api('/venues/'+venue.id+'/invite','POST',{});
await core.api('/auth/logout','POST',{});core.state.me=null;
await raw('/auth/join',{code:venue.join_code,name:'Shift worker',login:'shift.worker',password:'audit-worker-password',positions:['bartender']});
await import('./ui/app.js');await until(()=>core.state.me?.account.role==='employee','Login employee');const aid=core.state.me.account.id;
core.go('/app/shifts');await until(()=>document.querySelector('[data-new-shift]'),'Shifts route');
assert(document.querySelector('.sidebar a[href="/app/cards"]'),'Cards sidebar remains available');
assert(document.querySelector('.bottom-nav a[href="/app/shifts"]'),'Mobile shifts navigation');
click('[data-shift-settings]');input('#shift-settings-form [name=hourly_rate]','300');input('#shift-settings-form [name=overtime_after]','360');input('#shift-settings-form [name=overtime_percent]','150');submit('#shift-settings-form');await until(()=>!document.querySelector('#shift-settings-form'),'Persist preferences');
click('[data-new-template]');input('#shift-template-form [name=title]','Night UI');input('#shift-template-form [name=start_time]','22:00');input('#shift-template-form [name=end_time]','06:00');input('#shift-template-form [name=end_day_offset]','1');input('#shift-template-form [name=allowance]','50');submit('#shift-template-form');await until(()=>document.querySelector('[data-use-template]'),'Persist template');
click('[data-use-template]');input('#shift-form [name=day]','2026-10-08');assert.match(e('#shift-estimate').textContent,/2\s?525/);submit('#shift-form');await until(()=>!document.querySelector('#shift-form'),'Create night shift');
let response=await core.api(`/shifts?start=2026-10-01&end=2026-10-31&account_id=${aid}`);assert.equal(response.shifts[0].forecast,252500);let row=response.shifts[0];await until(()=>document.querySelector('[data-shift="'+row.id+'"]'),'Created shift rendered');
click('[data-shift="'+row.id+'"]');input('#shift-form [name=status]','completed');input('#shift-form [name=actual_start]','2026-10-08T22:00');input('#shift-form [name=actual_end]','2026-10-09T07:00');input('#shift-form [name=actual_break]','30');input('#shift-form [name=tips]','120');submit('#shift-form');await until(()=>!document.querySelector('#shift-form'),'Save actual shift');
response=await core.api(`/shifts?start=2026-10-01&end=2026-10-31&account_id=${aid}`);assert.equal(response.shifts[0].earned,309500);
click('[data-view=report]');await until(()=>/3\s?095/.test(document.querySelector('.shift-money')?.textContent||''),'Actual shift earnings rendered');assert.match(e('.shift-money').textContent,/3\s?095/);click('[data-view=calendar]');click('[data-day="2026-10-08"]');assert(document.querySelector('[data-day-add]'));click('[data-close]');
click('[data-rotation]');click('[data-preset="2/2"]');input('#shift-rotation-form [name=start]','2026-10-10');input('#shift-rotation-form [name=end]','2026-10-17');submit('#shift-rotation-form');await until(()=>!e('[data-apply-rotation]').disabled,'Preview rotation');assert.match(e('#shift-rotation-preview').textContent,/Будет создано: 4/);click('[data-apply-rotation]');await until(()=>!document.querySelector('#shift-rotation-form'),'Apply rotation');
response=await core.api(`/shifts?start=2026-10-01&end=2026-10-31&account_id=${aid}`);assert.equal(response.shifts.length,5);
// Changing the range invalidates a prior preview; conflicts prevent creation.
click('[data-rotation]');click('[data-preset="2/2"]');input('#shift-rotation-form [name=start]','2026-10-10');input('#shift-rotation-form [name=end]','2026-10-17');submit('#shift-rotation-form');await until(()=>e('#shift-rotation-preview').textContent.includes('Конфликтов: 4'),'Conflicting cycle');assert(e('[data-apply-rotation]').disabled);input('#shift-rotation-form [name=end]','2026-10-20');assert.equal(e('#shift-rotation-preview').textContent,'');click('[data-close]');
const before=requests.length;click('[data-shift-refresh]');assert(e('[data-shift-refresh]').disabled);await until(()=>!e('[data-shift-refresh]').disabled,'Refresh feedback');assert(requests.slice(before).some(r=>r.path==='/api/shifts'));
click('[data-shift-export]');assert(e('[data-export=csv]'));assert(e('[data-export=ics]'));click('[data-print-shifts]');assert(document.querySelector('.shift-agenda'));click('[data-view=report]');input('#shift-range [name=from]','2026-01-01');input('#shift-range [name=to]','2026-12-31');submit('#shift-range');await until(()=>e('.shift-report').textContent.includes('31 декабря'),'Custom annual report');
const {wallISO,hours}=await import('./ui/shifts.js?v=2.5.0');assert.equal(wallISO('2026-10-08T22:00','Europe/Moscow'),'2026-10-08T19:00:00.000Z');assert.throws(()=>wallISO('2026-03-29T02:30','Europe/Berlin'));assert.equal(hours(510),'8 ч 30 мин');
await core.api('/auth/logout','POST',{});core.state.me=null;
await raw('/invites/'+invite.url.split('/').at(-1),{name:'Shift manager',organization:'Shift UI venue'});await core.reloadMe();core.go('/app/shifts');await until(()=>document.querySelector('[name=account]')?.textContent.includes('Вся команда')&&core.state.me.account.role==='manager','Manager shifts');
assert(e('[name=account]').textContent.includes('Вся команда'));assert(e('.shift-calendar').textContent.includes('Night UI'));
click('[data-new-shift]');input('#shift-form [name=day]','2026-10-22');input('#shift-form [name=account_id]',String(aid));input('#shift-form [name=title]','Assigned UI');submit('#shift-form');await until(()=>!document.querySelector('#shift-form'),'Assign employee shift');
const assigned=(await core.api('/shifts?start=2026-10-01&end=2026-10-31&account_id=0')).shifts.find(r=>r.title==='Assigned UI');assert(assigned);
await core.api('/auth/logout','POST',{});core.state.me=null;await raw('/auth/login',{login:'shift.worker',password:'audit-worker-password'});await core.reloadMe();core.go('/app/shifts');await until(()=>document.querySelector('[data-shift="'+assigned.id+'"]')&&document.querySelector('.sidebar .nav-caption')?.textContent==='МОЁ ОБУЧЕНИЕ','Employee assigned calendar');
click('[data-shift="'+assigned.id+'"]');assert(!document.querySelector('#shift-form [name=title]'));assert(!document.querySelector('[data-delete-shift]'));input('#shift-form [name=status]','completed');input('#shift-form [name=tips]','25');submit('#shift-form');await until(()=>!document.querySelector('#shift-form'),'Employee fact protected plan');
assert.equal((await core.api(`/shifts?start=2026-10-01&end=2026-10-31&account_id=${aid}`)).shifts.find(r=>r.id===assigned.id).status,'completed');
assert(!requests.some(r=>r.status>=500));console.log('SHIFTS REAL API + DOM PASS: preferences, template, overnight estimate, actual hours/tips, all views, calendar day, cycle preview/conflicts/apply, refresh, exports UI, year report, timezone/DST, manager assignment, employee protected fact; requests='+requests.length);
dom.window.close();process.exit(0);
