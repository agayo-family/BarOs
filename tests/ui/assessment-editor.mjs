import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

// Exercise the shipped editor and its real persistence boundary on a disposable DB.
const base=process.env.BAROS_AUDIT_URL;
const dom=new JSDOM('<div id="app"></div><div id="modal-root"></div><div id="toast-root"></div>',{url:base+'/app',pretendToBeVisual:true});
for(const key of ['window','document','location','history','localStorage','sessionStorage','FormData','Event','CustomEvent','MouseEvent','HTMLElement'])globalThis[key]=dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
globalThis.confirm=()=>true;
dom.window.scrollTo=()=>{};
dom.window.HTMLElement.prototype.scrollIntoView=function(){};
const nativeFetch=globalThis.fetch,requests=[];
globalThis.fetch=async(path,options={})=>{
 const url=new URL(path,base),headers=new Headers(options.headers||{}),cookie=dom.cookieJar.getCookieStringSync(base);
 if(cookie)headers.set('cookie',cookie);
 const response=await nativeFetch(url,{...options,headers});
 for(const value of response.headers.getSetCookie())dom.cookieJar.setCookieSync(value,base);
 requests.push({path:url.pathname,method:options.method||'GET',status:response.status,body:typeof options.body==='string'?JSON.parse(options.body):undefined});
 return response;
};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,message){for(let i=0;i<250;i++){if(test())return;await pause(20)}throw new Error(message+'; '+document.body.textContent.slice(-1200))}
function e(selector,root=document){const node=root.querySelector(selector);assert(node,'Missing '+selector);return node}
const all=(selector,root=document)=>[...root.querySelectorAll(selector)];
function click(selector,root=document){e(selector,root).click()}
function focusClick(selector,root=document){e(selector,root).focus();click(selector,root)}
function assertEditorFocus(message){assert(document.activeElement?.isConnected&&e('#edit-assessment').contains(document.activeElement),message)}
function fill(selector,value,root=document){const node=e(selector,root);node.value=String(value);node.dispatchEvent(new Event('input',{bubbles:true}));if(node.tagName==='SELECT')node.dispatchEvent(new Event('change',{bubbles:true}))}
function check(selector,value,root=document){const node=e(selector,root);node.checked=value;node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}))}
function submit(){e('#edit-assessment').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))}
async function auth(path,body){const response=await fetch('/api/auth/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert(response.ok,await response.text())}
const task=id=>e('[data-task-editor="'+id+'"]');
const section=id=>e('[data-section-editor="'+id+'"]');
const taskOrder=sectionId=>all('[data-task-editor]').filter(node=>e('[name=task-section]',node).value===sectionId).map(node=>node.dataset.taskEditor);
const sectionOrder=()=>all('[data-section-editor]').map(node=>node.dataset.sectionEditor);
function openEditors(){for(const detail of all('#edit-assessment details'))detail.open=true}

await auth('setup',{token:'baros-ui-audit-only',name:'Editor owner',login:'editor.owner',password:'editor-owner-password'});
await import('./ui/app.js');
const core=await import('./ui/core.js?v=2.8.0');
await until(()=>document.querySelector('[data-new-venue]'),'Owner loaded');
const venue=await core.api('/venues','POST',{name:'Isolated assessment editor UI'});
core.setOrg(venue.id);
const pkg={format:'baros-package',version:1,kind:'assessment',assessment:{
 title:'Исходный тест редактора',description:'Исходное описание',instructions:'Исходная общая инструкция',positions:['bartender'],
 time_limit_minutes:60,max_attempts:1,passing_score:null,sequential_sections:false,
 sections:[{id:'theory',title:'Теория',instructions:'Старая теория'},{id:'rnd',title:'Письменный план',instructions:'Старая инструкция'},{id:'discard',title:'Удаляемый раздел'}],
 tasks:[
  {id:'q1',section_id:'theory',kind:'single_choice',prompt:'Какой вариант соответствует исходному ключу?',points:20,choices:['Исходный первый','Исходный второй','Удаляемый вариант'],correct_index:1,explanation:'PRIVATE_OLD_KEY'},
  {id:'q3',section_id:'theory',kind:'single_choice',prompt:'Второй вопрос для проверки порядка заданий.',points:10,choices:['Да','Нет'],correct_index:0},
  {id:'q2',section_id:'rnd',kind:'written',prompt:'Опишите исходный письменный план.',points:60,rubric:[{id:'plan',label:'Старый план',points:40,guidance:'PRIVATE_OLD_RUBRIC'},{id:'cost',label:'Старая стоимость',points:20,guidance:'Старая арифметика'}],score_cap:{points:40,guidance:'Ограничение при грубом нарушении brief.'}},
  {id:'qdrop',section_id:'discard',kind:'written',prompt:'Вопрос удаляемого раздела.',points:10,rubric:[{id:'temp',label:'Временный',points:10}]}
 ]
}};
const imported=await core.api('/packages/import','POST',{package:pkg}),aid=imported.id;
await core.api('/assessments/'+aid+'/publish','POST',{reviewed:true});
const before=await core.api('/assessments/'+aid);
assert(before.revision,'Manager detail exposes an optimistic concurrency token');

// An already-started employee must retain the old instructions, task order and key.
await core.api('/auth/logout','POST',{});core.state.me=null;core.setOrg('');
await auth('join',{code:venue.join_code,name:'Existing editor learner',login:'editor.worker',password:'editor-worker-password',positions:['bartender']});
await core.reloadMe();
const oldAttempt=await core.api('/assessments/'+aid+'/start','POST',{});
assert.equal(oldAttempt.tasks.length,4);
await core.api('/auth/logout','POST',{});core.state.me=null;
await auth('login',{login:'editor.owner',password:'editor-owner-password'});await core.reloadMe();core.setOrg(venue.id);
core.go('/app/assessments/'+aid);
await until(()=>document.querySelector('[data-edit-assessment]'),'Manager has edit navigation');
click('[data-edit-assessment]');
await until(()=>document.querySelector('#edit-assessment'),'Editor route mounted');
assert.equal(location.pathname,'/app/assessments/'+aid+'/edit');
openEditors();
assert.equal(e('[name=title]').value,pkg.assessment.title);
assert.equal(e('[name=reviewed]').required,true,'A published test requires explicit review');

// Continuous typing is one undo group; another field must remain independent.
fill('[name=title]','Промежуточное название');
fill('[name=title]','Название после нескольких вводов');
fill('[name=description]','Описание отдельной группы ввода');
click('[data-editor-undo]');
assert.equal(e('[name=description]').value,pkg.assessment.description,'Undo only the most recent field group');
assert.equal(e('[name=title]').value,'Название после нескольких вводов','Undoing description keeps typed title');
click('[data-editor-undo]');
assert.equal(e('[name=title]').value,pkg.assessment.title,'One undo reverts the whole title typing group');
click('[data-editor-redo]');
assert.equal(e('[name=title]').value,'Название после нескольких вводов');
fill('[name=title]','Новая ветка после отмены');
assert.equal(e('[data-editor-redo]').disabled,true,'Typing after undo/redo clears the abandoned redo branch');
click('[data-editor-redo]');
assert.equal(e('[name=title]').value,'Новая ветка после отмены','A stale redo cannot overwrite newer typing');

fill('[name=title]','Изменённый тест редактора');
fill('[name=description]','Новое описание для команды');
fill('[name=instructions]','Новая общая инструкция');
fill('[name=time_limit_minutes]',95);
fill('[name=max_attempts]',3);
fill('[name=passing_score]',72.5);
check('[name=sequential_sections]',true);
check('[name=positions][value=waiter]',true);

// Reordering is checked by stable task IDs rather than by generated element order.
focusClick('[data-task-up]',task('q3'));
assertEditorFocus('Reordering retains focus in the editor');
assert.deepEqual(taskOrder('theory'),['q3','q1']);
click('[data-task-down]',task('q3'));
assert.deepEqual(taskOrder('theory'),['q1','q3']);
click('[data-task-up]',task('q3'));
click('[data-section-up]',section('rnd'));
assert.deepEqual(sectionOrder(),['rnd','theory','discard']);
fill('[name=section-title]','Обновлённая теория',section('theory'));
fill('[name=section-instructions]','Новая инструкция к теории',section('theory'));
focusClick('[data-section-remove]',section('discard'));
assertEditorFocus('Removing the focused section moves focus to a surviving editor control');
assert(!document.querySelector('[data-section-editor=discard]'));
assert(!document.querySelector('[data-task-editor=qdrop]'),'Removing a section removes its tasks');

// Edit question text, weighted points, answer variants, the key and its explanation.
fill('[name=task-prompt]','Какой новый вариант соответствует обновлённому ключу?',task('q1'));
fill('[name=task-points]',25,task('q1'));
fill('[name=task-explanation]','PRIVATE_NEW_KEY_EXPLANATION',task('q1'));
fill('[data-choice-index="0"] [name=choice-text]','Новый первый вариант',task('q1'));
click('[data-add-choice]',task('q1'));
fill('[data-choice-index="3"] [name=choice-text]','Новый правильный вариант',task('q1'));
click('[data-choice-remove="2"]',task('q1'));
fill('[name=task-correct-index]',2,task('q1'));
assert.equal(all('[name=choice-text]',task('q1')).length,3);
click('[data-choice-up="2"]',task('q1'));
assert.equal(e('[name=task-correct-index]',task('q1')).value,'1','Reordering follows the correct answer');
click('[data-choice-down="1"]',task('q1'));
assert.equal(e('[name=task-correct-index]',task('q1')).value,'2');
const originalTaskIds=new Set(all('[data-task-editor]').map(node=>node.dataset.taskEditor));
click('[data-task-duplicate]',task('q1'));
const copiedTask=all('[data-task-editor]').find(node=>!originalTaskIds.has(node.dataset.taskEditor));
assert(copiedTask,'A copied task gets a fresh ID');
fill('[name=task-prompt]','Изменение только в копии задания.',copiedTask);
assert.equal(e('[name=task-prompt]',task('q1')).value,'Какой новый вариант соответствует обновлённому ключу?','Duplicate content is independent');
focusClick('[data-task-remove]',copiedTask);
assertEditorFocus('Removing the focused copied task keeps keyboard focus in the editor');
fill('[name=task-section]','rnd',task('q3'));
assert.equal(e('[name=task-section]',task('q3')).value,'rnd','An existing question moves to a different section');
assert.deepEqual(taskOrder('rnd'),['q3','q2']);

// Written criteria can be expanded and removed without losing existing IDs.
fill('[name=task-prompt]','Опишите обновлённый письменный план.',task('q2'));
fill('[name=task-points]',50,task('q2'));
fill('[name=task-max-length]',2400,task('q2'));
fill('[data-rubric-index="0"] [name=rubric-label]','Согласованность плана',task('q2'));
fill('[data-rubric-index="0"] [name=rubric-points]',30,task('q2'));
fill('[data-rubric-index="0"] [name=rubric-guidance]','PRIVATE_NEW_RUBRIC_ANCHOR',task('q2'));
click('[data-add-rubric]',task('q2'));
fill('[data-rubric-index="2"] [name=rubric-label]','Обоснование расчёта',task('q2'));
fill('[data-rubric-index="2"] [name=rubric-points]',20,task('q2'));
fill('[data-rubric-index="2"] [name=rubric-guidance]','PRIVATE_NEW_COST_ANCHOR',task('q2'));
click('[data-rubric-remove="1"]',task('q2'));
assert.equal(all('[data-rubric-index]',task('q2')).length,2);
check('[name=task-cap-enabled]',false,task('q2'));
assert(!task('q2').querySelector('[name=task-cap-points]'));
check('[name=task-cap-enabled]',true,task('q2'));
fill('[name=task-cap-points]',35,task('q2'));
fill('[name=task-cap-guidance]','Новый предел при грубом нарушении brief.',task('q2'));

// Add a new section, add and remove tasks, then move the surviving new task.
click('[data-add-section]');
const addedSection=all('[data-section-editor]').find(node=>!['rnd','theory'].includes(node.dataset.sectionEditor));
assert(addedSection,'New section has a stable ID');
const addedSectionId=addedSection.dataset.sectionEditor;
fill('[name=section-title]','Новый практический раздел',addedSection);
fill('[name=section-instructions]','Работа выполняется письменно.',section(addedSectionId));
const taskIds=new Set(all('[data-task-editor]').map(node=>node.dataset.taskEditor));
click('[data-add-task]',section(addedSectionId));
let addedTask=all('[data-task-editor]').find(node=>!taskIds.has(node.dataset.taskEditor));
assert(addedTask,'New task is rendered');
const addedTaskId=addedTask.dataset.taskEditor;
fill('[name=task-kind]','written',task(addedTaskId));
fill('[name=task-prompt]','Опишите новый письменный сценарий общения с гостем.',task(addedTaskId));
fill('[name=task-points]',15,task(addedTaskId));
fill('[name=task-max-length]',1500,task(addedTaskId));
if(!all('[data-rubric-index]',task(addedTaskId)).length)click('[data-add-rubric]',task(addedTaskId));
fill('[data-rubric-index="0"] [name=rubric-label]','Содержание ответа',task(addedTaskId));
fill('[data-rubric-index="0"] [name=rubric-points]',15,task(addedTaskId));
fill('[data-rubric-index="0"] [name=rubric-guidance]','PRIVATE_NEW_GUEST_ANCHOR',task(addedTaskId));
const retainedIds=new Set(all('[data-task-editor]').map(node=>node.dataset.taskEditor));
click('[data-add-task]',section(addedSectionId));
const disposableTask=all('[data-task-editor]').find(node=>!retainedIds.has(node.dataset.taskEditor));
assert(disposableTask);
click('[data-task-remove]',disposableTask);
assert.equal(all('[data-task-editor]').length,4);

// Undo and redo a structural edit before saving, so they exercise real draft state.
click('[data-section-up]',section(addedSectionId));
assert.deepEqual(sectionOrder(),['rnd',addedSectionId,'theory']);
click('[data-editor-undo]');
assert.deepEqual(sectionOrder(),['rnd','theory',addedSectionId]);
click('[data-editor-redo]');
assert.deepEqual(sectionOrder(),['rnd',addedSectionId,'theory']);

const puts=()=>requests.filter(r=>r.path==='/api/assessments/'+aid&&r.method==='PUT');
const beforeSaveCount=puts().length;
fill('[name=time_limit_minutes]',0);
assert.equal(e('[name=time_limit_minutes]').validity.rangeUnderflow,true);
submit();
await until(()=>document.querySelector('#edit-assessment .form-error')&&document.activeElement===e('[name=time_limit_minutes]'),'Native invalid number retains focus');
assert.equal(puts().length,beforeSaveCount,'Invalid input never reaches persistence');
assert.notEqual(document.activeElement,document.querySelector('.form-error'),'The error summary does not steal field focus');
fill('[name=time_limit_minutes]',95);
fill('[name=title]','   ');
submit();
await until(()=>document.querySelector('#edit-assessment .form-error')?.textContent.includes('Название')&&document.activeElement===e('[name=title]'),'Whitespace-only title fails with focus on the field');
assert.equal(puts().length,beforeSaveCount);
fill('[name=title]','Изменённый тест редактора');
submit();
await until(()=>document.querySelector('#edit-assessment .form-error')?.textContent.includes('Подтвердите')||puts().length>beforeSaveCount,'Unchecked reviewed rejected');
assert.equal(puts().filter(r=>r.status===200).length,0,'Published changes cannot save without review');
assert.equal((await core.api('/assessments/'+aid)).revision,before.revision);
check('[name=reviewed]',true);
submit();
await until(()=>puts().some(r=>r.status===200),'Edited assessment persisted');
await until(()=>!document.querySelector('#edit-assessment')||!e('#edit-assessment').hasAttribute('aria-busy'),'Save UI settled');
const saved=(await core.api('/assessments/'+aid)),successfulPut=puts().find(r=>r.status===200);
assert.equal(successfulPut.body.revision,before.revision,'Save carries loaded revision');
assert.equal(successfulPut.body.reviewed,true);
assert.deepEqual(saved.package,successfulPut.body.assessment,'API saved the complete editor payload');
assert.notEqual(saved.revision,before.revision);
assert.equal(saved.published,true,'Editing keeps the test published');
assert.equal(saved.package.title,'Изменённый тест редактора');
assert.equal(saved.package.description,'Новое описание для команды');
assert.equal(saved.package.instructions,'Новая общая инструкция');
assert.equal(saved.package.time_limit_minutes,95);
assert.equal(saved.package.max_attempts,3);
assert.equal(saved.package.passing_score,72.5);
assert.equal(saved.package.sequential_sections,true);
assert.deepEqual([...saved.package.positions].sort(),['bartender','waiter']);
assert.deepEqual(saved.package.sections.map(s=>s.id),['rnd',addedSectionId,'theory']);
assert.equal(saved.package.sections.find(s=>s.id==='theory').title,'Обновлённая теория');
assert.equal(saved.package.sections.find(s=>s.id==='theory').instructions,'Новая инструкция к теории');
assert.deepEqual(saved.package.tasks.filter(t=>t.section_id==='theory').map(t=>t.id),['q1']);
assert.deepEqual(saved.package.tasks.filter(t=>t.section_id==='rnd').map(t=>t.id),['q3','q2']);
const mcq=saved.package.tasks.find(t=>t.id==='q1'),written=saved.package.tasks.find(t=>t.id==='q2');
assert.equal(mcq.points,25);
assert.deepEqual(mcq.choices,['Новый первый вариант','Исходный второй','Новый правильный вариант']);
assert.equal(mcq.correct_index,2);
assert.equal(mcq.explanation,'PRIVATE_NEW_KEY_EXPLANATION');
assert.equal(written.points,50);
assert.equal(written.max_length,2400);
assert.equal(written.rubric[0].id,'plan');
assert.deepEqual(written.rubric.map(c=>[c.label,c.points,c.guidance]),[['Согласованность плана',30,'PRIVATE_NEW_RUBRIC_ANCHOR'],['Обоснование расчёта',20,'PRIVATE_NEW_COST_ANCHOR']]);
assert.deepEqual(written.score_cap,{points:35,guidance:'Новый предел при грубом нарушении brief.'});
assert(!saved.package.tasks.some(t=>t.id==='qdrop'));
assert.equal(saved.package.tasks.find(t=>t.id===addedTaskId).section_id,addedSectionId);

// Reload via navigation to verify the editor hydrates server state, not old DOM state.
core.go('/app/assessments/'+aid+'/edit');
await until(()=>document.querySelector('#edit-assessment'),'Editor reloads');
assert.equal(e('[name=title]').value,saved.package.title);
assert.equal(e('[name=task-prompt]',task('q2')).value,written.prompt);
assert.equal(all('[data-section-editor]').length,3);

// Another tab may publish the draft without changing the content revision.
const racePackage=JSON.parse(JSON.stringify(pkg));
racePackage.assessment.title='Черновик параллельной публикации';
const raceImport=await core.api('/packages/import','POST',{package:racePackage}),raceId=raceImport.id;
core.go('/app/assessments/'+raceId+'/edit');
await until(()=>document.querySelector('#edit-assessment [name=title]')?.value===racePackage.assessment.title,'Unpublished editor mounted');
assert.equal(e('[name=reviewed]').required,false,'Draft still offers optional review confirmation');
const draftRevision=(await core.api('/assessments/'+raceId)).revision;
fill('[name=title]','Правки переживают публикацию в другом окне');
await core.api('/assessments/'+raceId+'/publish','POST',{reviewed:true});
assert.equal((await core.api('/assessments/'+raceId)).revision,draftRevision,'Publication itself does not change the content revision');
const racePuts=()=>requests.filter(r=>r.path==='/api/assessments/'+raceId&&r.method==='PUT');
submit();
await until(()=>racePuts().some(r=>r.status===400)&&document.querySelector('#edit-assessment .form-error')?.textContent.includes('Подтвердите'),'Concurrent publication requires review at the API boundary');
assert.equal(e('[name=title]').value,'Правки переживают публикацию в другом окне','Rejected save preserves local edits');
check('[name=reviewed]',true);
submit();
await until(()=>racePuts().some(r=>r.status===200),'Optional draft review checkbox allows retry after concurrent publication');
await until(()=>!e('#edit-assessment').hasAttribute('aria-busy'),'Race retry settles');
const raceSaved=await core.api('/assessments/'+raceId);
assert.equal(raceSaved.package.title,'Правки переживают публикацию в другом окне');
assert.equal(raceSaved.published,true);

// A stale save must keep the local draft until the manager chooses to reload.
fill('[name=title]','Несохранённая локальная правка');
const external=JSON.parse(JSON.stringify(raceSaved.package));external.title='Сохранённая правка другой вкладки';
await core.api('/assessments/'+raceId,'PUT',{revision:raceSaved.revision,assessment:external,reviewed:true});
check('[name=reviewed]',true);submit();
await until(()=>racePuts().some(r=>r.status===409)&&document.querySelector('.form-error')?.textContent.includes('другом окне'),'Stale save reports conflict');
assert.equal(e('[name=title]').value,'Несохранённая локальная правка');
assert.equal(core.state.dirty,true,'Conflict does not mark unsaved edits as saved');
const draftKey=Object.keys(sessionStorage).find(key=>key.startsWith('baros:assessment-editor:')&&key.endsWith(':'+raceId));
assert.equal(JSON.parse(sessionStorage.getItem(draftKey)).assessment.title,'Несохранённая локальная правка','Conflict keeps a recoverable draft');
click('[data-reload-assessment]');
await until(()=>document.querySelector('#edit-assessment [name=title]')?.value===external.title,'Explicit reload fetches the current saved version');
assert.equal(core.state.dirty,false);

await core.api('/auth/logout','POST',{});core.state.me=null;core.setOrg('');
await auth('login',{login:'editor.worker',password:'editor-worker-password'});await core.reloadMe();
core.go('/app/assessments/'+aid);
await until(()=>document.querySelector('[data-start-test]'),'Employee detail reloads after manager edits');
assert(!document.querySelector('[data-edit-assessment]'),'Employee has no edit navigation');
assert(!document.body.textContent.includes('PRIVATE_'),'Employee detail hides all keys and rubric anchors');
core.go('/app/assessments/'+aid+'/edit');
await until(()=>document.querySelector('#page-content')&&!document.querySelector('#route-progress:not([hidden])'),'Employee editor route settled');
assert(!document.querySelector('#edit-assessment'),'Direct employee navigation cannot expose the editor');
assert(!document.body.textContent.includes('PRIVATE_'));
await assert.rejects(core.api('/assessments/'+aid,'PUT',{revision:saved.revision,assessment:saved.package,reviewed:true}),error=>error.status===403);
const resumed=await core.api('/assessments/'+aid+'/start','POST',{});
assert.equal(resumed.id,oldAttempt.id);
assert.equal(resumed.title,pkg.assessment.title);
assert.equal(resumed.instructions,pkg.assessment.instructions);
assert.equal(resumed.sequential_sections,false);
assert.deepEqual(resumed.tasks,oldAttempt.tasks,'Started task snapshot is immutable after manager edits');
assert(!JSON.stringify(resumed).includes('PRIVATE_'));
assert(resumed.tasks.every(t=>!Object.hasOwn(t,'correct_index')&&!Object.hasOwn(t,'rubric')&&!Object.hasOwn(t,'explanation')));

// A newly assigned waiter sees the saved version through the ordinary start UI.
await core.api('/auth/logout','POST',{});core.state.me=null;
await auth('join',{code:venue.join_code,name:'New editor learner',login:'editor.new-worker',password:'editor-new-worker-password',positions:['waiter']});
await core.reloadMe();core.go('/app/assessments/'+aid);
await until(()=>document.querySelector('[data-start-test]'),'Newly assigned role can open the edited test');
click('[data-start-test]');
await until(()=>document.querySelector('[data-answer=q2]'),'New learner starts the saved first section');
assert.equal(e('h1').textContent,saved.package.title);
assert(document.body.textContent.includes(written.prompt));
assert(!document.body.textContent.includes('PRIVATE_'),'Edited keys, cap guidance and rubrics remain private');
assert(!document.querySelector('[data-answer="'+addedTaskId+'"]'),'Sequential later section remains closed');

console.log('ASSESSMENT EDITOR REAL API + DOM PASS: edit navigation; metadata and positions; sections/tasks add, remove, reorder, duplicate and move; choices with stable key; written rubric and cap; grouped text undo and cleared redo branches; focus after structural edits and validation; reviewed guard and concurrent draft publication; full revisioned PUT persistence; employee edit denied; started snapshot preserved; new assigned learner receives edited test without keys');
core.state.cleanup?.();dom.window.close();process.exit(0);
