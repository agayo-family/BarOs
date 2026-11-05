// Progressive enhancement: content stays visible if animations are unavailable.
export const reducedMotion=()=>!!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
export const smoothBehavior=()=>reducedMotion()?'auto':'smooth';
export function respectPreference(animation){
 const preference=window.matchMedia?.('(prefers-reduced-motion: reduce)');
 const change=()=>{if(preference.matches)animation.cancel()};
 const clean=()=>preference?.removeEventListener?.('change',change);
 preference?.addEventListener?.('change',change);animation.finished.then(clean,clean);
 return animation;
}
export function arrive(element,delay=0){
 if(!element?.animate||reducedMotion())return null;
 // Leave hover transforms independent of the reveal animation's lifecycle.
 return respectPreference(element.animate([{opacity:.3},{opacity:1}],{duration:480,delay,easing:'cubic-bezier(.22,1,.36,1)'}));
}
export function fadeChange(element){
 if(!element?.animate||reducedMotion())return null;
 return respectPreference(element.animate([{opacity:.72},{opacity:1}],{duration:180,easing:'ease-out'}));
}

// Measure each variant at the real content width without touching live regions.
export function reserveHeight(element,variants){
 const width=parseFloat(window.getComputedStyle(element).width);
 if(!width||!variants.length)return;
 const sample=element.cloneNode(false);
 for(const name of ['id','role','aria-live','aria-atomic'])sample.removeAttribute(name);
 sample.setAttribute('aria-hidden','true');
 sample.inert=true;
 Object.assign(sample.style,{position:'fixed',left:'0',top:'0',width:width+'px',minHeight:'0',height:'auto',visibility:'hidden',pointerEvents:'none'});
 element.parentElement.append(sample);
 try{
  let height=0;
  for(const html of variants){
   sample.innerHTML=html;
   height=Math.max(height,parseFloat(window.getComputedStyle(sample).height)||0);
  }
  if(height)element.style.minHeight=Math.ceil(height)+'px';
 }finally{sample.remove()}
}
export function revealSections(root){
 if(reducedMotion()||!window.IntersectionObserver)return ()=>{};
 const running=new Set(),seen=new WeakSet();
 const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting||seen.has(entry.target))continue;seen.add(entry.target);observer.unobserve(entry.target);const animation=arrive(entry.target);if(animation){running.add(animation);animation.finished.then(()=>running.delete(animation),()=>running.delete(animation))}}},{threshold:.08});
 root.querySelectorAll('.site-hero-copy,.site-demo,.site-section-heading,.site-feature,.site-insight>div,.site-steps>li,.site-price-intro,.site-price-card,.site-plan-gallery,.site-faq>div,.site-final>div').forEach(element=>observer.observe(element));
 const preference=window.matchMedia?.('(prefers-reduced-motion: reduce)');
 const stop=()=>{observer.disconnect();running.forEach(a=>a.cancel());running.clear()};
 const change=()=>{if(preference.matches)stop()};preference?.addEventListener?.('change',change);
 return ()=>{stop();preference?.removeEventListener?.('change',change)};
}
