import {scoreBars} from './learning-insights.js?v=2.14.0';
import {courseCover,priorities} from './course-tools.js?v=2.14.0';
import {mountStopListWidget} from './stop-list.js?v=2.14.0';
import {focusRules,hasInterruption,protectAttempt,restartInterrupted} from './exam-focus.js?v=2.14.0';
import {mediaText,photoPicker} from './media.js?v=2.14.0';
import {smoothBehavior} from './motion.js?v=2.14.0';
import {rewardNotice,companionName} from './growth.js?v=2.14.0';
import {renderLesson} from './learning-ui.js?v=2.14.0';
import {$,$$,state,pageCleanup,api,go,esc,icon,btn,on,modal,toast,notice,empty,pageHead,badge,avatar,positionTags,fmtDate,fmtTime,percent,progress,stat,ring,hero} from './core.js?v=2.14.0';
function learnTile(course){
 const done=course.learning_complete,pending=course.written_status==='submitted';
 const label=done?'Завершён':pending?'На проверке':course.overdue?'Срок прошёл':course.progress?'В процессе':'К изучению';
 return `<article class="card course-card learner-tile">${courseCover(course.cover_url)}
 <div class="row between"><span class="icon-box ${done?'green':''}">${icon(done?'checkcircle':'book')}</span>
 ${badge(label,done?'green':course.overdue?'red':pending?'orange':'purple')}</div>
 <h3>${esc(course.title)}</h3><p>${esc(course.description||'')}</p>
 <div class="row between tiny muted"><span>Разделы ${course.read_count}/${course.lesson_count}</span><span>${course.progress}%</span></div>
 ${progress(course.progress,done?'green':'')}<div class="course-footer">
 <span>${course.due_at?'До '+fmtDate(course.due_at):''}</span>
 <a href="/app/learn/${course.id}">${done?'Повторить':course.progress?'Продолжить':'Открыть'} ${icon('arrow')}</a></div></article>`;
}

const courseTopics=[
 ['Меню и техкарты',/меню|барная карт|коктейл|рецептур|ингредиент|сырь[ея]|состав[аы]? |техкарт/iu],
 ['Смена и правила работы',/открыти|закрыти|смен|правила работы|чек.лист|регламент|порядок работ/iu],
 ['Сервис и продажи',/сервис|гост|продаж|подач|рекомендац|подачи|обслуживан/iu],
 ['Основы и развитие',/истори|основ|введение|дополнительно|классик/iu],
];
function defaultGroups(courses){
 const groups=new Map([...courseTopics.map(([label])=>[label,[]]),['Прочие курсы',[]]]);
 for(const course of courses){
  const label=courseTopics.find(([,pattern])=>pattern.test(course.title))?.[0]||'Прочие курсы';
  groups.get(label).push(course);
 }
 return [...groups].map(([label,items])=>[label,items,true]);
}

