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
page.on('response',r=>{if(r.status()>=500&&!(r.fromServiceWorker()&&r.headers()['x-baros-recovery']==='1'))failures.push({url:r.url(),status:r.status()})});
let me=null,oid=null;
async function call(path,method='GET',data,extra={}){
 const headers={...me?{'x-csrf-token':me.csrf}:{},...oid&&me?.account.role==='owner'?{'x-organization-id':String(oid)}:{}};
 const res=await ctx.request.fetch(base+'/api'+path,{method,headers,...data!==undefined?{data}:{},...extra});
 assert(res.ok(),`${method} ${path}: ${res.status()} ${await res.text()}`);
 return res.json();
}
async function login(login){await call('/auth/login','POST',{login,password:'browser-audit-password'});me=await call('/me')}
// Fail early for public layout regressions before the long course sweep.
await page.goto(base+'/');
for(const width of [360,390,768,1440])for(const theme of ['light','dark']){
 await page.setViewportSize({width,height:844});
 await page.evaluate(theme=>localStorage.setItem('baros:theme',theme),theme);
 await page.reload();await page.waitForFunction(()=>document.querySelector('#app')?.getAttribute('aria-busy')==='false');
 const dimensions=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth,font:parseFloat(getComputedStyle(document.querySelector('#team-size')).fontSize),field:document.querySelector('#team-size').getBoundingClientRect().width}));
 if(dimensions.scroll>width+1)await page.screenshot({path:join(output,`public-preflight-${width}-${theme}.png`),fullPage:true});
 assert(dimensions.scroll<=width+1,`Homepage fits ${width}/${theme}: ${JSON.stringify(dimensions)}`);
 assert(dimensions.font>=24&&dimensions.field<=140,'The team count keeps its large, compact numeric field');
}
console.log('PUBLIC LAYOUT PASS: all four widths and both themes fit without clipping; numeric field styling is preserved');
await call('/auth/setup','POST',{token:process.env.FIRST_RUN_TOKEN,name:'Владелец аудита',login:'browser.owner',password:'browser-audit-password'});
me=await call('/me');
const venue=await call('/venues','POST',{name:'Академия бара: проверка длинных названий и стандартов сервиса',plan:'Пилот',days:30,seat_limit:50});oid=venue.id;
await call('/venues','POST',{name:'Пустое тестовое заведение',plan:'Пилот',days:30,seat_limit:50});
const invite=await call('/venues/'+oid+'/invite','POST',{});
const photoBuffer=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAPAAAADICAIAAABZHvsFAAAETklEQVR4nO3bMW5UVxSA4XHEArIQCiraLIcd4IaSBnbABlJlE2lTUXgfDjVNiiAzxoOZ8cz4zfvP93VIyLr36Nc7V8hcfbn9uoGK35Y+AJySoEkRNCmCJkXQpAiaFEGTImhSBE2KoEkRNCmCJkXQpAiaFEGTImhSBE2KoEkRNCmCJkXQpAiaFEGTImhSXix9gKO8v75Z+ghN7z68XPoIT+QLTcq6g17vh+SSrXqq6w4afrDuN/RDHz+9WvoI6/P2zeelj3Ayq/9Cr3o/XqC1z3P1QcM2QZNSC7r0HHwesYkVgl77s+9yBCZZCBruBIOO7dCz6s0qEnRgVy6uMcNI0PC/ZtC9TXoOySl1gm5szKVkptcJGjbhoJP79ISq80kFndmbz6w0t1TQIGhSykFXn4nHC0+mFnTpOfg8YhOrBc1w8aDDu/XJ2jMJBh3boWfVm1Xtf33v9M/f/y59hEvx+o/flz7CeQW/0D9ob9hD5afRDLq3Sc8hOaURT478nt3fX38ufYIza36hf5Dfs3uaMIds0Ml9ekLV+WSDZiZBkzIl6AnPx8cNmUA56Ooz8XjhyZSDZqBBQQ/ZuTvNuXs86PBufbL2TOJBM82soOds3m2jbt0Pur1hD5WfRj9oRhkX9Kj9u5l33xFB5/fsnibMYUTQzCFoUiYGPedZOeemd6YEPeH5+LghE5gSNEMMDXrCLp5wx4cGBT1k5+405+6DgmaCuUG3N3L7do+YFfSczbtt1K1nBU3e6KCre7l6r32MC3rU/t3Mu++4oGkTNCnTg+49N3s3OsjEoOc8K+fc9M7EoAkTdGpHl+7yNEODnrCLJ9zxoaFBUyXozaayqRu3ONLcoNsbuX27R8wNmiRBf7P2fb3285/K6KCre7l6r32MDpoeQZMi6O/W+wxd78lPbnrQvedm70YHebH0AS6LT93aTf9CEyPo1I4u3eVpBE3K1Zfbr0ufIe799c32H31Ez8oXmhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNytWX269Ln2Hd3l/fnPYHvvvw8rQ/cBRB7+Xk1T6N1n9J0LtdSMGP0/dDgr5nFR0/pOw7gv7m0JQ/fnp1noN89/bN54P+vqw3gt78POVnSPYYP8t9eNYvlj7AZbnwiLdtH/XQb3mYoO/ZLuPC4xbxTp4c33hDNwj6Hv/KsXaC3m0VZev4IUHv5UL6VvAvCfpYfpfjogiaFL8+SoqgSRE0KYImRdCkCJoUQZMiaFIETYqgSRE0KYImRdCkCJoUQZMiaFIETYqgSRE0KYImRdCkCJoUQZMiaFIETYqgSRE0KYImRdCk/AcT4+uhlHKcbAAAAABJRU5ErkJggg==','base64');
const photo=await call('/media','POST',undefined,{multipart:{file:{name:'glass.png',mimeType:'image/png',buffer:photoBuffer}}});
const shiftTemplate=await call('/shifts/templates','POST',{title:'Вечерняя',color:'#8a68d7',emoji:'🌙',start_time:'16:00',end_time:'23:00',break_minutes:30,hourly_rate:30000});
const lessons=[{title:'Состав и подача лимонада',body:'## Результат урока\nВы сможете назвать состав напитка и порядок подачи.\n\n## Основные факты\nДля лимонада используют сироп персика 20 мл и газированную воду 80 мл.\n\n> Важно: гость может попросить убрать лёд.\n\n## Коротко\nСироп — 20 мл, вода — 80 мл.'},{title:'Работа с гостем и подтверждение заказа',body:'Сначала уточните пожелания гостя. Повторите состав и убедитесь, что заказ понят правильно. При неизвестном аллергене уточните состав у управляющего.'}];
const questions=Array.from({length:6},(_,i)=>({prompt:['Какой сироп входит в состав лимонада?','Сколько сиропа указано в рецептуре лимонада?','Какую воду используют для лимонада?','Сколько воды указано в рецептуре лимонада?','Кто должен уточнить состав при неизвестном аллергене?','Что нужно сделать перед подтверждением заказа?'][i],choices:[['Персиковый','Клубничный','Вишнёвый','Малиновый'],['20 мл','30 мл','40 мл','50 мл'],['Газированную','Дистиллированную','Кипячёную','Минеральную без газа'],['80 мл','60 мл','40 мл','20 мл'],['Управляющий','Другой гость','Курьер','Поставщик мебели'],['Повторить состав заказа','Сразу закрыть счёт','Заменить ингредиент','Пропустить уточнение']][i],correct_index:0,explanation:'Ответ указан в проверенных материалах заведения.',type:i<4?'knowledge':'scenario'}));
lessons[0].body+='\n\n![Учебная иллюстрация]('+photo.url+')';
questions[0].prompt+='\n![Иллюстрация к вопросу]('+photo.url+')';
const c=await call('/courses','POST',{title:'Барная карта: стандарты подачи и коммуникация с гостем',description:'Состав, пропорции, аллергены и последовательность обслуживания. Проверка знаний перед самостоятельной практикой.',positions:['bartender'],lessons,questions,quiz_size:4});
await call('/courses/'+c.id+'/publish','POST',{reviewed:true,edit_version:c.edit_version});
await call('/courses','POST',{title:'Новый черновик для управляющего',lessons:[],questions:[],quiz_size:1});
await call('/sources','POST',undefined,{multipart:{roles:'["bartender"]',file:{name:'Меню бара — актуальные стандарты.txt',mimeType:'text/plain',buffer:Buffer.from(lessons.map(x=>x.body).join('\n'))}}});
const pack={format:'baros-package',version:1,kind:'assessment',assessment:{title:'Письменная аттестация: знания и проект R&D',description:'Диагностика знаний с ручной проверкой.',positions:['bartender'],sections:[{id:'theory',title:'Теория'},{id:'rnd',title:'Письменный R&D'}],tasks:[{id:'q1',section_id:'theory',kind:'single_choice',prompt:'Какой объём сиропа указан в учебной техкарте?',points:20,choices:['20 мл','30 мл','40 мл','50 мл'],correct_index:0,explanation:'Сироп 20 мл.'},{id:'q2',section_id:'rnd',kind:'written',prompt:'Опишите план проверки рецептуры и порядок расчёта себестоимости.',points:80,rubric:[{id:'plan',label:'План проверки',points:50},{id:'cost',label:'Проверка арифметики',points:30}]}]}};
pack.assessment.tasks[1].prompt+='\n![Иллюстрация к письменному вопросу]('+photo.url+')';
const assessment=await call('/packages/import','POST',{package:pack});await call('/assessments/'+assessment.id+'/publish','POST',{reviewed:true});
const writtenCourse=await call('/courses','POST',{title:'Курс с письменной проверкой без автотеста',positions:['bartender'],quiz_size:0,lessons,questions:[]});
const linkedCourse=await call('/drafts/courses/'+writtenCourse.id+'/assessment','PUT',{assessment_id:assessment.id,edit_version:writtenCourse.edit_version});
await call('/courses/'+writtenCourse.id+'/publish','POST',{reviewed:true,edit_version:linkedCourse.edit_version});
const emptyTest=await call('/assessments','POST',{title:'Черновик пустого теста для проверки редактора',positions:['bartender']});

