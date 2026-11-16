import {esc,fmtDate} from './core.js?v=2.14.0';

export function bars(points,{label,max=100}){
 if(!points.length)return '<p class="muted">Пока нет результатов за этот период.</p>';
 return `<div class="insight-chart" role="img" aria-label="${esc(label)}">
 <div class="insight-axis" aria-hidden="true"><span>${esc(max)}</span><span>${esc(Math.round(max/2))}</span><span>0</span></div>
 <div class="insight-bars" aria-hidden="true">${points.map(row=>`<div title="${esc(row.text)}">
 <i style="--height:${Math.min(100,Math.max(1,row.value/max*100))}%"></i>
 </div>`).join('')}</div></div>
 <div class="row between tiny muted"><span>${esc(points[0].date)}</span><span>${esc(points.at(-1).date)}</span></div>
 <details class="insight-values"><summary>Значения графика</summary><ul>${points.map(row=>`<li>${esc(row.text)}</li>`).join('')}</ul></details>`;
}

export function scoreBars(rows){
 const points=rows.map(row=>({value:row.score,date:fmtDate(row.at),text:`${fmtDate(row.at,true)} · ${row.title} · ${row.score}%`}));
 return bars(points,{label:'Баллы за последние автотесты, от 0 до 100 процентов'});
}
