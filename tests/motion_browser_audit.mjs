import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

// Real animation frames, not only still screenshots or an emulated reduced mode.
export async function auditMotion({page,base,call,output}){
 assert.match(base,/^http:\/\/127\.0\.0\.1:/,'Motion fixtures must stay disposable');
 const original=await call('/owner/showcase'),results=[];
 const saved=original.items.map(({organization_id,name,city,description,logo_id})=>({organization_id,name,city,description,logo_id}));
 const pair=saved.slice(0,2).map(x=>({...x}));
 pair[1].name='Тестовое заведение с длинным названием для проверки плавного перехода';
 await call('/owner/showcase','PUT',{version:original.version,items:pair,permission_confirmed:true});
 try{
  await page.emulateMedia({reducedMotion:'no-preference'});
  for(const width of [360,390,768,1440]){
   await page.setViewportSize({width,height:900});
   await page.goto(base+'/about?employees=50&mode=managed');await page.locator('#team-size').waitFor();
   await page.locator('.site-mode-switch').scrollIntoViewIfNeeded();
   const capture=async(action,duration=850)=>page.evaluate(async({action,duration})=>{
    const price=document.querySelector('#price-result'),card=document.querySelector('.site-price-card'),gallery=document.querySelector('#plan-carousel');
    const snap=()=>({t:performance.now(),height:price.getBoundingClientRect().height,card:card.getBoundingClientRect().height,scroll:gallery.scrollLeft,y:scrollY});
    const frames=[snap()];document.querySelector(action).click();const start=performance.now();
    await new Promise(resolve=>{function tick(){frames.push(snap());if(performance.now()-start>=duration)resolve();else requestAnimationFrame(tick)}requestAnimationFrame(tick)});
    return frames;
   },{action,duration});
   for(const mode of ['self','managed']){
    const frames=await capture(`[data-mode="${mode}"]`),first=frames[0],last=frames.at(-1),direction=Math.sign(last.height-first.height);
    assert(frames.length>8,'Capture intermediate animation frames');
    for(let i=1;i<frames.length;i++){
     assert(direction*(frames[i].height-frames[i-1].height)>=-.8,`Price height does not reverse at ${width}/${mode}: ${JSON.stringify(frames.slice(Math.max(0,i-2),i+1))}`);
    }
    const tail=frames.filter(x=>x.t>last.t-180);
    assert(Math.max(...tail.map(x=>x.height))-Math.min(...tail.map(x=>x.height))<.6,'Price stays at its final height when the effect is removed');
    assert(Math.max(...frames.map(x=>x.y))-Math.min(...frames.map(x=>x.y))<1.1,'Mode change never nudges the page scroll position');
    results.push({width,kind:'price-'+mode,frames});
   }
   // Repeated changes retain the actual button nodes and final natural height.
   const rapid=await page.evaluate(async()=>{
    const old=document.querySelector('[data-plan="50"]');
    for(const mode of ['self','managed','self','managed']){document.querySelector(`[data-mode="${mode}"]`).click();await new Promise(requestAnimationFrame)}
    await new Promise(resolve=>setTimeout(resolve,550));
    return {same:old===document.querySelector('[data-plan="50"]'),running:document.querySelector('#price-result').getAnimations().length};
   });assert(rapid.same,'Updating prices does not replace the carousel/focus/scroll nodes');assert.equal(rapid.running,0);
   await page.locator('#plan-carousel').scrollIntoViewIfNeeded();
   const gallery=await capture('[data-plan-step="1"]',1000);
   for(let i=1;i<gallery.length;i++)assert(gallery[i].scroll>=gallery[i-1].scroll-.8,'Smooth scrolling and CSS snapping never fight each other');
   results.push({width,kind:'plans',frames:gallery});
   await page.locator('.venue-orbit-stage').scrollIntoViewIfNeeded();
   const frames=await page.evaluate(async()=>{
    const root=document.querySelector('.venue-orbit'),card=root.querySelector('[data-orbit-index="1"]'),caption=root.querySelector('.venue-orbit-caption'),labels=[...root.querySelectorAll('[data-orbit-caption]')];
    const snap=()=>({t:performance.now(),x:card.getBoundingClientRect().x,visible:getComputedStyle(card).visibility==='visible',opacity:Number(getComputedStyle(card).opacity),caption:caption.getBoundingClientRect().height,labels:labels.map(x=>Number(getComputedStyle(x).opacity))});
    const frames=[snap()];root.querySelector('[data-orbit-step="1"]').click();const start=performance.now();
    await new Promise(resolve=>{function tick(){frames.push(snap());if(performance.now()-start>=1200)resolve();else requestAnimationFrame(tick)}requestAnimationFrame(tick)});
    return frames;
   });
   const incoming=frames.filter(x=>x.visible&&x.opacity>.05);
   for(let i=1;i<incoming.length;i++)assert(incoming[i].x<=incoming[i-1].x+.8,'Incoming logo moves continuously toward the centre without a backwards kick');
   assert(frames.some(x=>x.labels[0]>0&&x.labels[0]<.9),'Previous caption fades out');assert(frames.some(x=>x.labels[1]>.1&&x.labels[1]<1),'New caption fades in');
   assert(Math.max(...frames.map(x=>x.caption))-Math.min(...frames.map(x=>x.caption))<.6,'Long venue names do not resize the caption during rotation');
   assert.equal(await page.locator('.venue-orbit').getAttribute('data-active-index'),'1');
   assert.equal(await page.locator('.venue-orbit-card strong,[data-orbit-counter]').count(),0,'No duplicate label or fraction counter');
   assert.equal(await page.locator('[data-orbit-caption][aria-hidden=false]').count(),1,'One visible caption at rest');
   const decoration=await page.locator('.venue-orbit-card').first().evaluate(el=>{const s=getComputedStyle(el);return {background:s.backgroundColor,border:s.borderTopWidth,shadow:s.boxShadow}});
   assert.equal(decoration.background,'rgba(0, 0, 0, 0)');assert.equal(decoration.border,'0px');assert.equal(decoration.shadow,'none');
   assert(await page.locator('.site-role-strip').innerText().then(s=>s.includes('Кальянные мастера')&&!s.includes('Кальянщики')));
   results.push({width,kind:'two-venue-orbit',frames});
   if([390,1440].includes(width))await page.screenshot({path:join(output,`public-motion-orbit-${width}.png`)});
  }
  await page.locator('[data-orbit-step="1"]').click();await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>document.querySelector('.venue-orbit')?.dataset.activeIndex==='0');
  await page.waitForFunction(()=>document.getAnimations().every(a=>a.playState!=='running'));
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.locator('.site-mode-switch').scrollIntoViewIfNeeded();await page.locator('[data-mode=self]').click();
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.getAnimations().every(a=>a.playState!=='running'));
  // Check other public motion in its ordinary mode, including final cleanup.
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.locator('[data-sales-contact]').first().click();await page.getByRole('dialog').waitFor();
  const modal=await page.evaluate(async()=>{
   const node=document.querySelector('.sales-modal'),frames=[],start=performance.now();
   await new Promise(resolve=>{function tick(){const r=node.getBoundingClientRect();frames.push({t:performance.now(),y:r.y,width:r.width});if(performance.now()-start>=650)resolve();else requestAnimationFrame(tick)}requestAnimationFrame(tick)});
   return frames;
  });
  const tail=modal.filter(x=>x.t>modal.at(-1).t-150);
  assert(Math.max(...tail.map(x=>x.y))-Math.min(...tail.map(x=>x.y))<.6,'Contact modal does not jump when its arrival animation finishes');
  results.push({kind:'contact-modal',frames:modal});await page.keyboard.press('Escape');
  await page.locator('.site-faq summary').first().click();
  await page.waitForFunction(()=>document.getAnimations().every(a=>a.playState!=='running'));
  assert(await page.locator('.site-faq details').first().evaluate(el=>el.open));
  const initialTheme=await page.locator('html').getAttribute('data-theme');
  await page.locator('[data-theme-toggle]').first().click();
  await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme&&!document.querySelector('.theme-rain')&&document.getAnimations().every(a=>a.playState!=='running'),initialTheme==='dark'?'light':'dark');
  await page.locator('[data-theme-toggle]').first().click();
  await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme&&!document.querySelector('.theme-rain')&&document.getAnimations().every(a=>a.playState!=='running'),initialTheme);
  await page.locator('[data-theme-toggle]').first().click();await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>!document.querySelector('.theme-rain')&&document.getAnimations().every(a=>a.playState!=='running'));
  writeFileSync(join(output,'motion.json'),JSON.stringify(results,null,2));
  console.log('MOTION PASS: actual frames at 360/390/768/1440, monotone price height, stable end geometry/page scroll, rapid toggles, retained plan nodes, no scroll-snap rebound, two-venue logo/caption fades, transparent logos, no duplicate name/counter, contact modal, FAQ, theme transition and live reduced-motion cancellation');
 }finally{
  await page.emulateMedia({reducedMotion:'reduce'});
  const current=await call('/owner/showcase');await call('/owner/showcase','PUT',{version:current.version,items:saved,permission_confirmed:true});
 }
}