await call(invite.url.replace('/invite/','/invites/'),'POST',{name:'Управляющий аудита',organization:venue.name});const managerMe=await call('/me');
me=managerMe;
// The one-time invite grants a session; retain its cookies instead of a secret.
const managerStorage=await ctx.storageState();
for(let i=0;i<8;i++){
 await call('/auth/join','POST',{code:venue.join_code,name:i===0?'Сотрудник для полного аудита':'Сотрудник '+i+' с длинным именем для проверки таблиц',login:'browser.worker'+i,password:'browser-audit-password',positions:['bartender']});me=await call('/me');
}
await login('browser.worker0');
const shiftMonth=new Date().toISOString().slice(0,7),shiftDays=[10,12,15].map(d=>shiftMonth+'-'+String(d).padStart(2,'0'));
await call('/shifts/batch','POST',{account_id:me.account.id,template_id:shiftTemplate.id,template_version:shiftTemplate.version,days:shiftDays});
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
 if(label.startsWith('library-editor-')){
  const section=label.split('-').at(-1);
  await page.locator(`[data-editor-tab="${section}"]`).click();
  assert.equal(await page.locator('[data-publish]').count(),0,'Shared draft does not expose publication');
 }
 if(label==='written-only-lesson'){assert.equal(await page.locator('[data-start-exam]').count(),0);assert.equal(await page.locator('a[href^="/app/cards/"]').count(),0)}
 if(label.startsWith('reports')){for(const checkbox of await page.locator('.analytics-filters input[type=checkbox]').all()){const size=await checkbox.boundingBox();assert(size.width<=24&&size.height<=24,'Filter checkbox keeps a compact size')}for(const label of await page.locator('.analytics-filters .check-label').all()){const size=await label.boundingBox();assert(size.height<100,'Filter labels remain readable on mobile')}}
 if(role==='public'&&label.startsWith('landing')){assert.equal(await page.locator('.site-login').getAttribute('href'),'/login');assert.equal(await page.locator('#auth-form').count(),0);assert(await page.locator('#price-result').innerText().then(s=>s.replace(/\s/g,'').includes(label==='landing-custom'?'Индивидуально':label==='landing-self'?'4900':'9900')))}
 if(label==='exam')assert.equal(await page.locator('[data-retry-answer]').isVisible(),false,'Retry saving is hidden until a save fails');
 if(width<431)for(const action of await page.locator('.page-head .actions .btn').all()){
  const box=await action.boundingBox();assert(!box||box.width>=140,`Readable action width on ${role}/${label}: ${box?.width}`);
 }
 if(label==='login')assert.equal(await page.locator('a[href="/owner-recovery"]').count(),0);
 if(label==='landing-self'){assert((await page.locator('#price-result').innerText()).replace(/\s/g,'').includes('4900'));assert.equal(await page.locator('.site-setup-price').count(),0)}
 if(['lesson','cards','written'].includes(label)){const images=page.locator('.course-photo img');assert(await images.count()>0,'Private course photo rendered');await page.waitForFunction(()=>[...document.querySelectorAll('.course-photo img')].every(img=>img.complete&&img.naturalWidth>0));}
 if(label==='shifts-batch'){await page.locator('[data-toggle-multi]').click();await page.locator('[data-quick-template]').first().click();for(const d of [20,23])await page.locator(`[data-day="${shiftMonth}-${d}"]`).click();await page.locator('[data-preview-batch]').click();await page.locator('[data-apply-batch]:not([disabled])').waitFor()}
 if(label==='support'&&role!=='owner'){await page.locator('[data-new-support]').click();await page.screenshot({path:join(output,`${role}-support-dialog-${width}-${theme}.png`),fullPage:true});await page.keyboard.press('Escape')}
 const visibleCopy=await page.locator('body').innerText();assert(label.startsWith('legal')||!/(?<![A-Za-zА-Яа-яЁё])(?:AI|ИИ)(?![A-Za-zА-Яа-яЁё])|ChatGPT|Qwen|Yandex AI|ergin|frooppe|На, стой-ка|Сергей|sergey|Render|FIRST_RUN_TOKEN|SESSION_SECRET|API[- ]?ключ|провайдер/iu.test(visibleCopy),`Neutral customer copy: ${role}/${label}`);
 const info=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,title:document.querySelector('h1,h2')?.textContent||'',error:document.querySelector('#page-content .notice-box.error')?.textContent,overflow:[...document.querySelectorAll('#page-content *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.left< -1||r.right>innerWidth+1)&&!e.closest('.table-wrap,.tabs,.question-nav,.game-pair-list')}).slice(0,8).map(e=>({tag:e.tagName,cls:e.className,text:e.textContent.slice(0,60)}))}));
 const name=`${role}-${label}-${width}-${theme}`;await page.screenshot({path:join(output,name+'.png'),fullPage:true,animations:'disabled'});
 screens.push({name,path,...info});
 writeFileSync(join(output,'progress.json'),JSON.stringify({screens:screens.length,last:name,errors,server_failures:failures}));
}
const sizes=process.env.BAROS_AUDIT_REVERSE?[1440,768,390,360]:[360,390,768,1440];
const themes=process.env.BAROS_AUDIT_REVERSE?['dark','light']:['light','dark'];
async function sweep(role,routes){for(const width of sizes)for(const theme of themes)for(const [path,label]of routes)if(!process.env.BAROS_AUDIT_FOCUS||process.env.BAROS_AUDIT_FOCUS===role+'/'+label)await shot(role,path,label,width,theme)}
await sweep('employee',[['/app/shifts','shifts-batch'],['/app','home'],['/app/learning','learning'],['/app/learn/'+c.id,'lesson'],['/app/learn/'+writtenCourse.id,'written-only-lesson'],['/app/exam/'+exam.id,'exam'],['/app/cards/'+c.id,'cards'],['/app/games/'+c.id,'games'],['/app/mentor','mentor'],['/app/shifts','shifts'],['/app/history','history'],['/app/notices','notices'],['/app/profile','profile'],['/app/settings','settings'],['/app/support','support'],['/app/assessments','assessments']]);
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
await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
await page.setViewportSize({width:process.env.BAROS_AUDIT_REVERSE?1440:390,height:844});
await ctx.setOffline(true);const offline=await page.goto(base+'/app?reconnect-audit=1');
assert.equal(offline.status(),503);assert.equal(offline.headers()['x-baros-recovery'],'1');
assert.equal(await page.locator('h1').innerText(),'Не удаётся открыть BarOS');
assert.equal(await page.locator('meta[http-equiv=refresh]').getAttribute('content'),'8');
assert(!await page.locator('body').innerText().then(text=>text.includes('Вы вне сети')));
await page.screenshot({path:join(output,'employee-reconnect-'+(process.env.BAROS_AUDIT_REVERSE?'1440':'390')+'.png'),fullPage:true});
await ctx.setOffline(false);
// No explicit reload: the recovery page itself must return to the same route.
await page.waitForFunction(()=>document.querySelector('#app')?.getAttribute('aria-busy')==='false',{},{timeout:20000});
assert.equal(new URL(page.url()).search,'?reconnect-audit=1');
console.log('RECONNECT PASS: real service worker outage, neutral recovery, unchanged route and automatic restoration');
await ctx.clearCookies();await ctx.addCookies(managerStorage.cookies);me=await call('/me');
await sweep('manager',[['/app','overview'],['/app/courses','courses'],['/app/assessments','assessments'],['/app/assessment-attempts/'+written.id,'written-review'],['/app/courses/'+c.id,'editor'],['/app/assessments/'+assessment.id,'assessment'],['/app/assessments/'+assessment.id+'/edit','assessment-editor'],['/app/staff','staff'],['/app/sources','sources'],['/app/reports','reports'],...['courses','questions','written','timeline','attempts'].map(tab=>['/app/reports?tab='+tab,'reports-'+tab]),['/app/drafts','drafts'],['/app/ai','legacy-drafts'],['/app/assessments/'+emptyTest.id+'/edit','empty-test-editor'],['/app/interview','interview'],['/app/venues','venue-settings'],['/app/settings','settings'],['/app/support','support']]);
await page.setViewportSize({width:390,height:844});
await page.goto(base+'/app/courses/'+c.id);await page.locator('.photo-picker input[type=file]').first().setInputFiles({name:'glass-lesson.png',mimeType:'image/png',buffer:photoBuffer});
await page.waitForFunction(()=>document.querySelector('#lesson-body')?.value.match(/\/api\/media\//g)?.length===2);await page.locator('[data-save]').first().click();await page.waitForFunction(()=>document.querySelector('#save-state')?.textContent==='Все изменения сохранены');
assert((await call('/courses/'+c.id)).lessons[0].body.match(/\/api\/media\//g).length===2);
await page.locator('[data-editor-tab=questions]').click();await page.locator('[data-question="0"]').click();await page.locator('#question-form .photo-picker input[type=file]').first().setInputFiles({name:'glass-question.png',mimeType:'image/png',buffer:photoBuffer});await page.waitForFunction(()=>document.querySelector('#question-form [name=prompt]')?.value.match(/\/api\/media\//g)?.length===2);await page.locator('#question-form button[type=submit]').click();await page.locator('[data-save]').first().click();await page.waitForFunction(()=>document.querySelector('#save-state')?.textContent==='Все изменения сохранены');
assert((await call('/courses/'+c.id)).questions[0].prompt.match(/\/api\/media\//g).length===2);
await page.goto(base+'/app/assessments/'+assessment.id+'/edit');const taskPhoto=page.locator('[data-task-editor]').last();await taskPhoto.locator('summary').first().click();await taskPhoto.locator('.photo-picker input[type=file]').setInputFiles({name:'glass-written.png',mimeType:'image/png',buffer:photoBuffer});await page.waitForFunction(()=>[...document.querySelectorAll('[data-task-editor]')].at(-1)?.querySelector('[name=task-prompt]')?.value.match(/\/api\/media\//g)?.length===2);await page.locator('[name=reviewed]').check();await page.locator('[data-save-assessment]').click();await page.waitForFunction(()=>document.querySelector('[data-editor-status]')?.textContent==='Все изменения сохранены');
assert((await call('/assessments/'+assessment.id)).package.tasks[1].prompt.match(/\/api\/media\//g).length===2);
console.log('PHOTO UPLOAD PASS: lesson, course question and written assessment persisted through their actual editor file controls');
await page.setViewportSize({width:390,height:844});await page.goto(base+'/app/sources');await page.locator('[data-upload]').click();await page.screenshot({path:join(output,'manager-upload-modal-390.png'),fullPage:true});await page.keyboard.press('Escape');
await page.locator('#mobile-menu').click();assert.equal(await page.locator('#mobile-menu').getAttribute('aria-expanded'),'true');await page.screenshot({path:join(output,'manager-mobile-menu-390.png')});await page.keyboard.press('Escape');
await login('browser.owner');
await page.goto(base+'/app/pricing');await page.locator('#pricing-form').waitFor();
await page.locator('[name=price_50]').fill('10000');await page.locator('#pricing-form button[type=submit]').click();
await page.waitForFunction(()=>document.querySelector('#toast-root')?.textContent.includes('Тарифы на сайте обновлены'));
assert.equal((await call('/pricing')).tiers[0].monthly,10000);
await page.goto(base+'/about?employees=50');await page.locator('#price-result').waitFor();assert((await page.locator('#price-result').innerText()).replace(/\s/g,'').includes('10000'));
await page.goto(base+'/app/pricing');await page.locator('#pricing-form').waitFor();await page.locator('[name=price_50]').fill('9900');await page.locator('#pricing-form button[type=submit]').click();
await page.waitForFunction(()=>document.querySelector('#toast-root')?.textContent.includes('Тарифы на сайте обновлены'));
assert.equal((await call('/pricing')).tiers[0].monthly,9900);
await sweep('owner',[['/app','platform'],['/app/legal','legal-editor'],['/app/venues','venues'],['/app/audit','audit'],['/app/pricing','pricing-editor'],['/app/settings','settings'],['/app/support','support'],['/app/onboarding','onboarding'],['/app/catalog','catalog'],...['bar-02-classics','waiter-03-difficult','admin-02-guest','hookah-01-bowls','cook-03-allergens','clean-02-chemistry'].map(key=>['/app/catalog/'+key,'catalog-'+key])]);
await sweep('owner',['bar-02-classics','waiter-03-difficult','admin-02-guest','hookah-01-bowls','cook-03-allergens','clean-02-chemistry'].flatMap(key=>['theory','questions','settings'].map(section=>['/app/catalog/'+key+'/edit','library-editor-'+key+'-'+section])));
for(const item of (await call('/owner/catalog')).courses)for(const width of sizes)for(const theme of themes)await shot('owner','/app/catalog/'+item.key,'full-'+item.key,width,theme);
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
// Exercise the public page as an actual visitor, then all session redirects.
await page.setViewportSize({width:390,height:844});await page.goto(base+'/');
await page.locator('#team-size').waitFor();
for(const [n,price] of [[1,'9 900'],[50,'9 900'],[51,'14 900'],[100,'14 900'],[101,'24 900'],[200,'24 900'],[201,'Индивидуально'],[10000,'Индивидуально']]){
 await page.locator('#team-size').fill(String(n));assert((await page.locator('#price-result').innerText()).replace(/\s/g,'').includes(price.replace(/\s/g,'')));
 assert.equal(new URL(page.url()).searchParams.get('employees'),String(n));
}
await page.locator('#team-size').fill('0');assert.equal(await page.locator('#team-size').getAttribute('aria-invalid'),'true');assert(await page.locator('[data-quote]').isDisabled());
await page.locator('[data-team="100"]').click();assert((await page.locator('#price-result').innerText()).replace(/\s/g,'').includes('14900'));
const downloadEvent=page.waitForEvent('download');await page.locator('[data-quote]').click();const download=await downloadEvent;assert.equal(download.suggestedFilename(),'BarOS-100-employees.txt');
await page.locator('.site-login').click();await page.locator('#auth-form').waitFor();assert.equal(new URL(page.url()).pathname,'/login');
for(const who of ['browser.worker0','browser.owner']){
 await login(who);await page.goto(base+'/');await page.waitForURL(base+'/app');await page.locator('.site-return').waitFor();
 await page.locator('.site-return').click();await page.locator('#team-size').waitFor();assert.equal(new URL(page.url()).pathname,'/about');
 await page.reload();await page.locator('#team-size').waitFor();assert.equal(new URL(page.url()).pathname,'/about');
 await page.locator('.site-login').click();await page.waitForURL(base+'/app');
 await page.goto(base+'/login');await page.waitForURL(base+'/app');
 await call('/auth/logout','POST',{});me=null;
}
await ctx.addCookies(managerStorage.cookies);me=await call('/me');
await page.goto(base+'/');await page.waitForURL(base+'/app');
await page.locator('.site-return').click();await page.locator('#team-size').waitFor();assert.equal(new URL(page.url()).pathname,'/about');
await page.locator('.site-login').click();await page.waitForURL(base+'/app');
await call('/auth/logout','POST',{});me=null;
console.log('PUBLIC HOME PASS: tier boundaries, custom and invalid counts, quote download, login and role-specific session redirects, explicit home return without loops');
await sweep('public',[...['privacy','terms','processing','confidentiality','payment'].map(k=>['/legal/'+k,'legal-'+k]),['/about?employees=50&mode=self','landing-self'],['/','landing'],['/login','login'],['/about?employees=201','landing-custom'],['/join','join'],['/owner-recovery','recovery'],['/missing-page','missing']]);
const result={screens:screens.length,errors,server_failures:failures,layout_issues:screens.filter(s=>s.scroll>s.width+1||s.error),details:screens};
writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({screens:result.screens,errors,server_failures:failures,layout_issues:result.layout_issues.map(s=>({name:s.name,width:s.width,scroll:s.scroll,error:s.error}))},null,2));
await browser.close();
assert.equal(errors.length,0,'Browser runtime errors');assert.equal(failures.length,0,'Server 5xx');
assert.equal(result.layout_issues.length,0,'Screen overflow or error panels');
