'use strict';
/* Vanilla shadcn-style controllers: dialog, sidebar drawer, toast, copy.
 * No dependencies. Focus-trapped lightly (Esc closes, overlay click closes). */
const UI = (() => {
  function ensureToasts() {
    let box = document.querySelector('.toasts');
    if (!box) {
      box = document.createElement('div');
      box.className = 'toasts';
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    return box;
  }

  function toast(msg, kind = '') {
    const box = ensureToasts();
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, 3400);
  }

  async function copy(text, label = 'Copied to clipboard') {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* best effort */ }
      ta.remove();
    }
    toast(label);
  }

  function dialog({ title, sub = '', bodyHTML = '', actions = [], dismissible = true }) {
    closeDialog();
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-label="${title.replace(/"/g, '')}">
      <h3></h3>${sub ? `<p class="sub"></p>` : ''}<div class="dbody"></div><div class="dialog-foot"></div>
    </div>`;
    overlay.querySelector('h3').textContent = title;
    if (sub) overlay.querySelector('.sub').textContent = sub;
    overlay.querySelector('.dbody').innerHTML = bodyHTML;
    const foot = overlay.querySelector('.dialog-foot');
    const close = () => overlay.remove();
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = `btn ${a.kind || ''}`;
      b.textContent = a.label;
      b.onclick = async () => {
        try { await a.onClick?.(); } finally { if (a.keepOpen !== true) close(); }
      };
      foot.appendChild(b);
    }
    if (dismissible) {
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
      const esc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
      document.addEventListener('keydown', esc);
    }
    document.body.appendChild(overlay);
    const first = foot.querySelector('.btn.primary') || foot.querySelector('.btn');
    if (first) first.focus();
    return close;
  }

  function closeDialog() {
    document.querySelectorAll('.dialog-overlay').forEach((el) => el.remove());
  }

  function toggleNav(open) {
    if (open === undefined) document.body.classList.toggle('nav-open');
    else document.body.classList.toggle('nav-open', !!open);
  }

  return { toast, copy, dialog, closeDialog, toggleNav };
})();
