import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const base=process.env.BAROS_AUDIT_URL||'http://127.0.0.1:8147';
const dom=new JSDOM('<div id="app"></div><div id="modal-root"></div><div id="toast-root"></div>',{url:base+'/app',pretendToBeVisual:true});
for(const key of ['window','document','location','history','localStorage','FormData','Event','CustomEvent','MouseEvent','HTMLElement'])globalThis[key]=dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});globalThis.confirm=()=>true;dom.window.scrollTo=()=>{};dom.window.HTMLElement.prototype.scrollIntoView=function(){};
dom.window.matchMedia=q=>({matches:q.includes('reduced-motion'),addEventListener(){},removeEventListener(){}});
const nativeFetch=globalThis.fetch,requests=[];let failAnswerOnce=false,failMentorOnce=false;
globalThis.fetch=async(path,options={})=>{const url=new URL(path,base).href,headers=new Headers(options.headers||{}),cookie=dom.cookieJar.getCookieStringSync(base);if(cookie)headers.set('cookie',cookie);const res=await nativeFetch(url,{...options,headers});for(const c of res.headers.getSetCookie())dom.cookieJar.setCookieSync(c,base);requests.push({path:new URL(url).pathname,method:options.method||'GET',status:res.status});if(failAnswerOnce&&url.endsWith('/answer')){failAnswerOnce=false;throw new Error('Simulated lost response after server commit')}if(failMentorOnce&&url.endsWith('/mentor/messages')){failMentorOnce=false;throw new Error('Simulated lost mentor response after server commit')}return res};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,desc){for(let i=0;i<250;i++){if(test())return;await sleep(20)}throw new Error(desc+' '+document.body.textContent.slice(-1600))}
const e=s=>{const x=document.querySelector(s);assert(x,'Missing '+s);return x};
const click=s=>e(s).click();
function input(s,value){const x=e(s);x.value=value;x.dispatchEvent(new Event('input',{bubbles:true}));x.dispatchEvent(new Event('change',{bubbles:true}))}
async function raw(path,body){const r=await fetch('/api'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert(r.ok,await r.clone().text());return r.json()}
await raw('/auth/setup',{token:'baros-ui-audit-only',name:'Game owner',login:'game.owner',password:'audit-owner-password'});
const core=await import('./ui/core.js?v=2.5.0');await core.reloadMe();
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
 else {const remaining=[...q.tokens];for(const word of q.answer.split(/\s+/)){const token=remaining.find(t=>t.text===word);assert(token);click('[data-game-token="'+token.id+'"]');remaining.splice(remaining.indexOf(token),1)}assert(remaining.length>0,'Words contain distractors');click('[data-check-words]')}
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
// Optional profile flow on the same real employee account.
core.go('/app/profile');await until(()=>document.querySelector('.profile-hero'),'Profile route');
click('[data-profile-tab=pet]');click('[data-pet-picker]');assert.equal(document.querySelectorAll('[data-choose-pet]').length,15);
click('[data-choose-pet=ember]');click('[data-confirm-pet]');await until(()=>document.querySelector('.pet-home'),'Pet chosen');await until(()=>document.querySelector('.companion-bubble'),'Floating companion');
const originalRandom=Math.random;Math.random=()=>.5;const phrases=new Set();
for(let i=0;i<20;i++){click('.companion-bubble');phrases.add(e('[data-companion-phrase]').textContent);click('[data-companion-close]')}assert.equal(phrases.size,20,'Phrases do not repeat');
Math.random=()=>.01;click('.companion-bubble');assert(e('.companion-popover').classList.contains('pet-trick'));click('[data-companion-close]');Math.random=originalRandom;
const {execFileSync}=await import('node:child_process');
execFileSync('python',['-c',"import sys;from baros.db import SessionLocal;from baros.v2.models import Account;from baros.v2.growth import reward;db=SessionLocal();a=db.get(Account,int(sys.argv[1]));reward(db,a,'ui-seed-disposable-only','theory',300,160,theory=1);db.commit();db.close()",String(core.state.me.account.id)],{env:process.env});
core.go('/app/profile');await until(()=>document.querySelector('.profile-hero')?.textContent.includes('Уровень 3'),'Profile refresh and level');
click('[data-profile-tab=shop]');assert.equal(document.querySelectorAll('[data-buy]').length,6);assert(!e('[data-buy=artifact-lantern]').disabled);click('[data-buy=artifact-lantern]');await until(()=>document.querySelector('[data-equip=artifact-lantern]'),'Shop purchase');
click('[data-equip=artifact-lantern]');await until(()=>document.querySelector('[data-equip=""][data-slot=artifact]'),'Artifact equipped');assert(document.querySelector('.artifact-lantern'));
click('[data-profile-tab=pet]');click('[data-pet-picker]');click('[data-choose-pet=moon]');assert(e('.modal-body').textContent.includes('единственную смену'));click('[data-confirm-pet]');await until(()=>document.querySelector('.pet-home h2')?.textContent==='Селли','Pet changed');assert(!document.querySelector('[data-pet-picker]'));assert.equal((await core.api('/growth')).pet_level,1);
const checkbox=e('[data-companion-enabled]');checkbox.checked=false;checkbox.dispatchEvent(new Event('change',{bubbles:true}));await until(()=>!document.querySelector('.companion-root'),'Companion hidden');
checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}));await until(()=>document.querySelector('.companion-root'),'Companion enabled');
// High difficulty requires a verdict and a precise material-based choice.
await board();input('[name=game-difficulty]','hard');input('[name=size-truth]','5');click('[data-start-game=truth]');await until(()=>document.querySelector('[data-hard-truth]'),'Hard truth player');
const hardRun=await core.api('/games/runs/'+new URLSearchParams(location.search).get('run'));const hardQ=hardRun.questions[0];click('[data-hard-truth='+hardQ.claim_true+']');click('[data-truth-reason='+hardQ.correct_index+']');await until(()=>document.querySelector('.game-feedback.positive'),'Hard answer verified');
// Mentor uses the selected pet and the completed game's server context, with no paid call on arrival.
const mentorBefore=requests.filter(r=>r.path==='/api/mentor/messages').length;
click('.mentor-feedback-link a');await until(()=>document.querySelector('.mentor-composer'),'Mentor from game');
assert(e('.mentor-about h2').textContent==='Селли');assert(e('.mentor-focus').textContent.includes(hardQ.prompt));assert(e('.mentor-memory').textContent.includes('Стоит повторить'));
assert.equal(requests.filter(r=>r.path==='/api/mentor/messages').length,mentorBefore);
input('#mentor-message','Почему этот ответ подходит? <img src=x onerror=alert(1)>');
e('.mentor-composer').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
e('.mentor-composer').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
await until(()=>document.querySelector('.mentor-citations'),'Mentor source explanation');
assert.equal(requests.filter(r=>r.path==='/api/mentor/messages').length,mentorBefore+1,'Double tap makes one message');
assert(!e('.mentor-transcript').querySelector('img'));assert(e('.mentor-transcript').textContent.includes(hardQ.answer));
click('[data-mentor-refresh]');await until(()=>!e('[data-mentor-refresh]').disabled,'Refresh complete');
assert.equal(requests.filter(r=>r.path==='/api/mentor/messages').length,mentorBefore+1,'Refresh never generates');
failMentorOnce=true;input('#mentor-message','Помоги повторить эту деталь');e('.mentor-composer').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
await until(()=>!e('[data-mentor-send]').disabled&&e('#mentor-message').value==='','Lost response recovered from history');
assert.equal(document.querySelectorAll('.mentor-message.learner').length,2);
assert.equal(requests.filter(r=>r.path==='/api/mentor/messages').length,mentorBefore+2);
core.go('/app/profile');await until(()=>document.querySelector('.profile-hero'),'Profile retained after mentor');assert.equal((await core.api('/growth')).pet_id,'moon');
assert(!requests.some(r=>r.status>=500));console.log('GAMES REAL API + DOM PASS: navigation after cards, six modes, correctness/explanations, gentle mistakes, server progress, pause/resume, escaped theory, token undo, pair completion, mixed route, lost-response idempotent retry, no exam/theory credit, profile, 15 pets, no-repeat phrases, legend trick, shop, equipment, one pet swap, preference, hard truth, mentor identity/context/citations, escaped chat, double-tap protection and lost mentor response recovery; requests='+requests.length);
core.state.cleanup?.();dom.window.close();process.exit(0);
