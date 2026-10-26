import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright' : 'playwright');
const base=process.env.BAROS_AUDIT_URL;
assert.match(base,/^http:\/\/127\.0\.0\.1:/,'This audit must never seed a live service');
const output=process.env.BAROS_AUDIT_OUTPUT;
const browser=await chromium.launch({headless:true,...process.env.BAROS_CHROMIUM?{executablePath:process.env.BAROS_CHROMIUM,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-software-rasterizer','--no-zygote','--single-process']}: {}});
const ctx=await browser.newContext({locale:'ru-RU',timezoneId:'Europe/Moscow',reducedMotion:'reduce'});
const page=await ctx.newPage();
page.on('dialog',d=>d.accept());
const errors=[],failures=[],screens=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(r.status()>=500)failures.push({url:r.url(),status:r.status()})});
let me=null,oid=null;
async function call(path,method='GET',data,extra={}){
 const headers={...me?{'x-csrf-token':me.csrf}:{},...oid&&me?.account.role==='owner'?{'x-organization-id':String(oid)}:{}};
 const res=await ctx.request.fetch(base+'/api'+path,{method,headers,...data!==undefined?{data}:{},...extra});
 assert(res.ok(),`${method} ${path}: ${res.status()} ${await res.text()}`);
 return res.json();
}
async function login(login){await call('/auth/login','POST',{login,password:'browser-audit-password'});me=await call('/me')}
await call('/auth/setup','POST',{token:process.env.FIRST_RUN_TOKEN,name:'Владелец аудита',login:'browser.owner',password:'browser-audit-password'});
me=await call('/me');
const venue=await call('/venues','POST',{name:'Академия бара: проверка длинных названий и стандартов сервиса',plan:'Пилот',days:30,seat_limit:50});oid=venue.id;
await call('/venues','POST',{name:'Пустое тестовое заведение',plan:'Пилот',days:30,seat_limit:50});
const invite=await call('/venues/'+oid+'/invite','POST',{});
const lessons=[{title:'Состав и подача лимонада',body:'## Результат урока\nВы сможете назвать состав напитка и порядок подачи.\n\n## Основные факты\nДля лимонада используют сироп персика 20 мл и газированную воду 80 мл.\n\n> Важно: гость может попросить убрать лёд.\n\n## Коротко\nСироп — 20 мл, вода — 80 мл.'},{title:'Работа с гостем и подтверждение заказа',body:'Сначала уточните пожелания гостя. Повторите состав и убедитесь, что заказ понят правильно. При неизвестном аллергене уточните состав у управляющего.'}];
const questions=Array.from({length:6},(_,i)=>({prompt:['Какой сироп входит в состав лимонада?','Сколько сиропа указано в рецептуре лимонада?','Какую воду используют для лимонада?','Сколько воды указано в рецептуре лимонада?','Кто должен уточнить состав при неизвестном аллергене?','Что нужно сделать перед подтверждением заказа?'][i],choices:[['Персиковый','Клубничный','Вишнёвый','Малиновый'],['20 мл','30 мл','40 мл','50 мл'],['Газированную','Дистиллированную','Кипячёную','Минеральную без газа'],['80 мл','60 мл','40 мл','20 мл'],['Управляющий','Другой гость','Курьер','Поставщик мебели'],['Повторить состав заказа','Сразу закрыть счёт','Заменить ингредиент','Пропустить уточнение']][i],correct_index:0,explanation:'Ответ указан в проверенных материалах заведения.',type:i<4?'knowledge':'scenario'}));
const c=await call('/courses','POST',{title:'Барная карта: стандарты подачи и коммуникация с гостем',description:'Состав, пропорции, аллергены и последовательность обслуживания. Проверка знаний перед самостоятельной практикой.',positions:['bartender'],lessons,questions,quiz_size:4});
await call('/courses/'+c.id+'/publish','POST',{reviewed:true,edit_version:c.edit_version});
await call('/courses','POST',{title:'Новый черновик для управляющего',lessons:[],questions:[],quiz_size:1});
await call('/sources','POST',undefined,{multipart:{roles:'["bartender"]',file:{name:'Меню бара — актуальные стандарты.txt',mimeType:'text/plain',buffer:Buffer.from(lessons.map(x=>x.body).join('\n'))}}});
const pack={format:'baros-package',version:1,kind:'assessment',assessment:{title:'Письменная аттестация: знания и проект R&D',description:'Диагностика знаний с ручной проверкой.',positions:['bartender'],sections:[{id:'theory',title:'Теория'},{id:'rnd',title:'Письменный R&D'}],tasks:[{id:'q1',section_id:'theory',kind:'single_choice',prompt:'Какой объём сиропа указан в учебной техкарте?',points:20,choices:['20 мл','30 мл','40 мл','50 мл'],correct_index:0,explanation:'Сироп 20 мл.'},{id:'q2',section_id:'rnd',kind:'written',prompt:'Опишите план проверки рецептуры и порядок расчёта себестоимости.',points:80,rubric:[{id:'plan',label:'План проверки',points:50},{id:'cost',label:'Проверка арифметики',points:30}]}]}};
const assessment=await call('/packages/import','POST',{package:pack});await call('/assessments/'+assessment.id+'/publish','POST',{reviewed:true});
await call(invite.url.replace('/invite/','/invites/'),'POST',{name:'Управляющий аудита',organization:venue.name});const managerMe=await call('/me');
me=managerMe;
// The one-time invite grants a session; retain its cookies instead of a secret.
const managerStorage=await ctx.storageState();
for(let i=0;i<8;i++){
 await call('/auth/join','POST',{code:venue.join_code,name:i===0?'Сотрудник для полного аудита':'Сотрудник '+i+' с длинным именем для проверки таблиц',login:'browser.worker'+i,password:'browser-audit-password',positions:['bartender']});me=await call('/me');
}
await login('browser.worker0');
for(let i=0;i<lessons.length;i++)await call(`/learning/${c.id}/lessons/${i}`,'POST',{complete:true});
const exam=await call('/learning/'+c.id+'/exam','POST',{});
await page.goto(base+'/');
async function shot(role,path,label,width,theme){
 await page.setViewportSize({width,height:width<800?844:1000});
 await page.evaluate(({theme,oid})=>{localStorage.setItem('baros:theme',theme);if(oid)localStorage.setItem('baros:venue',String(oid));else localStorage.removeItem('baros:venue')},{theme,oid:role==='remote'?oid:null});
 await page.goto(base+path);
 await page.waitForFunction(()=>document.querySelector('#app')?.getAttribute('aria-busy')==='false');
 await page.evaluate(()=>document.fonts.ready);
 if(label.startsWith('full-'))await page.locator('.catalog-question').evaluateAll(nodes=>nodes.forEach(n=>n.open=true));
 if(label==='exam')assert.equal(await page.locator('[data-retry-answer]').isVisible(),false,'Retry saving is hidden until a save fails');
 if(width<431)for(const action of await page.locator('.page-head .actions .btn').all()){
  const box=await action.boundingBox();assert(!box||box.width>=140,`Readable action width on ${role}/${label}: ${box?.width}`);
 }
 const info=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,title:document.querySelector('h1,h2')?.textContent||'',error:document.querySelector('#page-content .notice-box.error')?.textContent,overflow:[...document.querySelectorAll('#page-content *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.left< -1||r.right>innerWidth+1)&&!e.closest('.table-wrap,.tabs,.question-nav,.game-pair-list')}).slice(0,8).map(e=>({tag:e.tagName,cls:e.className,text:e.textContent.slice(0,60)}))}));
 const name=`${role}-${label}-${width}-${theme}`;await page.screenshot({path:join(output,name+'.png'),fullPage:true,animations:'disabled'});
 screens.push({name,path,...info});
 writeFileSync(join(output,'progress.json'),JSON.stringify({screens:screens.length,last:name,errors,server_failures:failures}));
}
const sizes=[360,390,768,1440];
async function sweep(role,routes){for(const width of sizes)for(const theme of ['light','dark'])for(const [path,label]of routes)if(!process.env.BAROS_AUDIT_FOCUS||process.env.BAROS_AUDIT_FOCUS===role+'/'+label)await shot(role,path,label,width,theme)}
await sweep('employee',[['/app','home'],['/app/learning','learning'],['/app/learn/'+c.id,'lesson'],['/app/exam/'+exam.id,'exam'],['/app/cards/'+c.id,'cards'],['/app/games/'+c.id,'games'],['/app/mentor','mentor'],['/app/shifts','shifts'],['/app/history','history'],['/app/notices','notices'],['/app/profile','profile'],['/app/settings','settings'],['/app/assessments','assessments']]);
await call('/exams/'+exam.id+'/finish','POST',{answers:{'0':0,'1':0,'2':0,'3':0}});
let written=await call('/assessments/'+assessment.id+'/start','POST',{});
written=await call('/assessment-attempts/'+written.id,'PUT',{version:written.version,answers:{q1:0}});
written=await call('/assessment-attempts/'+written.id+'/advance','POST',{version:written.version});
await sweep('employee',[['/app/assessment-attempts/'+written.id,'written']]);
written=await call('/assessment-attempts/'+written.id,'PUT',{version:written.version,answers:{q2:'Сначала сверю рецепт и единицы, затем рассчитаю себестоимость и зафиксирую результат.'}});
written=await call('/assessment-attempts/'+written.id+'/submit','POST',{version:written.version});
await sweep('employee',[['/app/assessment-attempts/'+written.id,'submitted']]);
await shot('employee','/app/exam/'+exam.id,'result',1440,'light');
// Check offline navigation's visible recovery state, then restore connectivity.
await ctx.setOffline(true);await page.goto(base+'/app').catch(()=>{});await ctx.setOffline(false);
await ctx.clearCookies();await ctx.addCookies(managerStorage.cookies);me=await call('/me');
await sweep('manager',[['/app','overview'],['/app/courses','courses'],['/app/assessments','assessments'],['/app/assessment-attempts/'+written.id,'written-review'],['/app/courses/'+c.id,'editor'],['/app/assessments/'+assessment.id,'assessment'],['/app/assessments/'+assessment.id+'/edit','assessment-editor'],['/app/staff','staff'],['/app/sources','sources'],['/app/reports','reports'],['/app/ai','ai'],['/app/interview','interview'],['/app/venues','venue-settings'],['/app/settings','settings']]);
await page.setViewportSize({width:390,height:844});await page.goto(base+'/app/sources');await page.locator('[data-upload]').click();await page.screenshot({path:join(output,'manager-upload-modal-390.png'),fullPage:true});await page.keyboard.press('Escape');
await page.locator('#mobile-menu').click();assert.equal(await page.locator('#mobile-menu').getAttribute('aria-expanded'),'true');await page.screenshot({path:join(output,'manager-mobile-menu-390.png')});await page.keyboard.press('Escape');
await login('browser.owner');
await sweep('owner',[['/app','platform'],['/app/venues','venues'],['/app/audit','audit'],['/app/settings','settings'],['/app/onboarding','onboarding'],['/app/catalog','catalog'],...['bar-02-classics','waiter-03-difficult','admin-02-guest','hookah-01-bowls','cook-03-allergens','clean-02-chemistry'].map(key=>['/app/catalog/'+key,'catalog-'+key])]);
for(const item of (await call('/owner/catalog')).courses)for(const width of sizes)for(const theme of ['light','dark'])await shot('owner','/app/catalog/'+item.key,'full-'+item.key,width,theme);
await page.goto(base+'/app/catalog');await page.locator('[data-catalog-activate]').click();await page.screenshot({path:join(output,'catalog-approval-modal-1440.png'),fullPage:true});await page.keyboard.press('Escape');
assert.equal((await call('/owner/catalog')).enabled,false,'Visual preview must not activate library');
// Full standard-library flow is exercised only on this disposable local server.
let approved=await call('/owner/catalog');await call('/owner/catalog/activate','POST',{reviewed:true,fingerprint:approved.fingerprint,expected_revision:approved.revision});
const future=await call('/venues','POST',{name:'Future venue after approved catalog'});assert.equal(future.courses,approved.courses.length);
await login('browser.worker0');const assigned=await call('/learning');const standard=assigned.courses.find(x=>x.id!==c.id);assert(standard);
const standardCourse=await call('/learning/'+standard.id);assert.equal(standardCourse.program.written_assessment_id,undefined);
await sweep('employee',[['/app/learn/'+standard.id,'standard-lesson']]);
assert.equal(await page.locator('.written-practice,.recall-tip').count(),0);
await login('browser.owner');
await shot('remote','/app','overview',390,'light');
await call('/auth/logout','POST',{});me=null;
await sweep('public',[['/','login'],['/join','join'],['/owner-recovery','recovery'],['/missing-page','missing']]);
const result={screens:screens.length,errors,server_failures:failures,layout_issues:screens.filter(s=>s.scroll>s.width+1||s.error),details:screens};
writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({screens:result.screens,errors,server_failures:failures,layout_issues:result.layout_issues.map(s=>({name:s.name,width:s.width,scroll:s.scroll,error:s.error}))},null,2));
await browser.close();
assert.equal(errors.length,0,'Browser runtime errors');assert.equal(failures.length,0,'Server 5xx');
assert.equal(result.layout_issues.length,0,'Screen overflow or error panels');
