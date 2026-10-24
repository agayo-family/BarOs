import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const base=process.env.BAROS_AUDIT_URL;
const dom=new JSDOM('<div id="app"></div><div id="modal-root"></div><div id="toast-root"></div>',{url:base+'/app',pretendToBeVisual:true});
for(const key of ['window','document','location','history','localStorage','sessionStorage','FormData','Event','CustomEvent','MouseEvent','HTMLElement'])globalThis[key]=dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});globalThis.confirm=()=>true;dom.window.scrollTo=()=>{};dom.window.HTMLElement.prototype.scrollIntoView=function(){};
const native=fetch;let gates=[],puts=[],active=0,peak=0,finishes=0,fail=false;
globalThis.fetch=async(path,options={})=>{
 const url=new URL(path,base).href,headers=new Headers(options.headers||{}),cookie=dom.cookieJar.getCookieStringSync(base);if(cookie)headers.set('cookie',cookie);
 const save=options.method==='PUT'&&/\/api\/exams\//.test(url);
 if(save){puts.push(JSON.parse(options.body).answers);active++;peak=Math.max(peak,active);const gate=gates.shift();if(gate)await gate;if(fail){fail=false;active--;throw new TypeError('Simulated lost network')}}
 if(options.method==='POST'&&url.endsWith('/finish'))finishes++;
 try{const r=await native(url,{...options,headers});for(const c of r.headers.getSetCookie())dom.cookieJar.setCookieSync(c,base);return r}finally{if(save)active--}
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function until(test,message){for(let i=0;i<250;i++){if(test())return;await sleep(20)}throw new Error(message+' '+document.body.textContent.slice(-1000))}
async function unauth(path,body){const r=await fetch('/api'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert(r.ok,await r.text())}
await unauth('/auth/setup',{token:'baros-ui-audit-only',name:'Exam owner',login:'exam.owner',password:'exam-audit-password'});
const core=await import('./ui/core.js?v=2.6.4');await core.reloadMe();
const venue=await core.api('/venues','POST',{name:'Isolated exam audit'});core.setOrg(venue.id);
const course=await core.api('/courses','POST',{title:'Проверка сохранения',positions:['bartender'],quiz_size:2,lessons:[{title:'Стандарт подачи',body:'Лимонад подают в высоком стакане со льдом.'}],questions:[{prompt:'В какой посуде подают лимонад?',choices:['Высокий стакан','Чашка','Кружка','Рюмка'],correct_index:0,explanation:'В материале указан высокий стакан.',type:'knowledge'},{prompt:'С чем подают лимонад по стандарту?',choices:['Со льдом','С молоком','С кофе','С солью'],correct_index:0,explanation:'В материале указан лёд.',type:'knowledge'}]});
await core.api('/courses/'+course.id+'/publish','POST',{edit_version:course.edit_version,reviewed:true});await core.api('/auth/logout','POST',{});core.state.me=null;core.setOrg('');
await unauth('/auth/join',{code:venue.join_code,name:'Exam learner',login:'exam.worker',password:'exam-audit-password',positions:['bartender']});await core.reloadMe();
await core.api(`/learning/${course.id}/lessons/0`,'POST',{complete:false});await sleep(10500);await core.api(`/learning/${course.id}/lessons/0`,'POST',{complete:true});
const {examPage}=await import('./ui/learn.js?v=2.6.4');const root=document.querySelector('#app');
let exam=await core.api('/learning/'+course.id+'/exam','POST',{});await examPage(root,exam.id);
const choose=value=>{const e=root.querySelector(`[name=answer][value="${value}"]`);assert(e);e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}))};
let firstRelease,secondRelease;gates=[new Promise(r=>firstRelease=r),new Promise(r=>secondRelease=r)];
choose(0);await until(()=>puts.length===1,'First request held');choose(1);assert(core.state.dirty);
firstRelease();await until(()=>puts.length===2,'Second request begins after first response');
assert(core.state.dirty,'Earlier response must not clear newer unsaved answer');assert.match(root.querySelector('#answer-state').textContent,/Сохраняем/);
root.querySelector('[data-question-index="1"]').click();root.querySelector('[data-finish-exam]').click();
assert([...root.querySelectorAll('[name=answer]')].every(x=>x.disabled),'Submitting freezes answers');
choose(3);secondRelease();await until(()=>root.querySelector('.result-hero'),'Submitted once queue drains');
assert.equal(peak,1);assert.equal(finishes,1);assert.equal(puts.length,2);assert.equal((await core.api('/exams/'+exam.id)).answers['0'],1);
core.state.cleanup?.();exam=await core.api('/learning/'+course.id+'/exam','POST',{});await examPage(root,exam.id);
fail=true;choose(2);await until(()=>!root.querySelector('[data-retry-answer]').hidden,'Visible retry after network failure');assert(core.state.dirty);
root.querySelector('[data-question-index="1"]').click();assert.match(root.querySelector('#answer-state').textContent,/Не сохранено/);
choose(1);await until(()=>!core.state.dirty,'Later complete snapshot recovers failed prior answer');
let persisted=await core.api('/exams/'+exam.id);assert.equal(persisted.answers['0'],2);assert.equal(persisted.answers['1'],1);
fail=true;choose(3);await until(()=>!root.querySelector('[data-retry-answer]').hidden,'Retry control visible again');root.querySelector('[data-retry-answer]').click();await until(()=>!core.state.dirty,'Explicit retry saved');
assert.equal((await core.api('/exams/'+exam.id)).answers['1'],3);
let releaseOld;gates=[new Promise(r=>releaseOld=r)];choose(0);await until(()=>active===1,'Last pending request held');core.state.cleanup?.();core.state.renderTicket++;core.state.dirty=true;root.innerHTML='<h1>Another editor</h1>';releaseOld();await until(()=>active===0,'Old response returned');assert(core.state.dirty,'Old screen cannot clear dirty state on the next screen');assert(root.textContent.includes('Another editor'));
console.log('EXAM SAVING REAL API + DOM PASS: serial saves, honest dirty state, frozen submission, full snapshot recovery, explicit retry and stale-page isolation');dom.window.close();process.exit(0);
