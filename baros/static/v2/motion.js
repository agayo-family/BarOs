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
export function resizeArrive(element,previousHeight){
 if(!element?.animate||reducedMotion())return null;
 const height=element.getBoundingClientRect().height;
 const frames=Math.abs(height-previousHeight)<.5?[{opacity:.55},{opacity:1}]:[{opacity:.55,height:previousHeight+'px'},{opacity:1,height:height+'px'}];
 return respectPreference(element.animate(frames,{duration:420,easing:'cubic-bezier(.22,1,.36,1)'}));
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
