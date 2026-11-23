// Chromium shows :focus-visible on any focus a click did not cause, so a window that takes the keyboard from the tray, a global
// shortcut or autoFocus opens with a ring. base.css hides the ring until this window sees a key, and again after a click or a blur.
export function trackKeyboardFocus(): void {
  const root = document.documentElement;
  const off = () => delete root.dataset.keyboard;
  window.addEventListener('keydown', (e) => {
    if (!e.metaKey && !e.ctrlKey) root.dataset.keyboard = '';
  }, true);
  window.addEventListener('pointerdown', off, true);
  window.addEventListener('blur', off);
}
