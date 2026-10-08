(function () {
  'use strict';
  const KEY = 'meridian.appearance';
  const MIGRATION_KEY = 'meridian.appearance.v2';
  const SYSTEM = 'system';
  const MODES = [
    [SYSTEM, 'System'],
    ['meridian', 'Meridian'],
    ['brief-light', 'Brief light'],
    ['brief-dark', 'Brief dark'],
  ];
  const root = document.documentElement;
  // Inside the Meridian Mac app the top 32 px is the window's drag strip.
  if (new URLSearchParams(location.search).has('app')) root.dataset.app = '1';
  // Shown inside the command centre's Brief tab.
  if (new URLSearchParams(location.search).has('embed')) root.dataset.embed = '1';
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');

  function resolve(mode) {
    return mode === SYSTEM ? (systemTheme.matches ? 'brief-dark' : 'brief-light') : mode;
  }

  function apply(mode, persist = true) {
    if (!MODES.some(([id]) => id === mode)) mode = SYSTEM;
    const resolved = resolve(mode);
    root.dataset.appearance = resolved;
    if (resolved === 'brief-dark') root.dataset.theme = 'dark';
    else if (resolved === 'brief-light') root.dataset.theme = 'light';
    else root.removeAttribute('data-theme');
    if (persist) localStorage.setItem(KEY, mode);
    document.querySelectorAll('.appearance-picker button').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.appearance === mode));
    });
  }

  const picker = document.createElement('div');
  picker.className = 'appearance-picker';
  picker.setAttribute('aria-label', 'Appearance');
  picker.innerHTML = `<button type="button" class="appearance-trigger" aria-label="Change appearance" aria-expanded="false"><span></span></button><div class="appearance-options">${MODES.map(([id, label]) =>
    `<button type="button" data-appearance="${id}" aria-pressed="false">${label}</button>`).join('')}</div>`;
  picker.addEventListener('click', (event) => {
    const trigger = event.target.closest('.appearance-trigger');
    if (trigger) {
      const open = picker.classList.toggle('open');
      trigger.setAttribute('aria-expanded', String(open));
      return;
    }
    const button = event.target.closest('button[data-appearance]');
    if (button) {
      apply(button.dataset.appearance);
      picker.classList.remove('open');
      picker.querySelector('.appearance-trigger').setAttribute('aria-expanded', 'false');
    }
  });
  document.body.appendChild(picker);

  let initial = localStorage.getItem(KEY);
  if (!localStorage.getItem(MIGRATION_KEY)) {
    // The old script wrote brief-light on first load, even when Owner had not
    // made an explicit choice. Let that implicit value follow the system.
    if (initial === 'brief-light') initial = SYSTEM;
    localStorage.setItem(MIGRATION_KEY, '1');
  }
  apply(initial || SYSTEM);

  const onSystemThemeChange = () => {
    if ((localStorage.getItem(KEY) || SYSTEM) === SYSTEM) apply(SYSTEM, false);
  };
  if (typeof systemTheme.addEventListener === 'function') systemTheme.addEventListener('change', onSystemThemeChange);
  else systemTheme.addListener(onSystemThemeChange);
})();
