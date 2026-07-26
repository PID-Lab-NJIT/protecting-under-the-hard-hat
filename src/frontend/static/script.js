/* Survey app: dynamic UI, branching, persistence, submission. */

/* Fresh session per load (per current product choice) - preserving deviceID and progress */
(() => {
  const preserved = ['dyn:deviceId', 'dyn:sessionId', 'dyn:answers', 'dyn:currentId', 'dyn:mode', 'dyn:history', 'k10:theme', 'k10:cookiesAccepted', 'dyn:introSeen'];
  try {
    const keys = Object.keys(localStorage);
    keys.forEach(k => {
      if (k.startsWith('dyn:') && !preserved.includes(k)) localStorage.removeItem(k);
    });
  } catch { }
  // Note: we no longer clear answers/currentId here to allow for persistence
})();

/* store query params into sessionStorage */
function captureQueryParams(allowedKeys = null) {
  const params = new URLSearchParams(window.location.search);
  const obj = {};
  for (const [k, v] of params.entries()) {
    if (!allowedKeys || allowedKeys.includes(k)) obj[k] = v;
  }
  try { sessionStorage.setItem('dyn:query', JSON.stringify(obj)); } catch { }
  return obj;
}

/* Data loading */
let RESOURCES_DB = [];
const loadResourcesJSON = async () => {
  try {
    const r = await fetch('../static/resources.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    RESOURCES_DB = await r.json();
  } catch (e) {
    console.error('Failed to load resources.json', e);
    RESOURCES_DB = [];
  }
};
const loadQuestionsJSON = async () => {
  const url = '../static/questions.json';
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`Failed to load ${url}: HTTP ${r.status}`);
  return r.json();
};

/* Backend submission */
const SURVEY_ENDPOINT = 'https://nn6mnazknqfj6su7x5cm4svs640nmglc.lambda-url.us-east-2.on.aws/survey';
/* Local resources lookup (GET, query params in kebab-case; see src/backend/get_local_resources/spec.md) */
const LOCAL_RESOURCES_ENDPOINT = 'https://xo4yg2k32agti3frvpgix5sp5m0vemso.lambda-url.us-east-2.on.aws/local-resources';
async function submitSurvey(payload) {
  const res = await fetch(SURVEY_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const message = (data && data.message) || res.statusText || 'Request failed';
    throw new Error(`Submit failed (${res.status}): ${message}`);
  }
  return data;
}

/* Minimal toast */
function showToast(message) {
  const el = document.createElement('div');
  el.style.cssText = `
    position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
    background: var(--bg-secondary); color: var(--text-primary);
    padding: 10px 16px; border-radius: 25px; font-size: .9rem; font-weight: 800;
    z-index: 2000; opacity: 0; border: 1px solid rgba(0,0,0,.06);
    transition: all .3s ease; box-shadow: ${getComputedStyle(document.body).getPropertyValue('--shadow-a')};
  `;
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 280); }, 1600);
}

/* Visibility rules for branching */
function isVisible(question, answers) {
  const c = question.showIf;
  if (!c) return true;

  const evalCond = (cond) => {
    if (!cond) return true;
    if (Array.isArray(cond.and)) return cond.and.every(evalCond);
    if (Array.isArray(cond.or)) return cond.or.some(evalCond);
    if (cond.not) return !evalCond(cond.not);

    const qid = cond.questionId || cond.q;
    if (!qid) return true;

    const a = answers[qid];
    if (a === undefined || a === null || (Array.isArray(a) && a.length === 0)) return false;

    const arr = Array.isArray(a) ? a : [a];

    if (cond.equals !== undefined) return a === cond.equals;
    if (Array.isArray(cond.anyOf)) return arr.some(v => cond.anyOf.includes(v));
    if (cond.notEquals !== undefined) return a !== cond.notEquals;
    if (cond.contains !== undefined) return arr.includes(cond.contains);

    return true;
  };

  return evalCond(c);
}

function isPotentiallyVisible(question, answers) {
  const c = question.showIf;
  if (!c) return true;

  const evalCond = (cond) => {
    if (!cond) return true;
    if (Array.isArray(cond.and)) return cond.and.every(evalCond);
    if (Array.isArray(cond.or)) return cond.or.some(evalCond);
    if (cond.not) return !evalCond(cond.not);

    const qid = cond.questionId || cond.q;
    if (!qid) return true;

    const a = answers[qid];
    if (a === undefined || a === null || (Array.isArray(a) && a.length === 0)) return true;

    const arr = Array.isArray(a) ? a : [a];

    if (cond.equals !== undefined) return a === cond.equals;
    if (Array.isArray(cond.anyOf)) return arr.some(v => cond.anyOf.includes(v));
    if (cond.notEquals !== undefined) return a !== cond.notEquals;
    if (cond.contains !== undefined) return arr.includes(cond.contains);

    return true;
  };

  return evalCond(c);
}

async function captureBrowserGPS({
  highAccuracy = false,      // false reduces timeouts indoors; you can retry with true if needed
  timeoutMs = 30000,
  maximumAgeMs = 600000      // allow cached position up to 10 min
} = {}) {
  const write = (obj) => { try { sessionStorage.setItem('dyn:gps', JSON.stringify(obj)); } catch { } };

  if (!('geolocation' in navigator)) {
    write({ supported: false, status: 'unsupported', capturedAt: new Date().toISOString() });
    return null;
  }

  const getPosition = () =>
    new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: highAccuracy,
        timeout: timeoutMs,
        maximumAge: maximumAgeMs
      });
    });

  try {
    const pos = await getPosition();
    const gps = {
      supported: true,
      status: 'ok',
      capturedAt: new Date().toISOString(),
      coords: {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      }
    };
    write(gps);
    return gps;
  } catch (err) {
    // Standard codes: 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT
    const code = err?.code;
    const status =
      code === 1 ? 'denied' :
        code === 2 ? 'unavailable' :
          code === 3 ? 'timeout' :
            'error';

    const gps = {
      supported: true,
      status,
      capturedAt: new Date().toISOString(),
      error: { code, message: err?.message }
    };
    write(gps);
    return null;
  }
}

function getStoredGPS() {
  try { return JSON.parse(sessionStorage.getItem('dyn:gps') || 'null'); }
  catch { return null; }
}

async function retryGPS() {
  // First attempt: reliable
  let gps = await captureBrowserGPS({ highAccuracy: false });
  if (gps) return gps;

  // Second attempt: more precise but may be slower
  return await captureBrowserGPS({ highAccuracy: true, timeoutMs: 20000 });
}

/* ===== Language toggle + translation layer (H8) =====
   String catalog lives in static/i18n.js (window.TRANSLATIONS, locale-keyed).
   - t(key, fallback): plain lookup with English fallback
   - tFmt(key, fallback, vars): lookup + {placeholder} interpolation
   - applyTranslations(lang): swaps [data-i18n] text, [data-i18n-placeholder]
     placeholders and [data-i18n-aria] aria-labels, then asks the survey to
     re-render any live question/help content. */
const TRANSLATIONS = window.TRANSLATIONS || { en: {}, es: {}, pt: {} };

function getSelectedLanguage() {
  try { return localStorage.getItem('k10:lang') || 'en'; } catch { return 'en'; }
}

function setSelectedLanguage(lang) {
  try { localStorage.setItem('k10:lang', lang); } catch { }
  document.documentElement.lang = lang;
  let label = 'EN';
  document.querySelectorAll('.lang-btn').forEach(btn => {
    const active = btn.dataset.lang === lang;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
    if (active) label = btn.dataset.label || lang.toUpperCase();
  });
  const current = document.getElementById('langCurrent');
  if (current) current.textContent = label;
  closeLangMenu();
  applyTranslations(lang);
}

function closeLangMenu() {
  const menu = document.getElementById('langMenu');
  const btn = document.getElementById('langMenuBtn');
  menu?.classList.remove('open');
  btn?.setAttribute('aria-expanded', 'false');
}

function toggleLangMenu() {
  const menu = document.getElementById('langMenu');
  const btn = document.getElementById('langMenuBtn');
  if (!menu || !btn) return;
  const open = menu.classList.toggle('open');
  btn.setAttribute('aria-expanded', String(open));
}

function t(key, fallback) {
  const lang = getSelectedLanguage();
  return (TRANSLATIONS[lang] && TRANSLATIONS[lang][key])
    || (TRANSLATIONS.en && TRANSLATIONS.en[key])
    || fallback;
}

/* t() + `{name}` interpolation */
function tFmt(key, fallback, vars = {}) {
  let s = t(key, fallback);
  Object.entries(vars).forEach(([k, v]) => { s = s.split(`{${k}}`).join(String(v)); });
  return s;
}

/* Localized topic name (depression → depresión, …) */
function tTopic(tag) {
  const lang = getSelectedLanguage();
  return (TRANSLATIONS[lang]?.topics?.[tag]) || (TRANSLATIONS.en?.topics?.[tag]) || tag;
}

/* Localized "why" reason (English source string → translated) */
function tReason(reason) {
  const lang = getSelectedLanguage();
  return (TRANSLATIONS[lang]?.reasons?.[reason]) || reason;
}