export async function learningPage(root,all=false){
 const [data,exams]=await Promise.all([api('/learning'),api('/role-exams').catch(()=>[])]),employee=state.me.account;
 const todo=data.courses.filter(c=>!c.learning_complete&&c.written_status!=='submitted');
 const next=todo.find(c=>c.overdue)||todo.find(c=>c.progress)||todo[0];
 const roleExam=exams.filter(exam=>exam.available);
 const actions=`<a class="btn" href="/app/history">${icon('chart')}Мои результаты</a>
 <a class="btn" href="/app/role-exams">${icon('target')}Экзамены</a>`;
 root.innerHTML=pageHead(all?'Обучение':`Привет, ${employee.name.split(' ')[0]}!`,'',actions);
 if(!all){
  root.insertAdjacentHTML('beforeend',`<section class="card stop-widget" data-stop-widget>${icon('list')} Стоп-лист</section>
    <section class="card learning-next section-space">
    <div><h2>${next?esc(next.title):data.learning_total?'Все текущие курсы просмотрены':'Назначенных курсов пока нет'}</h2>
    ${next?'<p>Следующий курс · '+(next.progress?next.progress+'% пройдено':'можно начать сейчас')+'</p>':''}</div>
    ${next?`<a class="btn primary" href="/app/learn/${next.id}">${next.progress?'Продолжить':'Начать'} ${icon('arrow')}</a>`:''}</section>
    <div class="section-title"><h2>Моё обучение</h2><a href="/app/learning" class="btn text">Все курсы ${icon('arrow')}</a></div>
    <div class="grid-3">${todo.slice(0,3).map(learnTile).join('')}</div>`);
  mountStopListWidget(root);
  return;
 }
 root.insertAdjacentHTML('beforeend',`<div class="card learning-index">
  <div><strong>${data.learning_completed} из ${data.learning_total}</strong><p>назначений завершено</p></div>
  ${progress(data.learning_percent)}
  ${data.overdue?badge('Просрочено: '+data.overdue,'orange'):''}
  <label class="field"><span class="sr-only">Поиск курса</span><input type="search" data-learning-search placeholder="Найти курс"></label>
 </div>${roleExam.length?`<div class="role-exam-links">${roleExam.map(exam=>`<a href="/app/role-exams/${exam.position}" class="btn soft">${icon('target')} Экзамен · ${esc(exam.name)}</a>`).join('')}</div>`:''}
 <div data-learning-groups></div>`);
 const area=$('[data-learning-groups]',root);
 function groups(query=''){
  const filtered=data.courses.filter(c=>(c.title+' '+c.description).toLocaleLowerCase('ru').includes(query));
  const unfinished=filtered.filter(c=>!c.learning_complete);
  const priorityCourses=unfinished.filter(c=>c.priority);
  const remaining=unfinished.filter(c=>!c.priority);
  const sections=[
   ...Object.entries(priorities).map(([priority,label])=>[label+' важность',priorityCourses.filter(c=>c.priority===priority),true]),
   ['Продолжить',remaining.filter(c=>c.progress>0),true],
   ...defaultGroups(remaining.filter(c=>!c.progress)),
   ['Завершённые',filtered.filter(c=>c.learning_complete),Boolean(query)]
  ];
  area.innerHTML=sections.filter(([,list])=>list.length).map(([title,list,open])=>`<details class="learn-group" ${open?'open':''}>
  <summary><strong>${title}</strong><span>${list.length}</span></summary><div class="grid-3">${list.map(learnTile).join('')}</div></details>`).join('')||
    `<div class="card">${empty(query?'Ничего не найдено':'Пока нет назначенных курсов','','book')}</div>`;
 }
 groups();$('[data-learning-search]',root).addEventListener('input',e=>groups(e.target.value.trim().toLocaleLowerCase('ru')));
}

