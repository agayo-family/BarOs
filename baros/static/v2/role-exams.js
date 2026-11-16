import {$,$$,api,btn,empty,esc,fmtDate,go,icon,notice,on,pageHead,state} from './core.js?v=2.14.0';
import {focusRules} from './exam-focus.js?v=2.14.0';

export async function roleExamsPage(root,position){
 const employee=state.me.account.role==='employee';
 if(!position){
  const items=await api('/role-exams');
  root.innerHTML=pageHead('Экзамены по должностям','Экзамен собирается из действующих курсов вашей точки.')+
  `<div class="grid-3">${items.filter(row=>row.available||employee).map(row=>`<article class="card">
   <div class="icon-box">${icon('target')}</div><h2>${esc(row.name)}</h2>
   <p>${row.courses.length} курсов · ${row.bank_size} заданий в банке</p>
   ${row.available?`<a class="btn soft" href="/app/role-exams/${esc(row.position)}">Открыть ${icon('arrow')}</a>`:'<p class="muted">Опубликуйте курсы для этой должности.</p>'}
  </article>`).join('')||empty('Экзамены появятся после публикации курсов','','target')}</div>`;
  return;
 }
 const data=await api('/role-exams/'+position);
 const latest=data.attempts[0];
 const label={in_progress:'В процессе',submitted:'Ждёт проверки',graded:'Проверен'};
 root.innerHTML=`<a class="btn text" href="/app/role-exams">${icon('back')}К экзаменам</a>`+pageHead('Экзамен · '+data.name,'')+
 `<section class="card">
 <div class="row between"><strong>${data.courses.length} курсов</strong><span>${data.bank_size} заданий в банке · порог 85%</span></div>
 <details class="section-space"><summary>Какие курсы входят</summary><ul>${data.courses.map(x=>`<li>${esc(x.title)}</li>`).join('')}</ul></details>
 ${employee&&data.available?`<div class="section-space">${focusRules()}<p>На экзамене есть задания по каждому курсу, а письменные ответы оценивает управляющий.</p>
 ${btn(latest?.status==='in_progress'?'Продолжить экзамен':'Начать экзамен','target','primary','data-role-exam-start')}</div>`:''}</section>
 <section class="card section-space"><h2>${employee?'Мои попытки':'Работы сотрудников'}</h2>
 ${data.attempts.map(row=>`<div class="line-item"><div class="grow"><strong>${esc(row.account_name||fmtDate(row.started_at,true))}</strong>
 <small>${label[row.status]||''}${row.result?' · '+row.result.percent+'%':''}</small></div>
 <a class="btn sm soft" href="/app/assessment-attempts/${encodeURIComponent(row.id)}">${(!employee&&row.status==='submitted')?'Проверить':'Открыть'}</a></div>`).join('')||'<p class="muted">Пока попыток нет.</p>'}</section>`;
 on('[data-role-exam-start]','click',async(_,button)=>{
  button.disabled=true;
  try{const result=await api('/role-exams/'+position+'/start','POST',{});go('/app/assessment-attempts/'+result.id)}
  finally{button.disabled=false}
 },root);
}