function applyTranslations(lang) {
  const dict = TRANSLATIONS[lang] || {};
  const en = TRANSLATIONS.en || {};
  const get = (key) => dict[key] || en[key];
  document.querySelectorAll('[data-i18n]').forEach(node => {
    const s = get(node.dataset.i18n);
    if (s) node.textContent = s;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(node => {
    const s = get(node.dataset.i18nPlaceholder);
    if (s) node.setAttribute('placeholder', s);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach(node => {
    const s = get(node.dataset.i18nAria);
    if (s) node.setAttribute('aria-label', s);
  });
  // Live re-render of dynamic survey content (questions, help page, controls)
  window.survey?.onLanguageChanged?.();
}

// Reports the user's UI language choice (falls back to browser locale)
function getLanguage() {
  const chosen = getSelectedLanguage();
  if (chosen && chosen !== 'en') return chosen;
  return navigator.language || navigator.userLanguage || 'en-US';
}

/* Dynamic survey controller */
class DynamicSurvey {
  constructor(config) {
    this.config = config || { title: 'Survey', version: '1.0', settings: {}, questions: [] };
    this.settings = {
      autoAdvanceSingle: !!config?.settings?.autoAdvanceSingle,
      requireNextOnMultiple: typeof config?.settings?.requireNextOnMultiple === 'boolean'
        ? config.settings.requireNextOnMultiple
        : true,
      showAbsoluteProgress: !!config?.settings?.showAbsoluteProgress,
      legacyQuestionTags: !!config?.settings?.legacyQuestionTags,
      defaultTopics: (config?.settings?.defaultTopics || []).map(s => String(s).toLowerCase())
    };
    this.questions = Array.isArray(config.questions) ? config.questions : [];
    this.answers = {};
    this.currentId = null;
    try {
      const rawHistory = localStorage.getItem('dyn:history');
      this.navHistory = rawHistory ? JSON.parse(rawHistory) : [];
    } catch { this.navHistory = []; }

    // Persistent deviceID (same across surveys/refreshes)
    this.deviceID = localStorage.getItem('dyn:deviceId');
    if (!this.deviceID) {
      this.deviceID = crypto.randomUUID();
      try { localStorage.setItem('dyn:deviceId', this.deviceID); } catch { }
    }

    // Session ID matches the current attempt
    this.sessionID = localStorage.getItem('dyn:sessionId');
    if (!this.sessionID) {
      this.sessionID = crypto.randomUUID();
      try { localStorage.setItem('dyn:sessionId', this.sessionID); } catch { }
    }

    // Navigation + interaction throttles
    this.navCooldownMs = 100;        // rate-limit for Next/Back/Submit
    this.interactCooldownMs = 500;   // minimum time before options are clickable on a new step
    this.autoAdvanceDelayMs = 180;   // small delay before auto-advance to next step

    this.navCooldownUntil = 0;       // when Next/Back/Submit allowed again
    this.interactLockUntil = 0;      // when option clicks allowed again
    this.isTransitioning = false;    // true while we're navigating to another step
    this._interactUnlockTimer = null;

    this.submitting = false;         // lock UI during submit
    this.helpOrigin = 'summary';     // where help was opened from

    this.dom = {
      root: document.getElementById('questionsRoot'),
      title: document.getElementById('appTitle'),
      subtitle: document.getElementById('appSubtitle'),
      progressBar: document.getElementById('progressBar'),
      backBtn: document.getElementById('backBtn'),
      completion: document.querySelector('[data-question="complete"]'),
      help: document.querySelector('[data-question="help"]'),
      helpTitle: document.querySelector('.help-container .help-title'),
      helpSubtitle: document.querySelector('.help-container .help-subtitle'),
      helpGrid: document.getElementById('helpGrid'),
      helpBackBtn: document.getElementById('helpBackBtn'),
      helpRestartBtn: document.getElementById('helpRestartBtn'),
      helpBtn: document.getElementById('helpBtn'),
      restartBtn: document.getElementById('restartBtn'),
      whyLink: document.getElementById('whyLink'),
      whyContent: document.getElementById('whyContent'),
      whySection: document.getElementById('whySection'),
      resourceSearch: document.getElementById('resourceSearch'),
      zipInput: document.getElementById('zipInput'),
      zipSearchBtn: document.getElementById('zipSearchBtn'),
      zipClearBtn: document.getElementById('zipClearBtn'),
      zipStatus: document.getElementById('zipStatus'),
      localSection: document.getElementById('localResourcesSection'),
      localGrid: document.getElementById('localGrid'),
      unionInput: document.getElementById('unionFilterInput'),
      unionClearBtn: document.getElementById('unionClearBtn'),
      unionList: document.getElementById('unionFilterList'),
      localSortWrap: document.getElementById('localSortWrap'),
      localSortTrigger: document.getElementById('localSortTrigger'),
      localSortValue: document.getElementById('localSortValue'),
      localSortList: document.getElementById('localSortList'),
      distanceRow: document.getElementById('distanceRow'),
      maxDistanceSlider: document.getElementById('maxDistanceSlider'),
      maxDistanceValue: document.getElementById('maxDistanceValue'),
      maxDistanceHint: document.getElementById('maxDistanceHint'),
      nationalTitle: document.getElementById('nationalTitle'),
      emailResultsBtn: document.getElementById('emailResultsBtn'),
      exitRampBtn: document.getElementById('exitRampBtn'),
      feedbackCard: document.getElementById('feedbackCard')
    };

    this.clickedResources = []; // Array preserves order and duplicates (e.g. A→B→A)

    this.bindGlobalEvents();
    this.initUI();

    this.dom.helpBtn?.addEventListener('click', () => { this.renderHelpResources({ all: false, from: 'summary' }); this.showHelpPage(); });
    this.dom.restartBtn?.addEventListener('click', () => this.restart());
    this.dom.helpBackBtn?.addEventListener('click', () => this.backToSummary());
    this.dom.helpRestartBtn?.addEventListener('click', () => this.restart());

    this.dom.whyLink?.addEventListener('click', (e) => {
      e.preventDefault();
      this.toggleWhySection();
    });

    // H1: live search filter on resource cards
    this.dom.resourceSearch?.addEventListener('input', () => this.applyResourceSearch());

    // H7: localized resources via ZIP
    this.dom.zipSearchBtn?.addEventListener('click', () => this.lookupLocalResources());
    this.dom.zipInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.lookupLocalResources(); } });
    this.dom.zipClearBtn?.addEventListener('click', () => this.clearLocalResources());

    // Union/Contractor client-side filter (typeahead over the full resource list)
    this._allLocalResources = null;      // cached full list (max-radius=-1)
    this._allLocalFetch = null;          // in-flight fetch promise (dedupe)
    this._unionFilter = '';              // selected union/contractor ('' = none)
    this._localSort = 'relevance';       // 'relevance' | 'name' | 'distance'
    this._maxDistanceMiles = 50;         // slider value; applied only when ZIP results exist
    this.dom.unionInput?.addEventListener('input', () => this.onUnionInput());
    this.dom.unionInput?.addEventListener('focus', () => this.onUnionInput());
    this.dom.unionInput?.addEventListener('keydown', (e) => this.onUnionKeydown(e));
    this.dom.unionClearBtn?.addEventListener('click', () => this.clearUnionFilter());
    this.dom.localSortTrigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSortMenu();
    });
    this.dom.localSortTrigger?.addEventListener('keydown', (e) => this.onSortTriggerKeydown(e));
    this.dom.localSortList?.addEventListener('click', (e) => {
      const item = e.target.closest('.custom-select-item');
      if (item) this.selectSort(item.dataset.value);
    });
    this.dom.localSortList?.addEventListener('keydown', (e) => this.onSortListKeydown(e));
    this.dom.maxDistanceSlider?.addEventListener('input', () => {
      this._maxDistanceMiles = Number(this.dom.maxDistanceSlider.value) || 50;
      this.updateDistanceSliderLabel();
      this.refreshLocalResults();
    });
    // Click/tap anywhere on the track jumps the thumb there AND begins dragging
    // in the same gesture (native range behaviour is inconsistent across browsers).
    this.setupSliderJumpDrag(this.dom.maxDistanceSlider);
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.union-filter')) this.closeUnionList();
      if (!e.target.closest('.custom-select')) this.closeSortMenu();
    });

    // Warm the union/contractor list in the background so the typeahead is
    // instant (no "Loading resource list…" flash) by the time the user types.
    // Deferred to idle so it never competes with initial page render.
    const preloadUnions = () => { this.ensureAllLocalResources(); };
    if ('requestIdleCallback' in window) requestIdleCallback(preloadUnions, { timeout: 2500 });
    else setTimeout(preloadUnions, 1200);

    // H6: email results (mailto)
    this.dom.emailResultsBtn?.addEventListener('click', () => this.emailResults());

    // H4: exit ramp — jump straight to urgent/national resources
    this.dom.exitRampBtn?.addEventListener('click', () => this.exitToUrgentResources());

    // H3: "Was this tool helpful?" slide-up card
    this.feedbackShown = false;
    document.getElementById('feedbackYes')?.addEventListener('click', () => this.answerFeedback(true));
    document.getElementById('feedbackNo')?.addEventListener('click', () => this.answerFeedback(false));
    document.getElementById('feedbackDismiss')?.addEventListener('click', () => this.hideFeedbackCard());
  }

  get storageKeys() {
    return { answers: 'dyn:answers', current: 'dyn:currentId', submissions: 'dyn:submissions', mode: 'dyn:mode', query: 'dyn:query', deviceId: 'dyn:deviceId', history: 'dyn:history', sessionId: 'dyn:sessionId' };
  }

  // Throttle helpers
  canNavigate() {
    return !this.submitting && Date.now() >= this.navCooldownUntil && !this.isTransitioning;
  }
  startNavCooldown(ms = this.navCooldownMs) {
    this.navCooldownUntil = Date.now() + ms;
  }

  canInteract() {
    return !this.submitting && !this.isTransitioning && Date.now() >= this.interactLockUntil;
  }
  startInteractCooldown(ms = this.interactCooldownMs, container = this.getContainer(this.currentId)) {
    this.interactLockUntil = Date.now() + ms;
    if (this._interactUnlockTimer) clearTimeout(this._interactUnlockTimer);

    // Disable option clicks briefly
    const options = container?.querySelector('.options');
    if (options) {
      options.style.pointerEvents = 'none';
      options.style.transition = options.style.transition || 'opacity 150ms';
      options.style.opacity = options.style.opacity || '';
      // Optionally dim a bit for feedback (comment out if undesired)
      // options.style.opacity = '0.92';
      this._interactUnlockTimer = setTimeout(() => {
        options.style.pointerEvents = '';
        // options.style.opacity = '';
      }, ms);
    } else {
      this._interactUnlockTimer = setTimeout(() => { }, ms);
    }
  }

  /* Global UI: theme, cookies, back, keys, and event delegation for clicks */
  bindGlobalEvents() {

    // Resource click tracking
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (chip) {
        const text = chip.textContent.trim();
        if (text) this.clickedResources.push(text);
      }
    });

    // Send a canonical payload whenever the user leaves the page (mid-survey or after).
    // H5 fix: dedupe — only send when survey state has actually changed since the
    // last leave-payload. Opening a resource link briefly hides the tab, which used
    // to fire redundant identical payloads every few seconds.
    this._lastLeaveFingerprint = null;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;

      // Only send if the user has actually entered the survey flow
      const hasEntered = !!this.currentId || this.clickedResources.length > 0;
      if (!hasEntered) return;

      // Fingerprint of everything meaningful: answers, position, completion, clicks.
      const fingerprint = JSON.stringify({
        answers: this.answers,
        currentId: this.currentId,
        completed: this.submitting,
        clicked: this.clickedResources
      });
      if (fingerprint === this._lastLeaveFingerprint) return; // no change → no payload
      this._lastLeaveFingerprint = fingerprint;

      // Build the same canonical payload used for submission, but with completed=false
      // and attach any clicked resources accumulated in this session.
      const payload = this.buildSurveyPayload(this.submitting);
      if (this.clickedResources.length > 0) {
        payload.data.clickedResources = [...this.clickedResources];
      }

      fetch(SURVEY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => { });

      // Do NOT clear clickedResources here — opening a resource link temporarily hides
      // the tab, which would reset the list. Let it accumulate for the full session.
      // The Set is naturally destroyed when the page closes.
    });


    // Apply saved theme, or default to dark if none saved
    try {
      const savedTheme = localStorage.getItem('k10:theme');
      if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
      } else if (savedTheme === 'light') {
        document.body.classList.remove('dark-mode');
      } else {
        // No saved preference → default to dark
        document.body.classList.add('dark-mode');
      }
    } catch { }

    const themeToggle = document.getElementById('themeToggle');
    const themeIcon = document.getElementById('themeIcon');
    // Match the landing page: Font Awesome sun/moon icons (fa-sun in dark mode)
    const syncThemeIcon = () => {
      if (!themeIcon) return;
      const dark = document.body.classList.contains('dark-mode');
      themeIcon.className = dark ? 'fas fa-sun' : 'fas fa-moon';
      themeToggle?.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    };
    themeToggle?.addEventListener('click', () => {
      document.body.classList.toggle('dark-mode');
      try { localStorage.setItem('k10:theme', document.body.classList.contains('dark-mode') ? 'dark' : 'light'); } catch { }
      syncThemeIcon();
    });
    syncThemeIcon();

    const cookieOverlay = document.getElementById('cookieOverlay');
    document.getElementById('cookieAccept')?.addEventListener('click', () => { try { localStorage.setItem('k10:cookiesAccepted', 'yes'); } catch { } cookieOverlay?.classList.remove('show'); });
    document.getElementById('cookieDismiss')?.addEventListener('click', () => cookieOverlay?.classList.remove('show'));

    this.dom.backBtn?.addEventListener('click', () => {
      if (!this.canNavigate()) return;
      this.startNavCooldown();
      this.isTransitioning = true;
      this.goBack();
    });

    document.addEventListener('keydown', (e) => {
      const inOverlay = document.body.classList.contains('intro-open') || this.dom.completion?.classList.contains('active') || this.dom.help?.classList.contains('active');
      if (inOverlay || !this.currentId) return;

      if (e.key === 'Backspace' || e.key === 'ArrowLeft') {
        e.preventDefault();
        if (!this.canNavigate()) return;
        this.startNavCooldown();
        this.isTransitioning = true;
        this.goBack();
        return;
      }

      if (e.key >= '1' && e.key <= '9') {
        if (!this.canInteract()) return;
        const idx = parseInt(e.key, 10) - 1;
        const options = Array.from(this.getContainer(this.currentId)?.querySelectorAll('.option') || []);
        const q = this.getQuestion(this.currentId);
        if (q?.type === 'single' && options[idx]) options[idx].click();
      }
    });

    // Single delegated listener for options + next/submit clicks
    this.dom.root.addEventListener('click', (e) => {
      const opt = e.target.closest('.option');
      if (opt) {
        const qId = opt.closest('.question-container')?.dataset.qid;
        const q = this.getQuestion(qId);
        if (q) this.onOptionClick(q, opt);
        return;
      }
      const nextBtn = e.target.closest('.submit-btn[data-role]');
      if (nextBtn) {
        if (!this.canNavigate()) return;
        this.startNavCooldown();
        this.isTransitioning = true;
        const qId = nextBtn.closest('.question-container')?.dataset.qid;
        if (qId) this.onNextFrom(qId);
      }
    });
  }

  /* Initial render and state restoration */
  initUI() {
    if (this.dom.title) this.dom.title.textContent = this.config.title || 'Survey';
    if (this.dom.subtitle) this.dom.subtitle.textContent = '';

    this.dom.root.innerHTML = this.questions.map(q => this.tplQuestion(q)).join('');
    this.hydrateFromStorage();

    // Re-sync navHistory from storage. Re-inits after clearAllProgress()
    // (e.g. "Start Fresh") used to leak the previous attempt's in-memory
    // history, leaving Back enabled on Q1 of a fresh survey — pressing it
    // jumped to a stale mid-survey question with no answers saved.
    try {
      const rawHistory = localStorage.getItem(this.storageKeys.history);
      this.navHistory = rawHistory ? JSON.parse(rawHistory) : [];
    } catch { this.navHistory = []; }

    const visible = this.getVisibleIds();
    if (!visible.length) return this.showCompletion();

    // Only restore a saved position when there is real progress (same
    // criteria as the DOMContentLoaded hasProgress() gate). A stray
    // dyn:currentId with no saved answers otherwise restores a mid-survey
    // question underneath the "Who is this for?" overlay — hitting the
    // exit ramp then "Back to beginning" then Begin landed users on that
    // stale question instead of Q1.
    const saved = this.getStoredCurrent();
    const hasSavedAnswers = Object.keys(this.answers).length > 0;
    this.currentId = (hasSavedAnswers && visible.includes(saved)) ? saved : visible[0];

    // No progress → any stored position/history is stale; drop it so Back
    // can't jump into the abandoned attempt.
    if (!hasSavedAnswers) {
      this.navHistory = [];
      try { localStorage.removeItem(this.storageKeys.history); } catch { }
    }

    this.showQuestion(this.currentId, { pushHistory: true });
    this.updateProgress();
    this.updateBackButtonState();
  }

  /* Localized question/option text with English fallback */
  qText(q) {
    const lang = getSelectedLanguage();
    return q?.i18n?.[lang]?.text || q.text;
  }
  qOptionLabel(q, o) {
    const lang = getSelectedLanguage();
    return q?.i18n?.[lang]?.options?.[String(o.id)] || o.label;
  }

  /* Question section markup (options + optional Next row) */
  tplQuestion(q) {
    const opts = (q.options || [])
      .map(o => `<button class="option" type="button" data-value="${String(o.id)}">${this.qOptionLabel(q, o)}</button>`)
      .join('');
    const nextRow = q.type === 'multiple'
      ? `<div class="submit-row"><button class="submit-btn" type="button" data-role="next" ${this.settings.requireNextOnMultiple ? 'disabled' : ''}>${t('nav.next', 'Next')}</button></div>`
      : '';
    return `
      <section class="question-container" data-qid="${q.id}" style="display:none">
        <div class="question-number"><span>Question ?/?</span></div>
        <h2 class="question-text">${this.qText(q)}</h2>
        <div class="options">${opts}</div>
        ${nextRow}
      </section>
    `;
  }

  /* Live re-render when the language toggle changes. Keeps state (answers,
     current question, help page contents) intact — only text swaps. */
  onLanguageChanged() {
    // 1) Question prompts + option labels (in place; selections preserved)
    this.questions.forEach(q => {
      const c = this.getContainer(q.id); if (!c) return;
      const textEl = c.querySelector('.question-text');
      if (textEl) textEl.textContent = this.qText(q);
      c.querySelectorAll('.option').forEach(btn => {
        const opt = (q.options || []).find(o => String(o.id) === btn.dataset.value);
        if (opt) btn.textContent = this.qOptionLabel(q, opt);
      });
    });

    // 2) Badges, progress and step controls (Next/Submit labels)
    this.updateQuestionNumberBadges();
    if (this.currentId) this.updateStepControls(this.currentId);
    // Sort dropdown: [data-i18n] already swapped the item labels; mirror the
    // active selection onto the trigger so it shows the translated value.
    this.syncSortSelection();

    // 3) Help page: re-render title/subtitle/cards/why in the new language
    const helpVisible = this.dom.help?.classList.contains('active');
    if (helpVisible && this._lastHelpRender) {
      const zipVal = this.dom.zipInput?.value;
      const local = this._localList;
      this.renderHelpResources(this._lastHelpRender);
      if (this.dom.zipInput && zipVal) this.dom.zipInput.value = zipVal;
      if (local) this.renderLocalResources(local.list, local.place);
      if (this._helpShowsUrgent) {
        if (this.dom.helpTitle) this.dom.helpTitle.textContent = t('urgent.title', 'Immediate Support');
        if (this.dom.helpSubtitle) this.dom.helpSubtitle.textContent = t('urgent.subtitle', 'If there is immediate danger, call 911. These resources can help right now — crisis lines are listed first.');
      }
    } else {
      // Off-screen: still refresh the back-button label for the stored origin
      this.updateHelpNavButtons();
    }

    // 4) "Why" toggle link label
    if (this.dom.whyLink && this.dom.whyContent) {
      const open = this.dom.whyContent.style.display === 'block';
      this.dom.whyLink.textContent = open ? t('help.whyHide', 'Hide details') : t('help.why', 'Why are we showing you these resources?');
    }
  }

  /* DOM helpers */
  getContainer(qId) { return this.dom.root.querySelector(`.question-container[data-qid="${qId}"]`); }
  getQuestion(qId) { return this.questions.find(q => q.id === qId); }

  /* Single-choice bottom row (used when not auto-advancing, or at end to submit) */
  ensureSingleNavRow(qId) {
    const c = this.getContainer(qId);
    if (!c) return null;
    let row = c.querySelector('.submit-row[data-role="single-nav"]');
    if (!row) {
      row = document.createElement('div');
      row.className = 'submit-row';
      row.dataset.role = 'single-nav';
      row.innerHTML = `<button class="submit-btn" type="button" data-role="single-nav-btn">${t('nav.next', 'Next')}</button>`;
      c.appendChild(row);
    }
    return row;
  }

  /* Bottom controls reflect current answer + whether a next step exists */
  updateStepControls(qId) {
    const q = this.getQuestion(qId);
    const c = this.getContainer(qId);
    if (!q || !c) return;

    if (q.type === 'single') {
      const answered = typeof this.answers[qId] === 'string';
      if (this.settings.autoAdvanceSingle) {
        const nextId = answered ? this.getNextId(qId) : null;
        const row = c.querySelector('.submit-row[data-role="single-nav"]');
        if (answered && !nextId) {
          const ensured = this.ensureSingleNavRow(qId);
          const btn = ensured?.querySelector('.submit-btn');
          if (btn) {
            btn.textContent = t('nav.submit', 'Submit');
            btn.removeAttribute('aria-label');
            btn.disabled = false;
          }
          ensured.style.display = '';
        } else if (row) {
          row.style.display = 'none';
        }
      } else {
        const ensured = this.ensureSingleNavRow(qId);
        const btn = ensured?.querySelector('.submit-btn');
        const nextId = answered ? this.getNextId(qId) : null;
        if (btn) {
          const isSubmit = answered && !nextId;
          btn.textContent = isSubmit ? t('nav.submit', 'Submit') : t('nav.next', 'Next');
          btn.removeAttribute('aria-label');
          btn.disabled = !answered;
        }
        ensured.style.display = '';
      }
    }

    if (q.type === 'multiple') {
      const nextBtn = c.querySelector('.submit-btn[data-role="next"]');
      const val = this.answers[qId];
      const hasAnswer = Array.isArray(val) && val.length > 0;
      if (nextBtn) {
        const isSubmit = hasAnswer && !this.getNextId(qId);
        nextBtn.disabled = this.settings.requireNextOnMultiple ? !hasAnswer : false;
        nextBtn.textContent = isSubmit ? t('nav.submit', 'Submit') : t('nav.next', 'Next');
        nextBtn.removeAttribute('aria-label');
      }
    }

    this.updateProgress();
  }

  /* Option selection handler (single vs multiple + exclusive options) */
  onOptionClick(q, btn) {
    if (!this.canInteract()) return;

    const c = this.getContainer(q.id);
    const value = btn.dataset.value;

    if (q.type === 'single') {
      // Apply selection
      c.querySelectorAll('.option').forEach(o => o.classList.remove('selected'));
      btn.classList.add('selected');
      this.answers[q.id] = value;
      this.persistAnswers();
      this.updateQuestionNumberBadges();

      const nextId = this.getNextId(q.id);
      this.updateStepControls(q.id);

      if (this.settings.autoAdvanceSingle && nextId) {
        // Prevent rapid chaining: disable options on current question immediately
        const options = c.querySelector('.options');
        if (options) options.style.pointerEvents = 'none';

        if (navigator.vibrate) navigator.vibrate(20);
        this.startNavCooldown();         // block other nav inputs
        this.isTransitioning = true;     // block option inputs until next step shows

        setTimeout(() => this.showQuestion(nextId, { pushHistory: true }), this.autoAdvanceDelayMs);
      }
      return;
    }

    // Multiple choice (with exclusive options support)
    const exclusiveIds = new Set((q.exclusiveOptionIds || []).map(String));
    const optById = id => (q.options || []).find(o => String(o.id) === String(id));
    const isExcl = id => exclusiveIds.has(String(id)) || !!optById(id)?.exclusive;

    const selected = new Set(Array.from(c.querySelectorAll('.option.selected')).map(b => b.dataset.value));
    if (btn.classList.contains('selected')) {
      btn.classList.remove('selected');
      selected.delete(value);
    } else {
      if (isExcl(value)) {
        c.querySelectorAll('.option.selected').forEach(b => b.classList.remove('selected'));
        selected.clear();
      } else {
        c.querySelectorAll('.option.selected').forEach(b => { if (isExcl(b.dataset.value)) b.classList.remove('selected'); });
        exclusiveIds.forEach(id => selected.delete(String(id)));
      }
      btn.classList.add('selected');
      selected.add(value);
    }

    this.answers[q.id] = Array.from(selected);
    this.persistAnswers();
    this.updateQuestionNumberBadges();
    this.updateStepControls(q.id);

    // Auto-advance if an exclusive option was just selected
    if (isExcl(value) && selected.has(value)) {
      const nextId = this.getNextId(q.id);
      if (nextId) {
        const options = c.querySelector('.options');
        if (options) options.style.pointerEvents = 'none';
        if (navigator.vibrate) navigator.vibrate(20);
        this.startNavCooldown();
        this.isTransitioning = true;
        setTimeout(() => this.showQuestion(nextId, { pushHistory: true }), this.autoAdvanceDelayMs);
      }
    }
  }

  /* Visible flow and branching */
  getVisibleIds() {
    const query = this.getStoredQuery();
    if (query.branching === 'false' || query.branching === 'no') return this.questions.map(q => q.id);
    return this.questions.filter(q => isVisible(q, this.answers)).map(q => q.id);
  }
  _extractShowIfRefs(cond) {
    if (!cond) return [];
    const refs = [];
    if (Array.isArray(cond.and)) cond.and.forEach(c => refs.push(...this._extractShowIfRefs(c)));
    if (Array.isArray(cond.or)) cond.or.forEach(c => refs.push(...this._extractShowIfRefs(c)));
    if (cond.not) refs.push(...this._extractShowIfRefs(cond.not));
    const qid = cond.questionId || cond.q;
    if (qid) refs.push(qid);
    return refs;
  }
  getPotentiallyVisibleIds() {
    const query = this.getStoredQuery();
    if (query.branching === 'false' || query.branching === 'no') return this.questions.map(q => q.id);

    const potVisSet = new Set();
    for (const q of this.questions) {
      if (!q.showIf) { potVisSet.add(q.id); continue; }
      if (!isPotentiallyVisible(q, this.answers)) continue;
      // Ensure all referenced parent questions are themselves reachable
      const refs = this._extractShowIfRefs(q.showIf);
      const reachable = refs.every(refId => {
        const a = this.answers[refId];
        // If the parent has a definite answer the condition was evaluated normally
        if (a !== undefined && a !== null && (!Array.isArray(a) || a.length > 0)) return true;
        // If parent answer was pruned, it must itself be potentially visible
        return potVisSet.has(refId);
      });
      if (reachable) potVisSet.add(q.id);
    }
    return this.questions.filter(q => potVisSet.has(q.id)).map(q => q.id);
  }
  maybeSkipImmediateNext(currentId, nextId) {
    const q = this.getQuestion(currentId);
    if (!q || !nextId || !Array.isArray(q.nextVisibleIfAnyOf)) return nextId;
    const ans = this.answers[currentId];
    const arr = Array.isArray(ans) ? ans : ans != null ? [ans] : [];
    if (arr.some(v => q.nextVisibleIfAnyOf.includes(v))) return nextId;

    const idxPhys = this.questions.findIndex(qq => qq.id === currentId);
    const physNextId = this.questions[idxPhys + 1]?.id || null;
    if (physNextId !== nextId) return nextId;

    const visible = this.getVisibleIds();
    const i = visible.indexOf(currentId);
    return visible[i + 2] || nextId;
  }
  getNextId(fromId = this.currentId) {
    const visible = this.getVisibleIds();
    const i = visible.indexOf(fromId);
    if (i === -1) return null;
    return this.maybeSkipImmediateNext(fromId, visible[i + 1] || null);
  }
  getPrevId(fromId = this.currentId) {
    const visible = this.getVisibleIds();
    const i = visible.indexOf(fromId);
    return i > 0 ? visible[i - 1] : null;
  }

  updateQuestionNumberBadges() {
    const visible = this.getVisibleIds();
    const potVis = this.getPotentiallyVisibleIds();

    visible.forEach((id, i) => {
      const span = this.getContainer(id)?.querySelector('.question-number span');
      if (span) {
        if (this.settings.showAbsoluteProgress) {
          // Absolute mode: show physical question number in JSON array vs Total Fixed Questions (e.g. 17/31 -> 20/31)
          const qNum = this.questions.findIndex(q => q.id === id) + 1;
          const total = this.questions.length;
          span.textContent = tFmt('q.badge', 'Question {n}/{total}', { n: qNum, total });
        } else {
          // Relative Decreasing mode: show linear 1,2,3,4 vs Shrinking Total (e.g. 17/31 -> 18/27)
          const qNum = i + 1;
          const total = potVis.length;
          span.textContent = tFmt('q.badge', 'Question {n}/{total}', { n: qNum, total });
        }
      }
    });
  }
  showQuestion(qId, { pushHistory = true } = {}) {
    if (this.submitting) return;

    if (this.dom.root) this.dom.root.style.display = '';

    this.dom.completion?.classList.remove('active');
    if (this.dom.completion) this.dom.completion.style.display = 'none';
    this.dom.help?.classList.remove('active');
    if (this.dom.help) this.dom.help.style.display = 'none';
    this.dom.root.querySelectorAll('.question-container').forEach(c => { c.classList.remove('active', 'leaving'); c.style.display = 'none'; });

    const c = this.getContainer(qId);
    if (!c) { this.isTransitioning = false; return; }
    c.style.display = 'flex';
    c.classList.add('active');

    this.updateQuestionNumberBadges();

    this.currentId = qId;
    try { localStorage.setItem(this.storageKeys.current, qId); } catch { }
    // A real question is on screen → the session 'complete' marker is stale.
    try { if (sessionStorage.getItem(this.storageKeys.current) === 'complete') sessionStorage.removeItem(this.storageKeys.current); } catch { }

    if (pushHistory) {
      const last = this.navHistory[this.navHistory.length - 1];
      if (last !== qId) {
        this.navHistory.push(qId);
        try { localStorage.setItem(this.storageKeys.history, JSON.stringify(this.navHistory)); } catch { }
      }
    }

    this.updateStepControls(qId);
    this.updateBackButtonState();

    // New: lock option clicks briefly on each question shown
    this.startInteractCooldown();

    // End transition now that question is visible
    this.isTransitioning = false;
  }
  updateProgress() {
    const visible = this.getVisibleIds();
    const potVis = this.getPotentiallyVisibleIds();

    let currentIdx, total;
    if (this.settings.showAbsoluteProgress) {
      currentIdx = Math.max(this.questions.findIndex(q => q.id === this.currentId), 0);
      total = this.questions.length || 1;
    } else {
      currentIdx = Math.max(visible.indexOf(this.currentId), 0);
      total = potVis.length || 1;
    }

    const pct = ((currentIdx + 1) / total) * 100;
    if (this.dom.progressBar) this.dom.progressBar.style.width = `${pct}%`;
  }
  updateBackButtonState() {
    if (!this.dom.backBtn) return;
    this.dom.backBtn.disabled = this.navHistory.length <= 1;
    this.dom.backBtn.style.display = 'flex';
  }

  /* Persistence (localStorage) + prune hidden answers after branching */
  persistAnswers() {
    this.pruneHiddenAnswers();
    try { localStorage.setItem(this.storageKeys.answers, JSON.stringify(this.answers)); } catch { }
  }
  pruneHiddenAnswers() {
    const visible = new Set(this.getVisibleIds());
    let changed = false;
    Object.keys(this.answers).forEach(qid => {
      if (!visible.has(qid)) { delete this.answers[qid]; changed = true; }
    });
    if (changed) {
      try { localStorage.setItem(this.storageKeys.answers, JSON.stringify(this.answers)); } catch { }
      this.questions.forEach(q => {
        if (!visible.has(q.id)) this.getContainer(q.id)?.querySelectorAll('.option.selected').forEach(b => b.classList.remove('selected'));
      });
    }
  }
  hydrateFromStorage() {
    try {
      const raw = localStorage.getItem(this.storageKeys.answers);
      this.answers = raw ? JSON.parse(raw) : {};
    } catch { this.answers = {}; }
    this.questions.forEach(q => {
      const c = this.getContainer(q.id); if (!c) return;
      const val = this.answers[q.id];
      if (q.type === 'single' && typeof val === 'string') {
        c.querySelectorAll('.option').forEach(o => o.classList.toggle('selected', o.dataset.value === val));
      } else if (q.type === 'multiple' && Array.isArray(val)) {
        const set = new Set(val);
        c.querySelectorAll('.option').forEach(o => o.classList.toggle('selected', set.has(o.dataset.value)));
      }
    });
  }
  getStoredCurrent() { try { return localStorage.getItem(this.storageKeys.current) || null; } catch { return null; } }
  getStoredMode() { try { return localStorage.getItem(this.storageKeys.mode) || null; } catch { return null; } }
  getStoredQuery() {
    try { return JSON.parse(sessionStorage.getItem(this.storageKeys.query) || '{}'); }
    catch { return {}; }
  }

  /* Next/Submit flows */
  onNextFrom(qId) {
    if (this.submitting) { this.isTransitioning = false; return; }

    const q = this.getQuestion(qId);
    const has = q.type === 'single'
      ? typeof this.answers[q.id] === 'string'
      : Array.isArray(this.answers[q.id]) && this.answers[q.id].length > 0;

    if (q.required && !has) { this.isTransitioning = false; return showToast(t('toast.answerToContinue', 'Please answer this question to continue')); }
    if (q.type === 'multiple' && this.settings.requireNextOnMultiple && !has) { this.isTransitioning = false; return showToast(t('toast.selectOne', 'Please select at least one option')); }

    const nextId = this.getNextId(qId);
    if (!nextId) return this.handleSubmit();
    this.showQuestion(nextId, { pushHistory: true });
  }
  goNext() {
    if (!this.canNavigate()) return;
    this.startNavCooldown();
    this.isTransitioning = true;
    const nextId = this.getNextId();
    if (!nextId) { this.isTransitioning = false; return this.updateStepControls(this.currentId); }
    this.showQuestion(nextId, { pushHistory: true });
  }
  goBack() {
    if (this.submitting) { this.isTransitioning = false; return; }

    if (this.navHistory.length > 1) {
      this.navHistory.pop();
      const visible = new Set(this.getVisibleIds());
      let prevId = this.navHistory[this.navHistory.length - 1];
      while (this.navHistory.length > 1 && !visible.has(prevId)) {
        this.navHistory.pop();
        prevId = this.navHistory[this.navHistory.length - 1];
      }
      try { localStorage.setItem(this.storageKeys.history, JSON.stringify(this.navHistory)); } catch { }
      if (visible.has(prevId)) {
        this.showQuestion(prevId, { pushHistory: false });
        return;
      }
    }
    const prevId = this.getPrevId();
    if (prevId) this.showQuestion(prevId, { pushHistory: true });
  }

  updateHelpNavButtons() {
    const back = this.dom.helpBackBtn;
    const restart = this.dom.helpRestartBtn;
    if (!back) return;

    if (this.helpOrigin === 'start') {
      back.textContent = t('help.backBeginning', 'Back to beginning');
      if (restart) restart.style.display = 'none';
    } else if (this.helpOrigin === 'resume') {
      back.textContent = t('nav.back', 'Back');
      if (restart) restart.style.display = 'none';
    } else if (this.helpOrigin === 'question') {
      back.textContent = t('help.backSurvey', 'Back to survey');
      if (restart) restart.style.display = 'none';
    } else {
      back.textContent = t('help.backSummary', 'Back to summary');
      if (restart) restart.style.display = '';
    }
  }

  /* Help/resources derivation */
  renderHelpResources({ all = false, from = 'summary' } = {}) {
    this.helpOrigin = from;
    this._lastHelpRender = { all, from }; // remembered so the page can always re-render
    this.updateHelpNavButtons();

    const grid = this.dom.helpGrid; if (!grid) return;

    let cards = [];
    let grouped = null; // { recommended, others } when relevance partition applies
    if (all) {
      if (this.dom.helpTitle) this.dom.helpTitle.textContent = t('help.allTitle', 'Resources');
      if (this.dom.helpSubtitle) this.dom.helpSubtitle.textContent = t('help.allSubtitle', 'Browse the full list of available resources.');
      cards = (RESOURCES_DB || [])
        .slice()
        .sort((a, b) => (a.risk || 999) - (b.risk || 999));
    } else {
      const topics = this.computeSelectedTopics();
      const copy = this.helpCopyFromResponses(topics);
      if (this.dom.helpTitle) this.dom.helpTitle.textContent = copy.title;
      if (this.dom.helpSubtitle) this.dom.helpSubtitle.textContent = copy.subtitle;

      // Partition (never hide): survey-relevant first, everything else after a divider
      const byRisk = (a, b) => (a.risk || 999) - (b.risk || 999);
      const matches = (r) => (Array.isArray(r.tags) ? r.tags.map(t => String(t).toLowerCase()) : []).some(t => topics.has(t));
      const recommended = (RESOURCES_DB || []).filter(matches).sort(byRisk);
      const others = (RESOURCES_DB || []).filter(r => !matches(r)).sort(byRisk);
      cards = recommended.concat(others);
      grouped = { recommended, others };
    }

    this._renderedCards = cards; // cache for search + email (spans BOTH groups)

    const noMatchCard = `
        <div class="help-card">
          <h4>${t('noMatch.title', 'No resources matched.')}</h4>
          <div class="help-meta">${t('noMatch.meta', 'Check back later. In the meantime, consider checking in on your friends!')}</div>
          <div class="help-actions">
            <button class="chip" type="button" id="seeAllAnywayBtn"><i class="fas fa-list"></i> ${t('noMatch.seeAll', 'See resources anyway')}</button>
          </div>
        </div>
      `;

    if (grouped) {
      grid.innerHTML = this.groupedCardsHTML(grouped.recommended, grouped.others,
        card => this.helpCardHTML(card), noMatchCard);
    } else {
      grid.innerHTML = cards.length
        ? cards.map(card => this.helpCardHTML(card)).join('')
        : noMatchCard;
    }

    // H2: "See resources anyway" → show the full list
    document.getElementById('seeAllAnywayBtn')?.addEventListener('click', () => {
      this.renderHelpResources({ all: true, from: this.helpOrigin });
    });

    // Reset search box on re-render
    if (this.dom.resourceSearch) { this.dom.resourceSearch.value = ''; }

    if (!all) {
      this.renderWhySection();
      if (this.dom.whySection) this.dom.whySection.style.display = 'block';
    } else {
      if (this.dom.whySection) this.dom.whySection.style.display = 'none';
    }
  }

  /* Localized national-resource fields (title/description/meta/action labels)
     for the active UI language, with per-field English fallback. */
  localizedResource(card) {
    const lang = getSelectedLanguage();
    const loc = (lang !== 'en' && card?.i18n?.[lang]) || null;
    const actions = (card.actions || []).map((a, i) => ({
      ...a,
      label: loc?.actions?.[i]?.label || a.label
    }));
    return {
      title: loc?.title || card.title,
      description: loc?.description || card.description,
      meta: loc?.meta || card.meta,
      actions
    };
  }

  /* Shared help-card renderer */
  helpCardHTML(card) {
    const l = this.localizedResource(card);
    const actions = l.actions.map(a => {
      const icon = a.icon || (a.kind === 'sms' ? 'fas fa-comment-dots' : a.kind === 'web' ? 'fas fa-globe' : 'fas fa-phone');
      const href = a.href || '#';
      const blank = a.targetBlank ? 'target="_blank" rel="noopener noreferrer"' : '';
      return `<a class="chip" href="${href}" ${blank}><i class="${icon}"></i> ${a.label}</a>`;
    }).join('');
    return `
        <div class="help-card">
            <h4>${l.title}</h4>
            ${l.description ? `<div class="help-description">${l.description}</div>` : ''}
            ${l.meta ? `<div class="help-meta">${l.meta}</div>` : ''}
            <div class="help-actions">${actions}</div>
        </div>
        `;
  }

  /* Relevance partition renderer shared by national + local grids.
     NEVER hides anything: "Recommended for you" first, then a styled
     divider and "More resources". Falls back gracefully when a group
     is empty (no divider when there's nothing to divide). */
  groupedCardsHTML(recommended, others, renderCard, emptyHTML = '') {
    const rec = (recommended || []).map(renderCard).join('');
    const more = (others || []).map(renderCard).join('');
    if (!rec && !more) return emptyHTML;
    if (!rec) return more; // nothing survey-relevant → flat list, no divider
    if (!more) return rec;
    return `
      <div class="resource-group-heading recommended"><i class="fas fa-star" aria-hidden="true"></i> ${t('group.recommended', 'Recommended for you')}</div>
      ${rec}
      <div class="resource-divider" role="separator">
        <span class="resource-divider-label">${t('group.more', 'More resources')}</span>
      </div>
      ${more}`;
  }

  /* Map a local-resource row's boolean topic fields to the survey topic set */
  localTopicMatch(row, topicsSet) {
    if (!topicsSet || !topicsSet.size) return false;
    const truthy = (v) => v === true || String(v).toLowerCase() === 'true';
    const MAP = {
      depression: 'Mental Health',
      alcohol: 'Alcohol',
      substances: 'Substances/Opioids',
      gambling: 'Gambling',
      abuse: 'Abuse/Violence'
    };
    for (const tag of topicsSet) {
      const field = MAP[tag];
      if (field && truthy(row[field])) return true;
    }
    return false;
  }

  /* Max-distance slider label ("50 mi") kept in sync with the slider */
  updateDistanceSliderLabel() {
    if (this.dom.maxDistanceValue) {
      const max = Number(this.dom.maxDistanceSlider?.max) || 200;
      this.dom.maxDistanceValue.textContent = (this._maxDistanceMiles >= max)
        ? t('dist.any', 'Any distance')
        : `${this._maxDistanceMiles} mi`;
    }
  }

  /* Make a range input grab-and-drag from anywhere on the track: pointerdown
     sets the value to the click position and captures the pointer so a
     continuous drag (mouse or touch) follows without releasing. */
  setupSliderJumpDrag(slider) {
    if (!slider) return;
    const valueAt = (clientX) => {
      const rect = slider.getBoundingClientRect();
      if (!rect.width) return Number(slider.value);
      const min = Number(slider.min) || 0;
      const max = Number(slider.max) || 100;
      const step = Number(slider.step) || 1;
      const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      let val = min + pct * (max - min);
      val = Math.round(val / step) * step;
      return Math.min(max, Math.max(min, val));
    };
    const apply = (clientX) => {
      const v = valueAt(clientX);
      if (String(v) !== slider.value) {
        slider.value = v;
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    slider.addEventListener('pointerdown', (e) => {
      if (slider.disabled || e.button != null && e.button !== 0) return;
      try { slider.setPointerCapture(e.pointerId); } catch { }
      apply(e.clientX);
      const move = (ev) => apply(ev.clientX);
      const up = () => {
        slider.removeEventListener('pointermove', move);
        slider.removeEventListener('pointerup', up);
        slider.removeEventListener('pointercancel', up);
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      };
      slider.addEventListener('pointermove', move);
      slider.addEventListener('pointerup', up);
      slider.addEventListener('pointercancel', up);
      e.preventDefault();
    });
  }

  /* H1: live search filter over rendered resource cards (national + local) */
  applyResourceSearch() {
    const q = (this.dom.resourceSearch?.value || '').trim().toLowerCase();
    const filterGrid = (grid) => {
      if (!grid) return 0;
      let visibleCount = 0;
      grid.querySelectorAll('.help-card').forEach(cardEl => {
        const match = !q || cardEl.textContent.toLowerCase().includes(q);
        cardEl.style.display = match ? '' : 'none';
        if (match) visibleCount++;
      });
      return visibleCount;
    };
    const n1 = filterGrid(this.dom.helpGrid);
    const n2 = filterGrid(this.dom.localGrid);

    // Group chrome (divider + headings) only makes sense for the full,
    // unfiltered relevance view — hide it while a search query is active.
    [this.dom.helpGrid, this.dom.localGrid].forEach(grid => {
      grid?.querySelectorAll('.resource-divider, .resource-group-heading').forEach(el => {
        el.style.display = q ? 'none' : '';
      });
    });

    // "No matches" hint with "see resources anyway" (H2 in search context)
    let hint = document.getElementById('searchNoMatch');
    if (n1 + n2 === 0 && q) {
      if (!hint) {
        hint = document.createElement('div');
        hint.id = 'searchNoMatch';
        hint.className = 'help-card';
        hint.innerHTML = `
          <h4>${t('searchNoMatch.title', 'No resources matched your search.')}</h4>
          <div class="help-actions">
            <button class="chip" type="button" id="searchSeeAllBtn"><i class="fas fa-list"></i> ${t('noMatch.seeAll', 'See resources anyway')}</button>
          </div>`;
        this.dom.helpGrid?.appendChild(hint);
        hint.querySelector('#searchSeeAllBtn')?.addEventListener('click', () => {
          if (this.dom.resourceSearch) this.dom.resourceSearch.value = '';
          this.renderHelpResources({ all: true, from: this.helpOrigin });
        });
      }
      hint.style.display = '';
    } else if (hint) {
      hint.remove();
    }
  }

  /* H7: localized resources via ZIP code */
  async lookupLocalResources() {
    const MAX_LOCAL_RADIUS_METERS = 160934; // 100 miles
    const zip = (this.dom.zipInput?.value || '').trim();
    const status = this.dom.zipStatus;
    const setStatus = (msg, isError = false) => {
      if (!status) return;
      status.textContent = msg;
      status.classList.toggle('error', isError);
    };

    if (!/^\d{5}$/.test(zip)) {
      setStatus(t('zip.invalid', 'Please enter a valid 5-digit ZIP code.'), true);
      return;
    }

    setStatus(t('zip.searching', 'Searching for local resources…'));
    if (this.dom.zipSearchBtn) this.dom.zipSearchBtn.disabled = true;

    try {
      const params = new URLSearchParams({
        'zip-code': zip,
        'max-radius': String(MAX_LOCAL_RADIUS_METERS),
        'is-test': 'false',
        'session-id': this.sessionID,
        'device-id': this.deviceID
      });
      const res = await fetch(`${LOCAL_RESOURCES_ENDPOINT}?${params}`, { method: 'GET' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data?.error || `HTTP ${res.status}`);

      const list = Array.isArray(data.resources) ? data.resources : [];
      const place = data.zip_code_info ? `${data.zip_code_info.city}, ${data.zip_code_info.state}` : zip;

      if (list.length === 0) {
        // Nothing within 100 miles → disclose + national resources
        this._zipResults = null;
        this.syncSortOptions();
        this.refreshLocalResults();
        setStatus(tFmt('zip.none', 'No local resources were found within 100 miles of {place}. Showing national resources instead.', { place }));
        this.renderHelpResources({ all: true, from: this.helpOrigin });
        if (this.dom.zipClearBtn) this.dom.zipClearBtn.style.display = 'none';
        return;
      }

      this._zipResults = { list, place };
      // Keep the Relevance grouped view as the default; distances still order
      // the cards within each group (see refreshLocalResults) and the user can
      // switch to a flat Distance sort via the dropdown.
      this.syncSortOptions();
      this.refreshLocalResults();
      const miles = (m) => Math.round(m / 1609.34);
      const dist = list[0]?.distance != null
        ? tFmt('zip.foundDist', ' — nearest is ~{d} mi away', { d: miles(list[0].distance) })
        : '';
      setStatus(tFmt('zip.found', 'Found {n} local resource(s) near {place}{dist}. National resources are listed below.', { n: list.length, place, dist }));
      if (this.dom.zipClearBtn) this.dom.zipClearBtn.style.display = '';
    } catch (e) {
      console.error('Local resources lookup failed:', e);
      this._zipResults = null;
      this.clearLocalResources(false);
      setStatus(t('zip.error', 'Oops there was an error. Here are all the resources.'), true);
      this.renderHelpResources({ all: true, from: this.helpOrigin });
    } finally {
      if (this.dom.zipSearchBtn) this.dom.zipSearchBtn.disabled = false;
    }
  }

  /* ===== Union/Contractor client-side filter (typeahead over all resources) ===== */

  /* Fetch the full resource list once (max-radius=-1 → no ZIP, no distance) and cache it. */
  async ensureAllLocalResources() {
    if (Array.isArray(this._allLocalResources)) return this._allLocalResources;
    if (this._allLocalFetch) return this._allLocalFetch;
    const params = new URLSearchParams({
      'max-radius': '-1',
      'is-test': 'false',
      'session-id': this.sessionID,
      'device-id': this.deviceID
    });
    this._allLocalFetch = fetch(`${LOCAL_RESOURCES_ENDPOINT}?${params}`, { method: 'GET' })
      .then(res => res.json().then(data => {
        if (!res.ok || !data.success) throw new Error(data?.error || `HTTP ${res.status}`);
        this._allLocalResources = Array.isArray(data.resources) ? data.resources : [];
        return this._allLocalResources;
      }))
      .catch(e => {
        console.error('Failed to load full resource list:', e);
        this._allLocalFetch = null; // allow retry
        return null;
      });
    return this._allLocalFetch;
  }

  /* Unique, sorted Union/Contractor names from the cached full list */
  getUnionNames() {
    const list = Array.isArray(this._allLocalResources) ? this._allLocalResources : [];
    const names = new Set();
    list.forEach(r => {
      const n = String(r['Union/Contractor'] || '').trim();
      if (n) names.add(n);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }

  /* Typeahead: filter union names as the user types, render dropdown */
  async onUnionInput() {
    const input = this.dom.unionInput;
    if (!input) return;
    if (!Array.isArray(this._allLocalResources)) {
      this.renderUnionList([{ loading: true }]);
      const loaded = await this.ensureAllLocalResources();
      if (!loaded) {
        this.renderUnionList([{ error: true }]);
        return;
      }
    }
    const q = input.value.trim().toLowerCase();
    const names = this.getUnionNames().filter(n => !q || n.toLowerCase().includes(q));
    this.renderUnionList(names.map(n => ({ name: n })));
  }

  renderUnionList(items) {
    const ul = this.dom.unionList;
    if (!ul) return;
    if (!items.length) {
      ul.innerHTML = `<li class="union-typeahead-empty" role="presentation">${t('union.noMatch', 'No matching union/contractor.')}</li>`;
    } else if (items[0].loading) {
      ul.innerHTML = `<li class="union-typeahead-empty" role="presentation">${t('union.loading', 'Loading resource list…')}</li>`;
    } else if (items[0].error) {
      ul.innerHTML = `<li class="union-typeahead-empty" role="presentation">${t('union.loadError', 'Could not load the resource list. Try again.')}</li>`;
    } else {
      ul.innerHTML = items.map(it =>
        `<li role="option"><button type="button" class="union-typeahead-item" data-union="${it.name.replace(/"/g, '&quot;')}">${it.name}</button></li>`
      ).join('');
      ul.querySelectorAll('.union-typeahead-item').forEach(btn => {
        btn.addEventListener('click', () => this.selectUnionFilter(btn.dataset.union));
      });
    }
    ul.classList.add('open');
    this.dom.unionInput?.setAttribute('aria-expanded', 'true');
  }

  closeUnionList() {
    this.dom.unionList?.classList.remove('open');
    this.dom.unionInput?.setAttribute('aria-expanded', 'false');
  }

  onUnionKeydown(e) {
    if (e.key === 'Escape') { this.closeUnionList(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = this.dom.unionList?.querySelector('.union-typeahead-item');
      if (first) this.selectUnionFilter(first.dataset.union);
      return;
    }
    if (e.key === 'ArrowDown') {
      const first = this.dom.unionList?.querySelector('.union-typeahead-item');
      if (first) { e.preventDefault(); first.focus(); }
    }
  }

  selectUnionFilter(name) {
    this._unionFilter = name || '';
    if (this.dom.unionInput) this.dom.unionInput.value = this._unionFilter;
    if (this.dom.unionClearBtn) this.dom.unionClearBtn.style.display = this._unionFilter ? '' : 'none';
    this.closeUnionList();
    this.refreshLocalResults();
  }

  clearUnionFilter() {
    this._unionFilter = '';
    if (this.dom.unionInput) this.dom.unionInput.value = '';
    if (this.dom.unionClearBtn) this.dom.unionClearBtn.style.display = 'none';
    this.closeUnionList();
    if (this.dom.zipStatus && !this._zipResults) { this.dom.zipStatus.textContent = ''; this.dom.zipStatus.classList.remove('error'); }
    this.refreshLocalResults();
  }

  /* Enable the distance sort option + max-distance slider only when ZIP
     results (with distance) exist. Relevance is always available. */
  syncSortOptions() {
    const hasDistance = !!(this._zipResults?.list?.some(r => r.distance != null));
    const distItem = this.dom.localSortList?.querySelector('.custom-select-item[data-value="distance"]');
    if (distItem) distItem.setAttribute('aria-disabled', String(!hasDistance));
    if (!hasDistance && this._localSort === 'distance') this._localSort = 'relevance';
    this.syncSortSelection();
    // Max-distance slider mirrors the same gate
    const slider = this.dom.maxDistanceSlider;
    const row = this.dom.distanceRow;
    if (slider) slider.disabled = !hasDistance;
    if (row) row.classList.toggle('disabled', !hasDistance);
    if (this.dom.maxDistanceHint) this.dom.maxDistanceHint.style.display = hasDistance ? 'none' : '';
    this.updateDistanceSliderLabel();
  }

  /* Reflect the active _localSort on the custom dropdown: mark the selected
     item and copy its (translated) label to the trigger. */
  syncSortSelection() {
    const list = this.dom.localSortList;
    if (!list) return;
    let selectedItem = null;
    list.querySelectorAll('.custom-select-item').forEach(li => {
      const on = li.dataset.value === this._localSort;
      li.classList.toggle('is-selected', on);
      li.setAttribute('aria-selected', String(on));
      if (on) selectedItem = li;
    });
    if (selectedItem && this.dom.localSortValue) {
      this.dom.localSortValue.textContent = selectedItem.textContent;
    }
  }

  toggleSortMenu() {
    if (this.dom.localSortList?.classList.contains('open')) this.closeSortMenu();
    else this.openSortMenu();
  }

  openSortMenu() {
    if (!this.dom.localSortList) return;
    this.closeUnionList();
    this.dom.localSortList.classList.add('open');
    this.dom.localSortTrigger?.setAttribute('aria-expanded', 'true');
    // Focus the currently-selected item for keyboard nav
    const sel = this.dom.localSortList.querySelector('.custom-select-item.is-selected')
      || this.dom.localSortList.querySelector('.custom-select-item:not([aria-disabled="true"])');
    sel?.setAttribute('tabindex', '0');
    sel?.focus();
  }

  closeSortMenu() {
    if (!this.dom.localSortList?.classList.contains('open')) return;
    this.dom.localSortList.classList.remove('open');
    this.dom.localSortTrigger?.setAttribute('aria-expanded', 'false');
    this.dom.localSortList.querySelectorAll('.custom-select-item').forEach(li => li.setAttribute('tabindex', '-1'));
  }

  selectSort(value) {
    const item = this.dom.localSortList?.querySelector(`.custom-select-item[data-value="${value}"]`);
    if (!item || item.getAttribute('aria-disabled') === 'true') return;
    this._localSort = value;
    this.syncSortSelection();
    this.closeSortMenu();
    this.dom.localSortTrigger?.focus();
    this.refreshLocalResults();
  }

  onSortTriggerKeydown(e) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.openSortMenu();
    } else if (e.key === 'Escape') {
      this.closeSortMenu();
    }
  }

  onSortListKeydown(e) {
    const items = Array.from(this.dom.localSortList.querySelectorAll('.custom-select-item'))
      .filter(li => li.getAttribute('aria-disabled') !== 'true');
    const idx = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = items[Math.min(idx + 1, items.length - 1)] || items[0];
      next?.setAttribute('tabindex', '0'); next?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = items[Math.max(idx - 1, 0)] || items[items.length - 1];
      prev?.setAttribute('tabindex', '0'); prev?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (document.activeElement?.dataset?.value) this.selectSort(document.activeElement.dataset.value);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      this.closeSortMenu();
      if (e.key === 'Escape') this.dom.localSortTrigger?.focus();
    }
  }

  /* Recompute the local grid from live state: ZIP results (if any) or the
     cached full list when a union filter is active; then filter + sort. */
  refreshLocalResults() {
    let base = null;
    let place = null;
    if (this._zipResults) {
      base = this._zipResults.list;
      place = this._zipResults.place;
    } else if (this._unionFilter && Array.isArray(this._allLocalResources)) {
      base = this._allLocalResources;
    }

    if (!base) {
      // Nothing to show → hide the local section (pre-filter behavior)
      this.clearLocalResources(false);
      return;
    }

    let list = base;
    if (this._unionFilter) {
      const want = this._unionFilter.toLowerCase();
      list = list.filter(r => String(r['Union/Contractor'] || '').trim().toLowerCase() === want);
    }

    // Max-distance cap: client-side only, and only when ZIP results are active.
    // At the top of the slider ("Any distance") no cap is applied.
    if (this._zipResults) {
      const max = Number(this.dom.maxDistanceSlider?.max) || 200;
      if (this._maxDistanceMiles < max) {
        const capMeters = this._maxDistanceMiles * 1609.34;
        list = list.filter(r => r.distance == null || r.distance <= capMeters);
      }
    }

    list = list.slice();
    const hasDist = list.some(r => r.distance != null);
    if ((this._localSort === 'distance' || this._localSort === 'relevance') && hasDist) {
      // Distance = flat proximity sort; Relevance = proximity within each group
      list.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    } else {
      list.sort((a, b) => String(a['Union/Contractor'] || '').localeCompare(String(b['Union/Contractor'] || '')));
    }

    if (this._unionFilter && this.dom.zipStatus && !this._zipResults) {
      this.dom.zipStatus.classList.remove('error');
      this.dom.zipStatus.textContent = tFmt('union.showing', 'Showing {n} resource(s) for {union}.', { n: list.length, union: this._unionFilter });
    }

    this.renderLocalResources(list, place);
  }

  /* Convert a raw backend resource row into a help-card and render local section */
  renderLocalResources(list, place) {
    const grid = this.dom.localGrid;
    const section = this.dom.localSection;
    if (!grid || !section) return;

    const miles = (m) => (m == null ? null : Math.round(m / 1609.34));
    const truthy = (v) => v === true || String(v).toLowerCase() === 'true';

    const cardHTML = (r) => {
      // Topic support rendered as chips (icon + label) instead of a plain sentence
      const TOPIC_META = [
        ['Mental Health', 'fa-brain'],
        ['Alcohol', 'fa-wine-glass'],
        ['Substances/Opioids', 'fa-pills'],
        ['Abuse/Violence', 'fa-shield-halved'],
        ['Gambling', 'fa-dice'],
      ];
      const chips = TOPIC_META
        .filter(([key]) => truthy(r[key]))
        .map(([key, icon]) => `<span class="topic-chip"><i class="fas ${icon}" aria-hidden="true"></i>${t('ltag.' + key, key)}</span>`);

      const actions = [];
      const phone = r['phone number'];
      if (phone && /\d/.test(String(phone))) actions.push(`<a class="chip" href="tel:${String(phone).replace(/[^\d+]/g, '')}"><i class="fas fa-phone"></i> ${phone}</a>`);
      const email = r['email'];
      if (email && String(email).includes('@')) actions.push(`<a class="chip" href="mailto:${email}"><i class="fas fa-envelope"></i> ${t('local.email', 'Email')}</a>`);
      const web = r['web address'];
      if (web && /^https?:\/\//i.test(String(web))) actions.push(`<a class="chip" href="${web}" target="_blank" rel="noopener noreferrer"><i class="fas fa-globe"></i> ${t('local.website', 'Website')}</a>`);

      const d = miles(r.distance);
      const badge = d != null
        ? `<span class="distance-badge"><i class="fas fa-route" aria-hidden="true"></i> ${tFmt('local.milesAway', '~{d} mi away', { d })}</span>`
        : '';
      const address = r['physical address']
        ? `<div class="local-address"><i class="fas fa-location-dot" aria-hidden="true"></i><span>${r['physical address']}</span></div>`
        : '';

      return `
        <div class="help-card local-card">
          <div class="help-card-header">
            <h4>${r['Union/Contractor'] || t('local.fallbackName', 'Local resource')}</h4>
            ${badge}
          </div>
          ${chips.length ? `<div class="topic-chips">${chips.join('')}</div>` : ''}
          ${address}
          ${actions.length ? `<div class="help-actions">${actions.join('')}</div>` : ''}
        </div>`;
    };

    const emptyHTML = `
        <div class="help-card">
          <h4>${t('union.noResults', 'No resources for this filter.')}</h4>
        </div>`;

    if (this._localSort === 'relevance' && list.length) {
      // Relevance view: partition into Recommended / More (never hide)
      const topics = this.computeSelectedTopics();
      const recommended = list.filter(r => this.localTopicMatch(r, topics));
      const others = list.filter(r => !this.localTopicMatch(r, topics));
      grid.innerHTML = this.groupedCardsHTML(recommended, others, cardHTML, emptyHTML);
    } else {
      grid.innerHTML = list.length ? list.map(cardHTML).join('') : emptyHTML;
    }

    // Title reflects the active mode: ZIP proximity vs. union/contractor filter
    const titleEl = section.querySelector('.local-resources-title');
    if (titleEl) {
      titleEl.textContent = place
        ? t('local.title', 'Resources near you')
        : t('union.resultsTitle', 'Union/contractor resources');
    }

    section.style.display = '';
    if (this.dom.nationalTitle) this.dom.nationalTitle.style.display = '';
    this._localList = { list, place }; // cache so a language switch can re-render
    this.applyResourceSearch();
  }

  clearLocalResources(resetStatus = true) {
    if (this.dom.localGrid) this.dom.localGrid.innerHTML = '';
    if (this.dom.localSection) this.dom.localSection.style.display = 'none';
    if (this.dom.nationalTitle) this.dom.nationalTitle.style.display = 'none';
    if (this.dom.zipClearBtn) this.dom.zipClearBtn.style.display = 'none';
    this._localList = null;
    this._zipResults = null;
    // Reset the max-distance slider to its default for the next ZIP search
    this._maxDistanceMiles = 50;
    if (this.dom.maxDistanceSlider) this.dom.maxDistanceSlider.value = '50';
    this.syncSortOptions();
    if (resetStatus && this.dom.zipStatus) { this.dom.zipStatus.textContent = ''; this.dom.zipStatus.classList.remove('error'); }
    // An active union/contractor filter keeps working from the cached full list
    if (this._unionFilter && Array.isArray(this._allLocalResources)) this.refreshLocalResults();
  }

  /* H6: email results to oneself via prefilled mailto: */
  emailResults() {
    const topics = this.computeSelectedTopics();
    const topicList = Array.from(topics).map(tag => tTopic(tag));
    const cards = Array.isArray(this._renderedCards) ? this._renderedCards : [];

    const lines = [];
    lines.push(t('email.line1', 'My Protecting Under the Hard Hat results'));
    lines.push('');
    if (topicList.length) {
      lines.push(tFmt('email.topics', 'Areas my responses pointed to: {topics}', { topics: topicList.join(', ') }));
      lines.push('');
    }
    lines.push(t('email.recommended', 'Recommended resources:'));
    cards.slice(0, 15).forEach(card => {
      const l = this.localizedResource(card);
      lines.push(`- ${l.title}${l.description ? `: ${l.description}` : ''}`);
      l.actions.forEach(a => {
        if (a.href && !a.href.startsWith('#')) lines.push(`    ${a.label}: ${a.href.replace(/^tel:|^sms:|^mailto:/, m => m)}`);
      });
    });
    lines.push('');
    lines.push(t('email.disclaimer', 'This is not a diagnosis. If you are concerned about your wellbeing, consider talking to a qualified professional.'));
    lines.push(`${t('email.survey', 'Survey:')} https://hardhat.njit.edu/questionnaire`);

    const subject = encodeURIComponent(t('email.subject', 'My Wellbeing Survey Results — Protecting Under the Hard Hat'));
    const body = encodeURIComponent(lines.join('\n'));
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  }

  /* H4: exit ramp — show urgent/national resources immediately */
  exitToUrgentResources() {
    // Determine where the user was BEFORE navigating away, so "back" returns them there.
    // Four states:
    //   'summary'  → survey completed (return to the "All Done" summary)
    //   'resume'   → resume-or-start-fresh overlay was showing (return to it)
    //   'start'    → survey not begun yet (begin/mode overlay open; return to begin screen)
    //   'question' → mid-survey (return to the exact question they were on)
    const resumeOpen = document.getElementById('resumeOverlay')?.classList.contains('show');
    const introOpen = document.body.classList.contains('intro-open');
    // Trust LIVE state only: the completion screen is actually on screen, or this
    // instance just submitted. The sessionStorage 'complete' marker can be stale
    // (it used to survive restart()/clearAllProgress()), so a question on screen
    // always wins over any stored flag.
    const questionOnScreen = !!(this.currentId && this.getContainer(this.currentId)?.classList.contains('active'));
    let completed = !questionOnScreen &&
      (this.dom.completion?.classList.contains('active') || this.submitting);

    let origin;
    if (resumeOpen) origin = 'resume';
    else if (completed) origin = 'summary';
    else if (introOpen || !this.currentId) origin = 'start';
    else origin = 'question';

    // Remember the exact overlay that was open so Back restores precisely it
    this._exitOverlay =
      resumeOpen ? 'resumeOverlay'
        : document.getElementById('modeOverlay')?.classList.contains('show') ? 'modeOverlay'
          : document.getElementById('startOverlay')?.classList.contains('show') ? 'startOverlay'
            : null;

    // Remember the exact question to return to for the mid-survey case
    this._exitReturnId = origin === 'question' ? this.currentId : null;

    // Close any overlays that may be open
    ['modeOverlay', 'resumeOverlay', 'startOverlay'].forEach(id => document.getElementById(id)?.classList.remove('show'));
    document.body.classList.remove('intro-open');

    this.renderHelpResources({ all: true, from: origin });
    if (this.dom.helpTitle) this.dom.helpTitle.textContent = t('urgent.title', 'Immediate Support');
    if (this.dom.helpSubtitle) this.dom.helpSubtitle.textContent = t('urgent.subtitle', 'If there is immediate danger, call 911. These resources can help right now — crisis lines are listed first.');
    this._helpShowsUrgent = true;
    this.showHelpPage();
  }

  /* H3: "Was this tool helpful?" slide-up card — help-first timing.
     Arms triggers when the resources page is shown; the card only appears after
     genuine engagement (resource click / ZIP or search use / scrolling + dwell)
     or on exit intent — whichever comes first. Never re-nags (session guard +
     k10:toolHelpful persistence). */
  maybeShowFeedbackPopup() {
    if (this.feedbackShown || this._feedbackArmed) return;
    try { if (localStorage.getItem('k10:toolHelpful')) { this.feedbackShown = true; return; } } catch { }
    this._feedbackArmed = true;

    const cleanups = [];
    const on = (target, evt, fn, opts) => {
      target.addEventListener(evt, fn, opts);
      cleanups.push(() => target.removeEventListener(evt, fn, opts));
    };
    const show = () => {
      if (this.feedbackShown) return;
      this.feedbackShown = true;
      cleanups.forEach(fn => fn());
      if (this._feedbackDwellTimer) clearTimeout(this._feedbackDwellTimer);
      this.dom.feedbackCard?.classList.add('show');
      this.dom.feedbackCard?.setAttribute('aria-hidden', 'false');
    };
    const showSoon = (ms) => setTimeout(show, ms);

    // 1) Engagement: user opened a resource link → they've had a chance to use it
    on(document, 'click', (e) => {
      if (e.target.closest('.help-card .chip')) showSoon(6000);
    }, true);

    // 2) Engagement: used the search box or ZIP lookup
    const toolUse = () => showSoon(12000);
    this.dom.resourceSearch && on(this.dom.resourceSearch, 'input', toolUse, { once: true });
    this.dom.zipSearchBtn && on(this.dom.zipSearchBtn, 'click', toolUse, { once: true });

    // 3) Dwell: 30s on the help page AND the user has scrolled (read through)
    let scrolled = false;
    on(window, 'scroll', () => { scrolled = true; }, { passive: true, once: true });
    const dwellCheck = () => {
      if (this.feedbackShown) return;
      if (scrolled) show();
      else this._feedbackDwellTimer = setTimeout(dwellCheck, 10000);
    };
    this._feedbackDwellTimer = setTimeout(dwellCheck, 30000);

    // 4) Exit intent: cursor leaves toward the top of the viewport
    on(document, 'mouseleave', (e) => {
      if (e.clientY <= 0) show();
    });
  }

  hideFeedbackCard() {
    this.dom.feedbackCard?.classList.remove('show');
    this.dom.feedbackCard?.setAttribute('aria-hidden', 'true');
  }

  answerFeedback(helpful) {
    this.hideFeedbackCard();
    try { localStorage.setItem('k10:toolHelpful', helpful ? 'yes' : 'no'); } catch { }
    // Piggyback on the canonical payload so the answer reaches the backend
    try {
      const payload = this.buildSurveyPayload(this.submitting);
      payload.data.toolHelpful = helpful;
      fetch(SURVEY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => { });
    } catch { }
    showToast(t('feedback.thanks', 'Thanks for the feedback!'));
  }

  renderWhySection() {
    const topicsMap = this.computeSelectedTopicsWithReasons();
    const content = this.dom.whyContent;
    if (!content) return;

    let html = `<p class="why-lead">${t('help.whyLead', 'Your responses indicated the following information:')}</p>`;
    topicsMap.forEach((entry, tag) => {
      const mergedReasons = new Set([...entry.groupReasons, ...entry.reasons]);
      if (mergedReasons.size > 0) {
        const tagName = tTopic(tag);
        const tagLabel = tagName.charAt(0).toUpperCase() + tagName.slice(1);
        html += `<div class="why-group">
          <strong>${tFmt('help.whyGroup', '{tag} Support:', { tag: tagLabel })}</strong>
          <ul>
            ${Array.from(mergedReasons).map(r => `<li>${tReason(r)}</li>`).join('')}
          </ul>
        </div>`;
      }
    });

    content.innerHTML = html.length > 70 ? html : `<p>${t('help.whyGeneral', 'Your responses suggest general wellbeing support.')}</p>`;
  }

  toggleWhySection() {
    const container = this.dom.whyContent;
    const link = this.dom.whyLink;
    if (!container || !link) return;

    const isHidden = container.style.display === 'none' || !container.style.display;
    container.style.display = isHidden ? 'block' : 'none';
    link.textContent = isHidden ? t('help.whyHide', 'Hide details') : t('help.why', 'Why are we showing you these resources?');
  }
  selectedTopicsObject() {
    const set = this.computeSelectedTopics();
    const known = new Set((RESOURCES_DB || []).flatMap(r => Array.isArray(r.tags) ? r.tags.map(t => String(t).toLowerCase()) : []));
    if (!known.size) ['depression', 'alcohol', 'substances', 'abuse'].forEach(t => known.add(t));
    const obj = {}; known.forEach(t => { obj[t] = set.has(t); }); return obj;
  }
  computeUrgencyLevel() {
    const a = this.answers;
    let highest = 'low';
    const urgencyMap = { 'low': 0, 'moderate': 1, 'urgent': 2 };
    const revMap = ['low', 'moderate', 'urgent'];

    Object.keys(a).forEach(qid => {
      const q = this.getQuestion(qid); if (!q) return;
      const val = a[qid];
      const check = (oid) => {
        const o = (q.options || []).find(opt => String(opt.id) === String(oid));
        if (o && o.urgency && urgencyMap[o.urgency] > urgencyMap[highest]) {
          highest = o.urgency;
        }
      };
      if (Array.isArray(val)) val.forEach(check);
      else if (val != null) check(val);
    });
    return highest;
  }

  computeSelectedTopicsWithReasons() {
    const topics = new Map(), removes = new Set(), a = this.answers;
    const getOpt = (q, id) => (q.options || []).find(o => String(o.id) === String(id)) || null;

    const addTopic = (tag, reason, groupReason) => {
      tag = tag.toLowerCase();
      if (!topics.has(tag)) topics.set(tag, { reasons: new Set(), groupReasons: new Set() });
      const entry = topics.get(tag);
      if (groupReason) entry.groupReasons.add(groupReason);
      else if (reason) entry.reasons.add(reason);
    };

    const addTags = (o, q) => {
      const cands = [o?.indicates, o?.topics, o?.topicAdds, o?.tagsAdd];
      const tags = [];
      for (const c of cands) if (Array.isArray(c) && c.length) tags.push(...c.map(x => String(x).toLowerCase()));

      tags.forEach(t => addTopic(t, o.reason, o.groupReason));
    };

    const remTags = (o) => {
      const cands = [o?.indicatesRemove, o?.topicRemoves, o?.tagsRemove];
      for (const c of cands) if (Array.isArray(c) && c.length) return c.map(x => String(x).toLowerCase());
      return [];
    };

    const evalCond = (cond) => {
      if (!cond) return false;
      if (Array.isArray(cond.all)) return cond.all.every(evalCond);
      if (Array.isArray(cond.any)) return cond.any.some(evalCond);
      if (cond.not) return !evalCond(cond.not);
      if (typeof cond.exists === 'string') {
        const v = a[cond.exists];
        return v !== undefined && v !== null && (!Array.isArray(v) || v.length > 0);
      }
      const qid = cond.q || cond.questionId; if (!qid) return false;
      const v = a[qid], arr = Array.isArray(v) ? v : v != null ? [v] : [];
      if (cond.equals !== undefined) return v === cond.equals;
      if (Array.isArray(cond.anyOf)) return arr.some(x => cond.anyOf.includes(x));
      if (cond.notEquals !== undefined) return v !== cond.notEquals;
      return false;
    };

    const rules = Array.isArray(this.config?.topicRules) ? this.config.topicRules
      : Array.isArray(this.config?.settings?.topicRules) ? this.config.settings.topicRules : [];

    rules.forEach(r => {
      const when = r.when || r.if || r.condition; if (!when) return;
      if (evalCond(when)) {
        (r.add || []).forEach(t => addTopic(t, r.reason, r.groupReason));
        (r.remove || []).forEach(t => removes.add(String(t).toLowerCase()));
      }
    });

    Object.keys(a).forEach(qid => {
      const q = this.getQuestion(qid); if (!q) return;
      const val = a[qid];
      if (q.type === 'single' && typeof val === 'string') {
        const o = getOpt(q, val); if (!o) return;
        addTags(o, q);
        remTags(o).forEach(t => removes.add(t));
      }
      if (q.type === 'multiple' && Array.isArray(val)) {
        const ex = new Set((q.exclusiveOptionIds || []).map(String));
        const isExcl = (id) => ex.has(String(id)) || !!getOpt(q, id)?.exclusive;
        const onlyExcl = val.length > 0 && val.every(isExcl);
        if (onlyExcl) {
          val.forEach(id => {
            const o = getOpt(q, id); if (!o) return;
            remTags(o).forEach(t => removes.add(t));
          });
          return;
        }
        val.forEach(id => {
          if (isExcl(id)) return;
          const o = getOpt(q, id); if (!o) return;
          addTags(o, q);
          remTags(o).forEach(t => removes.add(t));
        });
      }
    });

    removes.forEach(t => topics.delete(t));
    if (topics.size === 0) {
      (this.settings.defaultTopics || []).forEach(t => addTopic(t, null, null));
    }
    return topics;
  }

  /* Helpers for consistent question numbering across all payloads */
  getQuestionPrefix(qId) {
    const q = this.getQuestion(qId);
    if (!q) return qId;
    const num = String(q.questionNumber).padStart(2, '0');
    return `${num}_${qId}`;
  }

  buildNumberedAnswers(answers) {
    const result = {};
    for (const [id, val] of Object.entries(answers)) {
      result[this.getQuestionPrefix(id)] = val;
    }
    return result;
  }

  computeSelectedTopics() {
    return new Set(this.computeSelectedTopicsWithReasons().keys());
  }
  helpCopyFromResponses(topicsSet) {
    const level = this.computeUrgencyLevel();
    const list = Array.from(topicsSet).map(tag => tTopic(tag));
    const and = t('topics.and', ' and ');
    const human = list.length ? list.join(', ').replace(/, ([^,]*)$/, `${and}$1`) : t('topics.general', 'general wellbeing');
    if (level === 'urgent') return {
      title: t('copy.urgentTitle', 'Urgent Support Options'),
      subtitle: tFmt('copy.urgentSub', 'Based on your responses, here are resources for {topics}. If there’s immediate danger, call your local emergency number.', { topics: human })
    };
    if (level === 'moderate') return {
      title: t('copy.modTitle', 'Support and Self‑Help Resources'),
      subtitle: tFmt('copy.modSub', 'Here are supportive resources for {topics}. Consider reaching out for professional advice if things feel tough.', { topics: human })
    };
    return {
      title: t('copy.lowTitle', 'Wellbeing Tips & Helpful Resources'),
      subtitle: tFmt('copy.lowSub', 'You reported lower concern. Explore these resources for {topics}, and keep them handy if you ever need extra support.', { topics: human })
    };
  }
  showHelpPage() {
    const c = this.dom.completion, h = this.dom.help; if (!h) return;
    c?.classList.remove('active'); if (c) c.style.display = 'none';

    if (this.dom.root) this.dom.root.style.display = 'none';

    // Guarantee the grid is populated every time the page is shown.
    // (Re-entry after Back used to leave a stale/empty grid.)
    if (!this.dom.helpGrid || !this.dom.helpGrid.children.length) {
      const last = this._lastHelpRender || { all: true, from: this.helpOrigin };
      this.renderHelpResources(last);
    }

    h.style.display = 'flex'; h.classList.add('active');
    this.dom.backBtn?.style?.setProperty('display', 'none');
    document.querySelector('.container')?.scrollIntoView({ behavior: 'smooth' });

    // H3: ask for feedback once results/resources are shown
    this.maybeShowFeedbackPopup();
  }
  backToSummary() {
    const h = this.dom.help; if (!h) return;
    h?.classList.remove('active'); if (h) h.style.display = 'none';
    this._helpShowsUrgent = false;

    if (this.helpOrigin === 'resume') {
      // Refresh with in-progress data → reopen the resume/start-fresh overlay.
      // Keep the current question rendered BEHIND the overlay so it matches the
      // fresh-load state (initUI shows the question under the resume modal).
      // Previously the root was display:none here, leaving a blank screen
      // behind the overlay until the user pressed Resume.
      const step = this.currentId || localStorage.getItem(this.storageKeys.current);
      if (step && step !== 'complete' && this.getContainer(step)) {
        this.showQuestion(step, { pushHistory: false });
      } else if (this.dom.root) {
        this.dom.root.style.display = '';
      }
      const resumeOverlay = document.getElementById('resumeOverlay');
      resumeOverlay?.classList.add('show');
      document.body.classList.add('intro-open');
      this.dom.backBtn?.style?.setProperty('display', 'none');
    } else if (this.helpOrigin === 'start') {
      // Survey never begun → reopen the exact overlay that was open when the
      // user left (mode picker or begin screen). Restore the questions root
      // underneath it (matching the fresh-load state): leaving it display:none
      // made Begin land on an empty screen, since closing the overlay never
      // re-shows the root.
      if (this.dom.root) this.dom.root.style.display = '';
      const overlayId = (this._exitOverlay === 'modeOverlay') ? 'modeOverlay' : 'startOverlay';
      document.getElementById(overlayId)?.classList.add('show');
      document.body.classList.add('intro-open');
      this.dom.backBtn?.style?.setProperty('display', 'none');
    } else if (this.helpOrigin === 'question') {
      // Mid-survey → return to the exact question the user was on.
      // showQuestion cleanly re-shows root and hides completion/help (no stacking).
      const returnId = this._exitReturnId || this.currentId;
      if (returnId) {
        this.showQuestion(returnId, { pushHistory: false });
      } else if (this.dom.root) {
        this.dom.root.style.display = '';
      }
    } else {
      // Completed → show the summary/completion screen (and never a stacked question)
      if (this.dom.root) {
        this.dom.root.style.display = '';
        this.dom.root.querySelectorAll('.question-container').forEach(c => { c.classList.remove('active', 'leaving'); c.style.display = 'none'; });
      }
      const c = this.dom.completion; if (!c) return;
      c.style.display = 'block'; c.classList.add('active');
      this.dom.backBtn?.style?.removeProperty('display');
    }

    this._exitOverlay = null;
    document.querySelector('.container')?.scrollIntoView({ behavior: 'smooth' });
  }

  buildSurveyPayload(completed = false) {
    const query = this.getStoredQuery();
    const gps = getStoredGPS();
    const metadata = {
      userAgent: navigator.userAgent,
      screenResolution: `${window.screen.width}x${window.screen.height}`,
      viewportSize: `${window.innerWidth}x${window.innerHeight}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffset: new Date().getTimezoneOffset(),
      language: getLanguage(),
      platform: navigator.platform
    };

    // Pre-initialize all questions to null so unanswered ones appear explicitly.
    // The backend can find the last non-null entry to determine where user stopped.
    const allAnswers = {};
    for (const q of this.questions) {
      allAnswers[this.getQuestionPrefix(q.id)] = null;
    }
    // Overlay actual answers
    const filled = this.buildNumberedAnswers(this.answers);
    Object.assign(allAnswers, filled);

    return {
      data: {
        timestamp: new Date().toISOString(),
        surveyTitle: this.config.title,
        surveyVersion: this.config.version,
        mode: this.getStoredMode(),
        site_id: query.site_id || query.site || null,
        query,
        gps,
        answers: allAnswers,
        clickedResources: [],
        deviceID: this.deviceID,
        sessionID: this.sessionID,
        metadata,
        completed,
        isTest: query.test === 'true' || query.test === 'yes',
        isBranching: query.branching !== 'false' && query.branching !== 'no'
      }
    };
  }

  async handleSubmit() {
    if (this.submitting) return; // double-submit guard

    // Validate first; if anything missing, keep user in flow and do not lock UI
    const visible = this.getVisibleIds();
    const byId = new Map(this.questions.map(q => [q.id, q]));
    for (const id of visible) {
      const q = byId.get(id); if (!q) continue;
      const v = this.answers[id];
      const has = q.type === 'single' ? typeof v === 'string' : Array.isArray(v) && v.length > 0;
      if (q.required && !has) { showToast(t('toast.required', 'Please answer all required questions')); this.isTransitioning = false; this.showQuestion(id, { pushHistory: true }); return; }
      if (q.type === 'multiple' && this.settings.requireNextOnMultiple && !has) { showToast(t('toast.selectOne', 'Please select at least one option')); this.isTransitioning = false; this.showQuestion(id, { pushHistory: true }); return; }
    }

    // Lock UI and move to completion immediately
    this.submitting = true;
    try { sessionStorage.setItem(this.storageKeys.current, 'complete'); } catch { }
    this.showCompletion(); // show "All done" right away

    // Save local copy (best effort)
    try {
      const key = this.storageKeys.submissions;
      const raw = localStorage.getItem(key);
      const all = raw ? JSON.parse(raw) : [];
      all.push({ timestamp: new Date().toISOString(), answers: { ...this.answers } });
      localStorage.setItem(key, JSON.stringify(all));
    } catch { }

    // Post to backend in background
    const payload = this.buildSurveyPayload(true); // Pass true for completed
    try {
      await submitSurvey(payload);
      showToast(t('toast.submitted', 'Submitted!'));
      // Clear progress on successful submit
      this.clearAllProgress();
    }
    catch (e) { console.error('Submit error:', e); showToast(t('toast.submitFailed', 'Submit failed (saved locally).')); }
  }

  clearAllProgress() {
    try {
      localStorage.removeItem(this.storageKeys.answers);
      localStorage.removeItem(this.storageKeys.current);
      localStorage.removeItem(this.storageKeys.mode);
      localStorage.removeItem(this.storageKeys.history);
    } catch { }
    // Also clear the session 'complete' marker so a finished attempt can never
    // leak into a fresh one (fixes "survey thinks it's already finished").
    try { sessionStorage.removeItem(this.storageKeys.current); } catch { }
  }

  /* Completion + restart */
  showCompletion() {
    // Mutual exclusivity: completion never co-renders with questions or help
    this.dom.root.querySelectorAll('.question-container').forEach(c => { c.classList.remove('active'); c.style.display = 'none'; });
    if (this.dom.help) { this.dom.help.classList.remove('active'); this.dom.help.style.display = 'none'; }
    if (this.dom.completion) { this.dom.completion.style.display = 'block'; this.dom.completion.classList.add('active'); }
    if (this.dom.backBtn) this.dom.backBtn.style.display = 'none';
  }
  restart() {
    this.answers = {}; this.currentId = null; this.navHistory = [];
    this.submitting = false;
    this.navCooldownUntil = 0;
    this.interactLockUntil = 0;
    this.isTransitioning = false;
    if (this._interactUnlockTimer) { clearTimeout(this._interactUnlockTimer); this._interactUnlockTimer = null; }

    this.clearAllProgress();

    // Regenerate session ID only on explicit restarts
    try { localStorage.removeItem(this.storageKeys.sessionId); } catch { }
    this.sessionID = crypto.randomUUID();
    try { localStorage.setItem(this.storageKeys.sessionId, this.sessionID); } catch { }

    this.dom.root.querySelectorAll('.option').forEach(o => o.classList.remove('selected'));
    if (this.dom.completion) { this.dom.completion.style.display = 'none'; this.dom.completion.classList.remove('active'); }
    if (this.dom.help) { this.dom.help.style.display = 'none'; this.dom.help.classList.remove('active'); }
    if (this.dom.progressBar) this.dom.progressBar.style.width = '0%';

    const visible = this.getVisibleIds();
    if (!visible.length) return this.showCompletion();
    this.currentId = visible[0];
    this.showQuestion(this.currentId, { pushHistory: true });
  }
}
document.addEventListener('DOMContentLoaded', async () => {
  // capturing all query params (e.g., ?site=123) into sessionStorage
  captureQueryParams();

  // H8: language toggle wiring (UI only; English content for now)
  document.getElementById('langMenuBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLangMenu();
  });
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => setSelectedLanguage(btn.dataset.lang));
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#langToggle')) closeLangMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLangMenu();
  });
  setSelectedLanguage(getSelectedLanguage());

  const cookieOverlay = document.getElementById('cookieOverlay');
  const cookiesAccepted = () => { try { return localStorage.getItem('k10:cookiesAccepted') === 'yes'; } catch { return false; } };
  const showCookieIfNeeded = () => { if (!cookiesAccepted()) cookieOverlay?.classList.add('show'); };

  const startOverlay = document.getElementById('startOverlay');
  const startBegin = document.getElementById('startBegin');
  const startDismiss = document.getElementById('startDismiss');
  const startResources = document.getElementById('startResources');
  const startMedia = document.getElementById('startMedia');

  const modeOverlay = document.getElementById('modeOverlay');
  const modeSelf = document.getElementById('modeSelf');
  const modeOther = document.getElementById('modeOther');

  // Welcome banner visuals
  if (startMedia) {
    startMedia.style.backgroundImage = "url('../static/assets/logos/PUTHH-Logo.png')";
    startMedia.style.backgroundSize = 'contain';
    startMedia.style.backgroundRepeat = 'no-repeat';
    startMedia.style.backgroundPosition = 'center';
  }

  const openIntro = () => { document.body.classList.add('intro-open'); startOverlay?.classList.add('show'); };
  const closeIntro = persist => {
    if (persist) { try { localStorage.setItem('dyn:introSeen', 'yes'); } catch { } }
    startOverlay?.classList.remove('show');
    document.body.classList.remove('intro-open');
  };

  const openMode = () => { document.body.classList.add('intro-open'); modeOverlay?.classList.add('show'); };
  const closeMode = () => { modeOverlay?.classList.remove('show'); };

  const proceedFromMode = (modeValue) => {
    try { localStorage.setItem('dyn:mode', modeValue); } catch { }
    closeMode();
    openIntro();
  };

  modeSelf?.addEventListener('click', () => proceedFromMode('self'));
  modeOther?.addEventListener('click', () => proceedFromMode('someoneElse'));

  startBegin?.addEventListener('click', async () => {
    closeIntro(true);
    showCookieIfNeeded();

    // Ask for GPS once the user starts
    await retryGPS(); // better than a single strict attempt

    // Send "survey started" to server using canonical payload
    try {
      const payload = window.survey.buildSurveyPayload(false);
      submitSurvey(payload).catch(e => console.error('Failed to notify server of start:', e));
    } catch (err) { }

    try { const step = localStorage.getItem('dyn:currentId'); if (!step) window.survey?.restart?.(); } catch { }
    document.querySelector('.container')?.scrollIntoView({ behavior: 'smooth' });
  });
  startDismiss?.addEventListener('click', () => { closeIntro(false); showCookieIfNeeded(); });

  startResources?.addEventListener('click', () => {
    closeIntro(false);
    showCookieIfNeeded();
    if (!window.survey) return showToast(t('toast.loadingResources', 'Loading resources…'));
    window.survey.renderHelpResources({ all: true, from: 'start' });
    window.survey.showHelpPage();
  });

  await loadResourcesJSON();

  let config;
  try { config = await loadQuestionsJSON(); }
  catch (e) { console.error(e); showToast(t('toast.loadFailed', 'Failed to load survey questions.')); return; }

  window.survey = new DynamicSurvey(config);

  // Resume / Mode logic
  const resumeOverlay = document.getElementById('resumeOverlay');
  const resumeBtn = document.getElementById('resumeBtn');
  const startFreshBtn = document.getElementById('startFreshBtn');

  const hasProgress = () => {
    try {
      const ans = JSON.parse(localStorage.getItem('dyn:answers') || '{}');
      const step = localStorage.getItem('dyn:currentId');
      return Object.keys(ans).length > 0 && step && step !== 'complete';
    } catch { return false; }
  };

  const closeResume = () => { resumeOverlay?.classList.remove('show'); document.body.classList.remove('intro-open'); };

  if (hasProgress()) {
    document.body.classList.add('intro-open');
    resumeOverlay?.classList.add('show');
    closeMode();
  } else {
    openMode();
  }

  resumeBtn?.addEventListener('click', () => {
    closeResume();
    const step = localStorage.getItem('dyn:currentId');
    if (step && step !== 'complete') {
      window.survey.showQuestion(step, { pushHistory: true });
    }
  });

  startFreshBtn?.addEventListener('click', () => {
    window.survey.clearAllProgress();

    // Regenerate session ID for fresh starts
    try { localStorage.removeItem('dyn:sessionId'); } catch { }
    window.survey.sessionID = crypto.randomUUID();
    try { localStorage.setItem('dyn:sessionId', window.survey.sessionID); } catch { }

    closeResume();
    openMode();
    window.survey.initUI();
  });
});