export async function lessonPage(root,cid){
 const ticket=state.renderTicket,data=await api('/learning/'+cid);
 let current=Math.max(0,data.lessons.findIndex(l=>!l.completed)),opened=Date.now(),recorded=0,ready=false,disposed=false;
 let final=data.lessons.every(l=>l.completed);
 async function begin(){
  if(final)return;
  const index=current;ready=false;opened=Date.now();recorded=data.lessons[index]?.seconds||0;tick();
  try{
   const r=await api(`/learning/${cid}/lessons/${index}`,'POST',{complete:false});
   if(disposed||current!==index||final)return;
   recorded=r.seconds;opened=Date.now();ready=true;tick();
  }catch(e){toast(e.message,true)}
 }
 function tick(){
  const button=$('[data-complete-lesson]',root),hint=$('[data-read-hint]',root);
  if(!button)return;
  const lesson=data.lessons[current],remaining=Math.max(0,data.min_read_seconds-recorded-
   (document.visibilityState==='visible'?Math.floor((Date.now()-opened)/1000):0));
  button.disabled=!lesson.completed&&(!ready||remaining>0);
  hint.textContent=lesson.completed?'Раздел изучен':!ready?'Сохраняем начало чтения…':remaining>0?`Подтверждение через ${remaining} с`:'Можно отметить раздел изученным';
 }
 function finalBlock(){
  return `<section class="card lesson-reader" id="exam-info"><h2>Итоговая проверка</h2>
   ${data.quiz_size?`<p>${data.quiz_size} вопросов из ${data.bank_size} · ${data.time_limit_minutes} мин · порог ${data.passing_score}%</p>
    ${data.max_attempts?`<p>Осталось попыток: ${Math.max(0,data.max_attempts-data.attempt_count)} из ${data.max_attempts}</p>`:''}
    ${focusRules()}
    ${btn(data.exam_id?'Продолжить тест':'Начать тест','target','primary','data-start-exam')}`:''}
   ${writtenPractice(data.program?.written_assessment_id,data.written_status)}</section>`;
 }
 function draw(){
  const lesson=data.lessons[current],done=data.lessons.filter(l=>l.completed).length;
  const canTest=done===data.lessons.length;
  root.innerHTML=`<a class="btn text" href="/app/learning">${icon('back')}К обучению</a>`+
   pageHead(data.title,data.description||'')+courseCover(data.cover_url,'course-cover-heading')+
   `<div class="learning-path"><span class="active">${icon('book')}Изучено ${done}/${data.lessons.length}</span>
   ${(data.bank_size||data.program?.flashcards?.length)?`<a href="/app/cards/${cid}">${icon('cards')}Карточки</a>`:''}
   ${data.bank_size?`<a href="/app/games/${cid}">${icon('games')}Игры по курсу</a>`:''}</div>
   <div class="learner-layout"><aside class="card editor-outline">
    <h2 class="lesson-contents">Содержание</h2>
    ${data.lessons.map((l,i)=>`<button class="outline-item ${i===current&&!final?'active':''}" data-read-lesson="${i}" aria-current="${i===current&&!final?'step':'false'}"><span class="num">${l.completed?icon('check'):i+1}</span><span>${esc(l.title)}</span></button>`).join('')}
    ${canTest?`<button class="outline-item ${final?'active':''}" data-show-exam-info>${icon('target')} Итоговая проверка</button>`:''}
   </aside><div class="stack">${final?finalBlock():`<section class="card lesson-reader">
    <h2>${esc(lesson?.title||'Теория')}</h2>${renderLesson(lesson?.body||'')}
    <div class="mentor-feedback-link"><a class="btn soft" href="/app/mentor?course_id=${cid}&lesson_index=${current}">${icon('heart')}Попросить объяснение · ${esc(companionName())}</a></div>
    <div class="reader-footer"><small class="muted" data-read-hint></small>
    ${btn(lesson?.completed?(canTest&&current===data.lessons.length-1?'К итоговой проверке':'Следующий раздел'):'Изучил(а), продолжить','check','primary','data-complete-lesson')}</div>
   </section>`}</div></div>`;
  on('[data-read-lesson]','click',async(_,b)=>{final=false;current=Number(b.dataset.readLesson);draw();await begin()},root);
  on('[data-show-exam-info]','click',()=>{final=true;draw();$('#exam-info',root)?.scrollIntoView({block:'start'})},root);
  on('[data-complete-lesson]','click',async(_,b)=>{
   b.disabled=true;
   const index=current;
   try{
    if(!data.lessons[index].completed){
     const result=await api(`/learning/${cid}/lessons/${index}`,'POST',{complete:true});
     rewardNotice(result.reward);data.lessons[index].completed=result.completed;data.lessons[index].seconds=result.seconds;
    }
    if(disposed||index!==current)return;
    if(current+1<data.lessons.length)current++;
    else{const next=data.lessons.findIndex(l=>!l.completed);if(next<0)final=true;else current=next}
    draw();await begin();
    $('.lesson-reader',root)?.scrollIntoView({behavior:smoothBehavior(),block:'start'});
   }finally{tick()}
  },root);
  on('[data-start-exam]','click',async(_,b)=>{
   b.disabled=true;
   try{
    const exam=await api('/learning/'+cid+'/exam','POST',{});
    go('/app/exam/'+exam.id);
   }finally{b.disabled=false}
  },root);
  tick();
 }
 draw();await begin();
 const timer=setInterval(tick,1000),heartbeat=setInterval(async()=>{
  if(document.visibilityState!=='visible'||disposed||!ready||final)return;
  const index=current;
  try{
   const r=await api(`/learning/${cid}/lessons/${index}`,'POST',{complete:false});
   if(index!==current||disposed||final)return;
   recorded=r.seconds;opened=Date.now();tick();
  }catch{}
 },15000);
 const visibility=()=>{if(document.visibilityState==='visible')begin();else{opened=Date.now();ready=false;tick()}};
 document.addEventListener('visibilitychange',visibility);
 pageCleanup(()=>{disposed=true;clearInterval(timer);clearInterval(heartbeat);document.removeEventListener('visibilitychange',visibility)},ticket);
}

