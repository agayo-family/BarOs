import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

// Lab measurements and exploratory responsive checks use disposable CI data.
export async function auditPages({browser,base,output,venueId,managerStorage}){
 assert.match(base,/^http:\/\/127\.0\.0\.1:/);
 const authentication=await browser.newContext();
 async function accountStorage(login){
  const response=await authentication.request.post(base+'/api/auth/login',{data:{login,password:'browser-audit-password'}});
  assert(response.ok(),'Disposable audit account login');
  return authentication.storageState();
 }
 const employeeStorage=await accountStorage('browser.worker0');
 await authentication.close();
 const pages=[
  {name:'public-about',path:'/about'},
  {name:'public-login',path:'/login'},
  {name:'employee-home',path:'/app',storage:employeeStorage},
  {name:'employee-learning',path:'/app/learning',storage:employeeStorage},
  {name:'manager-overview',path:'/app?venue='+venueId,storage:managerStorage},
  {name:'manager-reports',path:'/app/reports?venue='+venueId,storage:managerStorage},
 ];
 const profiles=[
  {name:'desktop',viewport:{width:1440,height:1000},isMobile:false,cpu:1,latency:20,download:1250000,upload:625000},
  {name:'mobile',viewport:{width:390,height:844},isMobile:true,cpu:4,latency:150,download:200000,upload:93750},
 ];
 const results=[];
 for(const profile of profiles)for(const target of pages)for(let sample=1;sample<=3;sample++){
  const context=await browser.newContext({locale:'ru-RU',timezoneId:'Europe/Moscow',viewport:profile.viewport,
   isMobile:profile.isMobile,hasTouch:profile.isMobile,deviceScaleFactor:profile.isMobile?2:1,
   reducedMotion:'no-preference',serviceWorkers:'block',storageState:target.storage});
  await context.addInitScript(()=>{
   window.__auditMetrics={lcp:null,cls:0,longTasks:0,blockingMs:0};
   let windowStart=0,lastShift=0,windowScore=0;
   for(const type of ['largest-contentful-paint','layout-shift','longtask']){
    try{
     new PerformanceObserver(list=>{
      for(const entry of list.getEntries()){
       if(type==='largest-contentful-paint')window.__auditMetrics.lcp=entry.startTime;
       if(type==='longtask'){window.__auditMetrics.longTasks++;window.__auditMetrics.blockingMs+=Math.max(0,entry.duration-50);}
       if(type==='layout-shift'&&!entry.hadRecentInput){
        if(entry.startTime-lastShift>1000||entry.startTime-windowStart>5000){windowStart=entry.startTime;windowScore=0;}
        lastShift=entry.startTime;windowScore+=entry.value;
        window.__auditMetrics.cls=Math.max(window.__auditMetrics.cls,windowScore);
       }
      }
     }).observe({type,buffered:true});
    }catch{}
   }
  });
  const page=await context.newPage();
  const protocol=await context.newCDPSession(page);
  await protocol.send('Network.enable');
  await protocol.send('Network.setCacheDisabled',{cacheDisabled:true});
  await protocol.send('Network.emulateNetworkConditions',{offline:false,latency:profile.latency,
   downloadThroughput:profile.download,uploadThroughput:profile.upload,connectionType:profile.isMobile?'cellular3g':'ethernet'});
  await protocol.send('Emulation.setCPUThrottlingRate',{rate:profile.cpu});
  const started=Date.now();
  const response=await page.goto(base+target.path,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(()=>document.querySelector('#app')?.getAttribute('aria-busy')==='false',{},{timeout:60000});
  const readyMs=Date.now()-started;
  await page.waitForTimeout(2000);
  const metrics=await page.evaluate(()=>{
   const nav=performance.getEntriesByType('navigation')[0];
   const resources=performance.getEntriesByType('resource');
   const paints=performance.getEntriesByType('paint');
   return {...window.__auditMetrics,ttfb:nav.responseStart-nav.requestStart,
    fcp:paints.find(entry=>entry.name==='first-contentful-paint')?.startTime??null,
    domInteractive:nav.domInteractive,requests:resources.length+1,
    transferBytes:nav.transferSize+resources.reduce((sum,entry)=>sum+entry.transferSize,0),
    decodedBytes:nav.decodedBodySize+resources.reduce((sum,entry)=>sum+entry.decodedBodySize,0),
    title:document.querySelector('h1')?.textContent??'',width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
    error:document.querySelector('#page-content .notice-box.error')?.textContent??null};
  });
  results.push({profile:profile.name,page:target.name,path:target.path,sample,status:response.status(),readyMs,...metrics});
  console.log('PAGE PERFORMANCE',JSON.stringify(results.at(-1)));
  await context.close();
 }
 writeFileSync(join(output,'performance.json'),JSON.stringify({profiles,samples:3,observationAfterReadyMs:2000,
  cache:'disabled',serviceWorkers:'blocked',backend:'disposable CI SQLite',results},null,2));
 const extra=[];
 for(const target of [pages[0],pages[3],pages[5]]){
  const context=await browser.newContext({locale:'ru-RU',timezoneId:'Europe/Moscow',reducedMotion:'reduce',storageState:target.storage});
  const page=await context.newPage();
  for(const scenario of [{name:'landscape',width:640,height:360,zoom:1},{name:'zoom-200',width:1440,height:1000,zoom:2}]){
   await page.setViewportSize({width:scenario.width,height:scenario.height});
   await page.goto(base+target.path);await page.waitForFunction(()=>document.querySelector('#app')?.getAttribute('aria-busy')==='false');
   await page.evaluate(zoom=>document.documentElement.style.zoom=String(zoom),scenario.zoom);
   await page.waitForTimeout(100);
   extra.push(await page.evaluate(({name,label})=>({name,page:label,width:innerWidth,height:innerHeight,
    scrollWidth:document.documentElement.scrollWidth,zoom:getComputedStyle(document.documentElement).zoom,
    title:document.querySelector('h1')?.textContent,error:document.querySelector('#page-content .notice-box.error')?.textContent??null}),
    {name:scenario.name,label:target.name}));
   await page.screenshot({path:join(output,'public-extra-'+target.name+'-'+scenario.name+'.png'),fullPage:true});
  }
  await context.close();
 }
 writeFileSync(join(output,'responsive-extra.json'),JSON.stringify(extra,null,2));
 console.log('PAGE AUDIT COMPLETE',JSON.stringify({measurements:results.length,additionalScreens:extra.length}));
}
