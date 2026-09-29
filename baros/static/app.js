(function(){
  const tip=document.createElement('div'); tip.className='tooltip'; document.body.appendChild(tip);
  function show(el){tip.textContent=el.dataset.definition||''; const r=el.getBoundingClientRect(); tip.style.display='block'; const w=tip.offsetWidth,h=tip.offsetHeight; let left=Math.min(window.innerWidth-w-12,Math.max(12,r.left)); let top=r.bottom+8; if(top+h>window.innerHeight-12) top=Math.max(12,r.top-h-8); tip.style.left=left+'px';tip.style.top=top+'px'}
  function hide(){tip.style.display='none'}
  document.addEventListener('mouseover',e=>{const el=e.target.closest('.term');if(el)show(el)});
  document.addEventListener('focusin',e=>{const el=e.target.closest('.term');if(el)show(el)});
  document.addEventListener('mouseout',e=>{if(e.target.closest('.term'))hide()});
  document.addEventListener('focusout',e=>{if(e.target.closest('.term'))hide()});
  document.addEventListener('click',e=>{const el=e.target.closest('.term'); if(el){e.preventDefault(); e.stopPropagation(); if(tip.style.display==='block') hide(); else show(el)} else hide()});
})();
