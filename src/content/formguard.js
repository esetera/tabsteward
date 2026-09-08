// Optional content script (only registered when the user grants all-sites access).
// Answers two questions from the background: "has the user typed into this page?" and
// "give me a short excerpt for classification". Nothing is sent anywhere by this script itself.
(() => {
  if (window.__tsFormGuard) return;
  window.__tsFormGuard = true;
  let dirty = false;
  const mark = () => { dirty = true; };
  document.addEventListener('input', mark, true);
  document.addEventListener('change', mark, true);
  document.addEventListener('submit', () => { dirty = false; }, true);

  function excerpt() {
    const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
    const desc = meta ? meta.getAttribute('content') || '' : '';
    const h1 = document.querySelector('h1');
    const head = h1 ? h1.textContent.trim() : '';
    const body = (document.body && document.body.innerText) || '';
    return [head, desc, body.replace(/\s+/g, ' ').slice(0, 400)].filter(Boolean).join(' | ').slice(0, 600);
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== 'string') return undefined;
    if (msg.type === 'ts:dirty?') {
      // The input flag catches typing; the scan catches text restored by the browser after a reload.
      let typed = dirty;
      if (!typed) {
        for (const el of document.querySelectorAll('textarea, input[type="text"], input[type="email"], input[type="search"], [contenteditable="true"]')) {
          const v = el.isContentEditable ? el.textContent : el.value;
          if (v && v.trim().length > 20 && el.defaultValue !== v) { typed = true; break; }
        }
      }
      return Promise.resolve({ dirty: typed });
    }
    if (msg.type === 'ts:excerpt') return Promise.resolve({ excerpt: excerpt() });
    return undefined;
  });
})();
