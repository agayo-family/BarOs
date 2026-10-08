import {esc,icon} from './core.js?v=2.1.1';

// Only escaped text and a small Markdown subset. Uploaded HTML is never executed.
const inline=text=>esc(text).replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
export function lessonBlocks(body){
 const lines=String(body||'').replace(/\r\n?/g,'\n').split('\n');
 const blocks=[];let title='',parts=[];
 const flush=()=>{if(parts.length){blocks.push({title,parts});parts=[]}title=''};
 let paragraph=[];
 const paragraphEnd=()=>{if(!paragraph.length)return;const text=paragraph.join(' ');paragraph=[];
  // Old plain-text lessons get readable paragraphs too; preserve every sentence.
  const sentences=text.split(/(?<=[.!?])\s+(?=[А-ЯA-Z0-9])/u);let chunk='';
  for(const sentence of sentences){if(chunk.length+sentence.length>650&&chunk){parts.push({type:'text',text:chunk.trim()});chunk=''}chunk+=(chunk?' ':'')+sentence}
  if(chunk.trim())parts.push({type:'text',text:chunk.trim()});
 };
 for(const raw of lines){const line=raw.trim();
  if(/^#{1,3}\s+/.test(line)){paragraphEnd();flush();title=line.replace(/^#{1,3}\s+/,'');continue}
  if(!line){paragraphEnd();continue}
  const bullet=line.match(/^[-*•]\s+(.+)$/),step=line.match(/^(\d+)[.)]\s+(.+)$/);
  if(bullet||step){paragraphEnd();parts.push({type:bullet?'bullet':'step',text:bullet?bullet[1]:step[2],number:step?Number(step[1]):null});continue}
  if(/^(>|Важно:|Факт из материала:)/i.test(line)){paragraphEnd();parts.push({type:'fact',text:line.replace(/^>\s*/,'')});continue}
  paragraph.push(line);
 }
 paragraphEnd();flush();
 // Bound each visual block, including existing lessons without headings.
 return blocks.flatMap(b=>{const chunks=[];for(let i=0;i<b.parts.length;i+=5)chunks.push({title:i?b.title?b.title+' · продолжение':'':b.title,parts:b.parts.slice(i,i+5)});return chunks});
}
export function renderLesson(body){
 const blocks=lessonBlocks(body),minutes=Math.max(1,Math.ceil(String(body||'').split(/\s+/).length/180));
 return `<div class="reading-meta">${icon('clock')} Около ${minutes} мин <span>·</span> ${blocks.length} смысловых блоков</div><div class="learning-blocks">${blocks.map((b,i)=>`<section class="learning-block"><div class="learning-block-head"><span class="learning-number">${String(i+1).padStart(2,'0')}</span><h3>${esc(b.title||'Разбираем материал')}</h3></div>${renderParts(b.parts)}</section>`).join('')}</div>`;
}
function renderParts(parts){let html='',list=null;
 const close=()=>{if(list){html+=`</${list}>`;list=null}};
 for(const p of parts){if(p.type==='bullet'||p.type==='step'){const tag=p.type==='step'?'ol':'ul';if(list!==tag){close();html+=`<${tag} class="learning-list">`;list=tag}html+=`<li${p.number!=null?` value="${p.number}"`:''}>${inline(p.text)}</li>`}else{close();html+=p.type==='fact'?`<div class="learning-fact">${icon('spark')}<p>${inline(p.text)}</p></div>`:`<p>${inline(p.text)}</p>`}}
 close();return html;
}
