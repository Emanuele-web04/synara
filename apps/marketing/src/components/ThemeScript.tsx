"use client";

import { useServerInsertedHTML } from "next/navigation";

const THEME_KEY = "synara-theme";

// also runs in Next's error-fallback shell whose hydration rewrites <html> class from the RSC tree and would strip `dark` — the debounced MutationObserver re-asserts it; debounced so it never races ThemeToggle's same-task class+localStorage write
const themeInit = `(function(){try{var d=document.documentElement;var K=${JSON.stringify(THEME_KEY)};function stored(){try{return localStorage.getItem(K)}catch(e){return null}}function apply(){var t=stored();var dark=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d.classList.contains('dark')!==dark)d.classList.toggle('dark',dark)}apply();window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',function(){if(!stored())apply()});if(!window.__synaraThemeObserver){window.__synaraThemeObserver=new MutationObserver(function(){setTimeout(apply,0)});window.__synaraThemeObserver.observe(d,{attributes:true,attributeFilter:['class']})}window.addEventListener('load',function(){setTimeout(apply,0)});setTimeout(apply,300)}catch(e){}})()`;

/** Injects theme sync into the HTML stream so it runs before paint without React 19 script-tag warnings. */
export function ThemeScript() {
  useServerInsertedHTML(() => (
    <script id="synara-theme-init" dangerouslySetInnerHTML={{ __html: themeInit }} />
  ));
  return null;
}