export async function examPage(root,eid){const ticket=state.renderTicket;const focusPath='/exams/'+eid;let exam=await api(focusPath);
 if(ticket!==state.renderTicket)return;
 const restart=result=>api('/learning/'+(result.course_id||exam.course_id)+'/exam','POST',{});
 const target=id=>'/app/exam/'+id;
 if(exam.interrupted||hasInterruption(focusPath))return restartInterrupted(root,focusPath,restart,target);
 if(exam.finished)return resultPage(root,exam.result,exam.title);
 let guard;let current=0;let answers={...exam.answers};let pending=Promise.resolve();let saving=false;let timer;let submitting=false,disposed=false,edited=0,saved=0,saveError=false;const offset=new Date(exam.server_time).getTime()-Date.now();
 const active=()=>!disposed&&ticket===state.renderTicket;
 function sync(){if(!active())return;state.dirty=edited>saved;const label=$('#answer-state',root);if(label)label.textContent=submitting?'Сдаём тест…':saving?'Сохраняем…':saveError?'Не сохранено · повторите сохранение':edited?'Ответ сохранён':'Ответы сохранены';const retry=$('[data-retry-answer]',root);if(retry)retry.hidden=!saveError||saving||submitting;$$('[name=answer],[data-q-step],[data-question-index],[data-finish-exam]',root).forEach(b=>{b.disabled=submitting||(b.dataset.qStep==='-1'&&current===0)});}
 function showResult(result){exam.finished=true;guard?.release();clearInterval(timer);if(!active())return;state.dirty=false;resultPage(root,result,exam.title);}
 function queueSave(){const version=edited,snapshot={...answers};saving=true;saveError=false;sync();pending=pending.catch(()=>{}).then(()=>api('/exams/'+eid,'PUT',{answers:snapshot})).then(r=>{saved=Math.max(saved,version);saving=saved<edited;if(r.finished)showResult(r.result);else sync()}).catch(err=>{saving=false;saveError=true;sync();if(active())toast(err.message,true)});return pending;}
 function draw(){const q=exam.questions[current];root.innerHTML=`<div class="exam-wrap">${pageHead('Проверка знаний',exam.title,'','ВАША ПОПЫТКА')}<div class="exam-top"><span class="muted tiny">Вопрос ${current+1} из ${exam.questions.length}</span><div class="timer" id="exam-timer">${icon('clock')} <span>—</span></div></div>${progress(Object.keys(answers).length/exam.questions.length*100)}<section class="card exam-question section-space"><div class="row between">${badge(state.me.question_types?.[q.type]||{knowledge:'Знание',understanding:'Понимание',sales:'Рекомендация',scenario:'Ситуация'}[q.type]||'Проверка','purple')}<span class="muted tiny" id="answer-state">${saving?'Сохраняем…':'Ответы сохранены'}</span></div><h2>${mediaText(q.prompt)}</h2><fieldset style="border:0;margin:0;padding:0"><legend class="sr-only">Выберите один ответ</legend>${q.choices.map((answer,i)=>`<label class="answer-option"><input type="radio" name="answer" value="${i}" ${answers[String(current)]===i?'checked':''}><span class="letter">${'АБВГ'[i]}</span><span>${esc(answer)}</span></label>`).join('')}</fieldset><div class="row between section-space">${btn('Назад','back','',`data-q-step="-1" ${current===0?'disabled':''}`)}${current===exam.questions.length-1?btn('Завершить тест','check','primary','data-finish-exam'):btn('Следующий','arrow','primary','data-q-step="1"')}</div></section><div class="question-nav" aria-label="Вопросы теста">${exam.questions.map((_,i)=>`<button class="${i===current?'current':''} ${String(i) in answers?'answered':''}" data-question-index="${i}" aria-label="Вопрос ${i+1}">${i+1}</button>`).join('')}</div><p class="footnote">Ответы сохраняются после каждого выбора. До сдачи можно вернуться к любому вопросу.</p></div>`;
 const status=$('#answer-state',root);status?.setAttribute('role','status');status?.setAttribute('aria-live','polite');status?.insertAdjacentHTML('afterend',btn('Повторить сохранение','refresh','sm','hidden data-retry-answer'));
 on('[name=answer]','change',e=>{if(submitting||exam.finished||disposed)return;const index=current;answers[String(index)]=Number(e.target.value);edited++;$$('[data-question-index]',root).find(b=>Number(b.dataset.questionIndex)===index)?.classList.add('answered');queueSave()},root);on('[data-retry-answer]','click',()=>queueSave(),root);
 on('[data-q-step]','click',(e,b)=>{current+=Number(b.dataset.qStep);draw();tick()},root);on('[data-question-index]','click',(e,b)=>{current=Number(b.dataset.questionIndex);draw();tick()},root);on('[data-finish-exam]','click',()=>finishExam(false),root);sync();
 }
 async function finishExam(expired){if(submitting||exam.finished||disposed)return;if(!expired&&Object.keys(answers).length<exam.questions.length&&!(guard?.confirm||confirm)(`Осталось без ответа: ${exam.questions.length-Object.keys(answers).length}. Завершить тест?`))return;submitting=true;sync();const snapshot={...answers};try{await pending;if(exam.finished||disposed)return;const r=await api('/exams/'+eid+'/finish','POST',{answers:snapshot});saved=edited;if(active()){rewardNotice(r.reward);rewardNotice(r.pass_reward);window.dispatchEvent(new CustomEvent('baros:pet-react',{detail:{kind:r.passed?'success':'mistake'}}))}showResult(r)}catch(e){if(active())toast(e.message,true);submitting=false;sync()}}
 function tick(){const seconds=Math.max(0,Math.ceil((new Date(exam.expires_at).getTime()-Date.now()-offset)/1000));const el=$('#exam-timer span',root);if(el)el.textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');if(seconds===0&&!exam.finished)finishExam(true)}
 draw();sync();tick();timer=setInterval(tick,1000);
 guard=protectAttempt(root,{path:focusPath,restart,target,onInterrupt(){disposed=true;clearInterval(timer)}});
 pageCleanup(()=>{disposed=true;guard.release();clearInterval(timer)},ticket);
}
function resultPage(root,r,title){root.innerHTML=writtenPractice(r.written_assessment_id)+`<div class="exam-wrap"><section class="card result-hero">${ring(r.score,r.passed?'сдано':'результат')}<div class="eyebrow">${esc(title)}</div><h1>${r.passed?'Тест сдан':'Есть что повторить'}</h1><p class="lead">${r.passed?'Вы достигли проходного балла. Результат уже доступен управляющему.':'Посмотрите разбор ответов и вернитесь к материалу перед новой попыткой.'}</p><div class="row" style="justify-content:center">${badge(`${r.correct??'—'} из ${r.total??'—'} верно`,'purple')}${badge(fmtTime(r.duration_seconds),'purple')}${r.expired?badge('Время вышло','orange'):''}</div><div class="row section-space" style="justify-content:center"><a class="btn primary" href="/app/learning">К обучению ${icon('arrow')}</a><a class="btn" href="/app/history">Мои результаты</a></div></section><div class="section-title"><h2>Разбор ответов</h2><span class="muted tiny">${r.review?.length||0} вопросов</span></div><section class="card no-pad">${(r.review||[]).map((q,i)=>`<div class="result-review"><div class="row start"><div class="icon-box ${q.correct?'green':'orange'}">${icon(q.correct?'check':'info')}</div><div class="grow"><p><strong>${i+1}. ${mediaText(q.prompt)}</strong></p><p class="muted">Ваш ответ: ${q.selected==null?'Не выбран':esc(q.choices[q.selected])}</p>${!q.correct?`<p class="positive">Правильный: ${esc(q.choices[q.correct_index])}</p>`:''}<div class="explanation">${mediaText(q.explanation)}</div>${r.exam_id&&r.course_id?`<div class="mentor-feedback-link"><a class="btn soft sm" href="/app/mentor?course_id=${r.course_id}&exam_id=${encodeURIComponent(r.exam_id)}&review_index=${i}">${icon('heart')}Обсудить ответ · ${esc(companionName())}</a></div>`:''}</div></div></div>`).join('')}</section></div>`}
export async function historyPage(root){
 const [stats,journey]=await Promise.all([api('/learning'),api('/learning/journey')]);
 const roleLabels={in_progress:'В процессе',submitted:'На проверке',graded:'Проверен'};
 const next=stats.courses.find(c=>!c.learning_complete&&c.overdue)||
  stats.courses.find(c=>!c.learning_complete&&c.written_status!=='submitted');
 root.innerHTML=pageHead('Мои результаты','',`<a class="btn" href="/app/learning">${icon('book')}К обучению</a>`)+
  `<section class="card insight-path"><div><h2>Мой путь</h2><strong>${stats.learning_completed} из ${stats.learning_total} назначений завершено</strong>
   ${progress(stats.learning_percent)}${stats.overdue?badge('Просрочено: '+stats.overdue,'orange'):''}</div>
   ${next?`<div><small>Следующий шаг</small><h3>${esc(next.title)}</h3><a class="btn soft" href="/app/learn/${next.id}">Открыть курс ${icon('arrow')}</a></div>`:''}</section>
   <div class="insight-grid section-space">
    <section class="card"><h2>Баллы за последние тесты</h2>${scoreBars(journey.scores)}</section>
    <section class="card"><h2>Что стоит повторить</h2>${journey.mistakes.length?journey.mistakes.map(q=>
     `<div class="line-item insight-item"><div class="grow"><strong>${esc(q.prompt)}</strong>
      <a href="/app/learn/${q.course_id}">${esc(q.title)}</a></div>${badge(`${q.mistakes} из ${q.seen} с ошибкой`,'orange')}</div>`).join(''):
     '<p class="muted">В последних проверках действующих курсов ошибок пока нет.</p>'}</section>
   </div>
   <section class="card section-space"><div class="row between"><h2>Экзамены по должностям</h2><a href="/app/role-exams" class="btn sm soft">К экзаменам</a></div>
   ${journey.role_results.map(row=>`<div class="line-item"><div class="grow"><strong>${esc(row.title)}</strong>
   <small>${fmtDate(row.at,true)} · ${roleLabels[row.status]||''}</small></div>
   ${row.score!=null?badge(row.score+'%',row.passed?'green':'orange'):''}<a class="btn sm" href="/app/assessment-attempts/${row.id}">Открыть</a></div>`).join('')||
    '<p class="muted">Пока нет попыток.</p>'}</section>
   <details class="card section-space"><summary>История тестов</summary>
   ${journey.history.map(row=>`<div class="line-item"><div class="grow"><strong>${esc(row.title)}</strong>
   <small>${fmtDate(row.at,true)}</small></div>${row.score==null?badge('Начат','orange'):badge(row.score+'%',row.passed?'green':'orange')}
   ${row.active?`<a class="btn sm" href="/app/exam/${row.id}">${row.score==null?'Продолжить':'Посмотреть'}</a>`:''}</div>`).join('')||
    '<p class="muted">Пока нет тестов.</p>'}</details>`;
}

function writtenPractice(id,status){if(!Number.isInteger(id)||id<1)return '';return `<section class="card section-space written-practice"><div class="row between"><div><h2>Письменные ситуации</h2><p>Опишите решение своими словами. Проверяет управляющий по критериям; разные обоснованные ответы допустимы. Для завершения курса нужны все назначенные проверки. ${status==='submitted'?'Ваша работа уже отправлена и ждёт проверки.':''}</p></div><a class="btn soft" href="/app/assessments/${id}">${icon('edit')}К письменным заданиям</a></div></section>`}
