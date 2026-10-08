// Apply the stored palette before the first paint.
(()=>{let theme;try{theme=localStorage.getItem('baros:theme')}catch{}
 if(!['light','dark'].includes(theme))theme=window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light';
 document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#171623':'#5b47d6');
})();
