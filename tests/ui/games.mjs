import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const base=process.env.BAROS_AUDIT_URL||'http://127.0.0.1:8147';
const dom=new JSDOM('<div id="app"></div><div id="modal-root"></div><div id="toast-root"></div>',{url:base+'/app',pretendToBeVisual:true});
for(const key of ['window','document','location','history','localStorage','FormData','Event','MouseEvent','HTMLElement'])globalThis[key]=dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});globalThis.confirm=()=>true;dom.window.scrollTo=()=>{};dom.window.HTMLElement.prototype.scrollIntoView=function(){};
dom.window.matchMedia=q=>({matches:q.includes('reduced-motion'),addEventListener(){},removeEventListener(){}});
const nativeFetch=globalThis.fetch,requests=[];let failAnswerOnce=false;
globalThis.fetch=async(path,options={})=>{const url=new URL(path,base).href,headers=new Headers(options.headers||{}),cookie=dom.cookieJar.getCookieStringSync(base);if(cookie)headers.set('cookie',cookie);const res=await nativeFetch(url,{...options,headers});for(const c of res.headers.getSetCookie())dom.cookieJar.setCookieSync(c,base);requests.push({path:new URL(url).pathname,method:options.method||'GET',status:res.status});if(failAnswerOnce&&url.endsWith('/answer')){failAnswerOnce=false;throw new Error('Simulated lost response after server commit')}return res};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,desc){for(let i=0;i<250;i++){if(test())return;await sleep(20)}throw new Error(desc+' '+document.body.textContent.slice(-1600))}
const e=s=>{const x=document.querySelector(s);assert(x,'Missing '+s);return x};
const click=s=>e(s).click();
function input(s,value){const x=e(s);x.value=value;x.dispatchEvent(new Event('input',{bubbles:true}));x.dispatchEvent(new Event('change',{bubbles:true}))}
async function raw(path,body){const r=await fetch('/api'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert(r.ok,await r.clone().text());return r.json()}
await raw('/auth/setup',{token:'baros-ui-audit-only',name:'Game owner',login:'game.owner',password:'audit-owner-password'});
const core=await import('./ui/core.js?v=2.3.1');await core.reloadMe();
const venue=await core.api('/venues','POST',{name:'Game UI venue'});core.setOrg(venue.id);
const answers=['90 °C','Высокий стакан со льдом','Уточнить состав у кухни','Предложить напиток по вкусу гостя','Сироп и вода и лёд','Чистые приборы'];
const course=await core.api('/courses','POST',{title:'Материал игр UI',description:'Учимся по реальному материалу',positions:['bartender'],quiz_size:2,
 lessons:[{title:'Стандарты заведения',body:'## Подача\nЛимонад подают в высоком стакане со льдом. Чай заваривают при 90 °C. <img src=x onerror=alert(1)>\n\nПри сомнении нужно уточнить состав у кухни.'}],
 questions:answers.map((answer,i)=>({prompt:'Вопрос '+i+': какой ответ соответствует стандарту заведения?',choices:[answer,'Другой способ','Неверный способ','Иная рекомендация'],correct_index:0,explanation:'Правило: '+answer+'.',type:['knowledge','knowledge','scenario','sales','understanding','understanding'][i]}))});
await core.api('/courses/'+course.id+'/publish','POST',{edit_version:course.edit_version,reviewed:true});
await core.api('/auth/logout','POST',{});localStorage.removeItem('baros:venue');core.state.org='';core.state.me=null;
await raw('/auth/join',{code:venue.join_code,name:'Game worker',login:'game.worker',password:'audit-worker-password',positions:['bartender']});
await import('./ui/app.js');await until(()=>core.state.me?.account.role==='employee','Employee login');
core.go('/app/games');await until(()=>document.querySelector('a[href="/app/games/'+course.id+'"]'),'Games catalogue');
const nav=[...document.querySelectorAll('.sidebar .nav a')].map(a=>a.getAttribute('href'));assert.equal(nav[nav.indexOf('/app/cards')+1],'/app/games');assert(document.querySelector('.bottom-nav a[href="/app/games"]'));
async function board(){core.go('/app/games/'+course.id);await until(()=>document.querySelector('[data-start-game=truth]'),'Mode board')}
async function start(mode,size='5'){await board();input('[name="size-'+mode+'"]',size);click('[data-start-game='+mode+']');await until(()=>document.querySelector('#game-player'),'Player '+mode);const rid=new URLSearchParams(location.search).get('run');assert(rid);return await core.api('/games/runs/'+rid)}
async function next(){click('[data-game-next]');await until(()=>!document.querySelector('[data-game-next]'),'Next question or finish')}
async function respondTo(q){if(q.variant==='recall'){click('[data-reveal-answer]');assert(e('.game-reveal').textContent.includes(q.answer));click('[data-self-rating=remembered]')}
 else if(q.variant==='truth')click('[data-truth='+q.claim_true+']');
 else if(q.variant==='scenario')click('[data-scenario='+q.correct_index+']');
 else {for(let i=0;i<q.tokens.length;i++)click('[data-game-token="'+i+'"]');click('[data-check-words]')}
 await until(()=>document.querySelector('[data-game-next]'),'Feedback rendered');assert(e('.game-correct-answer').textContent.includes(q.answer));await next()}
let run=await start('truth');
// Fail after a real committed answer, then retry the same idempotent event.
failAnswerOnce=true;click('[data-truth='+run.questions[0].claim_true+']');await until(()=>document.querySelector('[data-game-retry]'),'Save failure feedback');assert(e('[data-game-pause]').disabled);click('[data-game-retry]');await until(()=>document.querySelector('[data-game-next]'),'Idempotent retry');await next();
for(const q of run.questions.slice(1))await respondTo(q);
assert(document.querySelector('.game-finish'));assert.match(e('.game-finish').textContent,/Экзаменационные|не расходуют попытки/);
let learned=await core.api('/learning');assert.equal(learned.attempts,0);assert.equal(learned.courses[0].read_count,0);
// Wrong response teaches the answer and appears in the review queue.
run=await start('truth');click('[data-truth='+!run.questions[0].claim_true+']');await until(()=>document.querySelector('.game-feedback.gentle'),'Gentle wrong feedback');assert(e('.game-correct-answer').textContent.includes(run.questions[0].answer));await next();
click('[data-game-pause]');await until(()=>document.querySelector('[data-start-game=mix]'),'Pause returns to board');assert(e('.game-course-summary').textContent.includes('1'));
const resume=document.querySelector('a[href*="?run="]');assert(resume,'Saved round offers resume');resume.click();await until(()=>document.querySelector('.game-task'),'Resume');const resumed=await core.api('/games/runs/'+new URLSearchParams(location.search).get('run'));assert.equal(resumed.id,run.id);assert.equal(Object.keys(resumed.answers).length,1);
// Theory is available and source HTML remains escaped.
click('[data-game-theory]');assert(!e('#game-theory').hidden);assert(!e('#game-theory').querySelector('img'));assert(e('#game-theory').textContent.includes('Стандарты заведения'));click('[data-close-theory]');assert(e('#game-theory').hidden);
run=await start('words');
for(const q of run.questions){click('[data-game-token="'+q.tokens[0].id+'"]');assert(document.querySelector('.game-token.placed'));click('[data-remove-token="0"]');assert(!document.querySelector('.game-token.placed'));await respondTo(q)}
assert(document.querySelector('.game-finish'));
run=await start('scenario');assert(run.questions.every(q=>['scenario','sales'].includes(q.type)));for(const q of run.questions)await respondTo(q);assert(document.querySelector('.game-finish'));
run=await start('recall');for(const q of run.questions)await respondTo(q);assert.match(e('.game-finish').textContent,/самооценкой/);
run=await start('pairs','4');
for(const q of run.questions){click('[data-pair-question="'+q.id+'"]');click('[data-pair-answer="'+q.id+'"]');await until(()=>document.querySelector('[data-pair-next]'),'Pair explanation');assert(e('.game-correct-answer').textContent.includes(q.answer));click('[data-pair-next]');await until(()=>!document.querySelector('[data-pair-next]'),'Next pair or finish')}
assert(document.querySelector('.game-finish'));
run=await start('mix');assert(new Set(run.questions.map(q=>q.variant)).size>=2);for(const q of run.questions)await respondTo(q);assert(document.querySelector('.game-finish'));
learned=await core.api('/learning');assert.equal(learned.attempts,0);assert.equal(learned.courses[0].read_count,0);
assert(!requests.some(r=>r.status>=500));console.log('GAMES REAL API + DOM PASS: navigation after cards, six modes, correctness/explanations, gentle mistakes, server progress, pause/resume, escaped theory, token undo, pair completion, mixed route, lost-response idempotent retry and no exam/theory credit; requests='+requests.length);
core.state.cleanup?.();dom.window.close();process.exit(0);
