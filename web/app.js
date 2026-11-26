/* ============================================================
   Train Count — front-end (vanilla JS, no build step)
   ============================================================ */
(function () {
  'use strict';

  var J = window.Jalali;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var viewEl = $('#view');

  var FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  function fa(value) {
    return String(value).replace(/\d/g, function (d) { return FA_DIGITS[+d]; });
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function icon(name, size) {
    return '<svg width="' + (size || 18) + '" height="' + (size || 18) + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }
  function initial(name) {
    var t = String(name || '?').trim();
    return t ? t[0] : '?';
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtTime(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
    } catch (e) {
      return '';
    }
  }
  function todayStr() {
    var t = J.today();
    return J.format(t.jy, t.jm, t.jd);
  }
  function shiftDate(dateStr, delta) {
    var p = J.parse(dateStr);
    var n = J.addDays(p.jy, p.jm, p.jd, delta);
    return J.format(n.jy, n.jm, n.jd);
  }

  /* ------------------------------------------------------------- api layer */

  async function api(path, options) {
    var opts = options || {};
    var res;
    try {
      res = await fetch(path, {
        method: opts.method || 'GET',
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        credentials: 'same-origin',
      });
    } catch (err) {
      throw new Error('ارتباط با سرور برقرار نشد. اتصال اینترنت یا سرور را بررسی کنید.');
    }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      if (res.status === 401 && path !== '/api/login') {
        state.user = null;
        showLogin();
      }
      throw new Error((data && data.error) || 'خطای سرور (' + res.status + ')');
    }
    return data;
  }

  /* ---------------------------------------------------------------- toasts */

  var toastRoot = $('#toast-root');
  function toast(message, kind) {
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' toast--' + kind : '');
    el.innerHTML = icon(kind === 'bad' ? 'alert' : 'check', 16) + '<span>' + esc(message) + '</span>';
    while (toastRoot.children.length >= 3) toastRoot.removeChild(toastRoot.firstElementChild);
    toastRoot.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(function () { el.remove(); }, 260);
    }, 2600);
  }

  /* ----------------------------------------------------------------- modal */

  var modalRoot = $('#modal-root');
  var modalStack = [];

  function openModal(html) {
    modalRoot.innerHTML = '<div class="overlay" data-act="overlay"><div class="modal" role="dialog" aria-modal="true">' + html + '</div></div>';
    document.body.style.overflow = 'hidden';
    var focusable = modalRoot.querySelector('input, button, select, textarea');
    if (focusable) setTimeout(function () { focusable.focus(); }, 60);
  }
  function closeModal() {
    modalRoot.innerHTML = '';
    document.body.style.overflow = '';
    modalStack = [];
  }

  /* ----------------------------------------------------------------- state */

  var state = {
    user: null,
    students: [],
    day: null,
    dayDate: null,
    pending: new Map(),   // studentId -> 'present' | 'absent' | 'clear'
    month: null,
    calendar: null,
    search: '',
    extraQuery: '',
  };

  /* -------------------------------------------------------------- particles */

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var use = theme === 'dark' ? 'sun' : 'moon';
    ['#theme-toggle', '#theme-toggle-m'].forEach(function (sel) {
      var btn = $(sel);
      if (btn) btn.innerHTML = icon(use, 18);
    });
    var meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0d0f1a' : '#f5f6fb');
  }
  function initTheme() {
    var saved = localStorage.getItem('tc-theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved || (prefersDark ? 'dark' : 'light'));
  }
  function toggleTheme() {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem('tc-theme', next);
    applyTheme(next);
  }

  /* ----------------------------------------------------------------- login */

  var loginEl = $('#login');
  var appEl = $('#app');
  var loginErrorEl = $('#login-error');
  var loginForm = $('#login-form');

  function showLogin() {
    loginEl.hidden = false;
    appEl.hidden = true;
    loginErrorEl.hidden = true;
    closeModal();
    var u = $('#username');
    if (u) setTimeout(function () { u.focus(); }, 80);
  }

  function showApp() {
    loginEl.hidden = true;
    appEl.hidden = false;
    var name = state.user ? state.user.name : '—';
    $('#user-name').textContent = name;
    $('#user-handle').textContent = state.user ? '@' + state.user.username : '—';
    $('#user-avatar').textContent = initial(name);
    var t = J.today();
    $('#topbar-day').textContent = J.WEEKDAY_NAMES[J.weekday(t.jy, t.jm, t.jd)] + ' ' + fa(t.jd) + ' ' + J.MONTH_NAMES[t.jm - 1];
    $('#topbar-sub').textContent = 'سال ' + fa(t.jy);
    applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
    render();
  }

  loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var username = $('#username').value.trim();
    var password = $('#password').value;
    var btn = $('#login-submit');
    if (!username || !password) {
      loginErrorEl.textContent = 'نام کاربری و رمز عبور را وارد کنید.';
      loginErrorEl.hidden = false;
      return;
    }
    btn.disabled = true;
    loginErrorEl.hidden = true;
    try {
      var res = await api('/api/login', { method: 'POST', body: { username: username, password: password } });
      state.user = res.user;
      showApp();
      toast('خوش آمدید، ' + res.user.name, 'ok');
    } catch (err) {
      loginErrorEl.textContent = err.message;
      loginErrorEl.hidden = false;
      $('#password').value = '';
      $('#password').focus();
    } finally {
      btn.disabled = false;
    }
  });

  $('#peek').addEventListener('click', function () {
    var input = $('#password');
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    this.textContent = show ? 'پنهان' : 'نمایش';
  });

  async function logout() {
    try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    state.user = null;
    state.pending.clear();
    showLogin();
    toast('از حساب خارج شدید.');
  }

  /* ---------------------------------------------------------------- router */

  function parseRoute() {
    var raw = location.hash.replace(/^#\/?/, '');
    var parts = raw.split('/').filter(Boolean);
    if (parts[0] === 'students') return { name: 'students' };
    if (parts[0] === 'calendar') {
      var d = parts[1] && J.parse(parts[1]);
      return { name: 'calendar', date: d ? parts[1] : null };
    }
    if (parts[0] === 'day' && parts[1] && J.parse(parts[1])) return { name: 'day', date: parts[1] };
    return { name: 'day', date: todayStr() };
  }

  function setActiveNav(route) {
    var key = route.name === 'students' ? 'students' : route.name === 'calendar' ? 'calendar' : 'today';
    document.querySelectorAll('.navlink, .tablink').forEach(function (el) {
      el.classList.toggle('is-active', el.dataset.route === key);
    });
  }

  var navigating = false;

  async function render() {
    if (!state.user) return;
    var route = parseRoute();
    setActiveNav(route);
    // never lose unsaved marks: flush them before showing another day/page
    if (state.pending.size > 0 && (route.name !== 'day' || route.date !== state.dayDate)) {
      try { await flushPending(); } catch (e) { return; }
    }
    try {
      if (route.name === 'students') await renderStudents();
      else if (route.name === 'calendar') await renderCalendar(route.date);
      else await renderDay(route.date);
    } catch (err) {
      viewEl.innerHTML = '<div class="card"><div class="empty">' +
        '<div class="empty__icon">' + icon('alert', 24) + '</div>' +
        '<strong>مشکلی پیش آمد</strong><p>' + esc(err.message) + '</p>' +
        '<button class="btn btn--sm" data-act="reload">تلاش دوباره</button></div></div>';
    }
  }

  function navigate(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  window.addEventListener('hashchange', function () {
    if (!state.user) return;
    render();
  });

  /* -------------------------------------------------------------- day view */

  function effectiveStatus(row) {
    if (state.pending.has(row.id)) {
      var p = state.pending.get(row.id);
      return p === 'clear' ? 'none' : p;
    }
    return row.status;
  }

  function effectiveSummary() {
    var s = { total: 0, present: 0, absent: 0, unmarked: 0, extra: 0 };
    (state.day ? state.day.students : []).forEach(function (row) {
      s.total += 1;
      if (row.extra) s.extra += 1;
      var st = effectiveStatus(row);
      if (st === 'present') s.present += 1;
      else if (st === 'absent') s.absent += 1;
      else s.unmarked += 1;
    });
    return s;
  }

  function rowHTML(row) {
    var st = effectiveStatus(row);
    var cls = st === 'present' ? 'is-present' : st === 'absent' ? 'is-absent' : '';
    var meta = [];
    if (row.cls) meta.push('<span>' + esc(row.cls) + '</span>');
    if (row.extra) meta.push('<span class="chip chip--warn" style="padding:1px 7px">خارجی</span>');
    if (row.status !== 'none' && row.markedAt) meta.push('<span>' + icon('clock', 11) + '</span><span>' + fa(fmtTime(row.markedAt)) + '</span>');
    if (!row.cls && !row.extra && row.status === 'none') meta.push('<span>در برنامه امروز</span>');

    return '' +
      '<div class="row ' + cls + '" data-row="' + esc(row.id) + '">' +
        '<span class="row__avatar">' + esc(initial(row.name)) + '</span>' +
        '<div class="row__info">' +
          '<div class="row__name">' + esc(row.name) + '</div>' +
          '<div class="row__meta">' + meta.join('<span class="dot"></span>') + '</div>' +
        '</div>' +
        '<div class="seg" role="group" aria-label="وضعیت ' + esc(row.name) + '">' +
          '<button class="seg__btn" type="button" data-act="mark" data-id="' + esc(row.id) + '" data-status="present" aria-pressed="' + (st === 'present') + '">حاضر</button>' +
          '<button class="seg__btn" type="button" data-act="mark" data-id="' + esc(row.id) + '" data-status="absent" aria-pressed="' + (st === 'absent') + '">غایب</button>' +
        '</div>' +
        (row.extra
          ? '<button class="row__remove" type="button" data-act="remove-extra" data-id="' + esc(row.id) + '" title="حذف از حضور خارجی">' + icon('x', 15) + '</button>'
          : '<span class="row__remove" style="visibility:hidden;border-color:transparent"></span>') +
      '</div>';
  }

  function emptyRosterHTML() {
    return '' +
      '<div class="empty">' +
        '<div class="empty__icon">' + icon('calendar', 24) + '</div>' +
        '<strong>برای این روز کسی در برنامه نیست</strong>' +
        '<p>می‌توانید روزهای هفتگی شاگردان را در بخش «شاگردان» تنظیم کنید یا با دکمه «حضور خارجی» شاگردی را برای همین روز اضافه کنید.</p>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:4px">' +
          '<button class="btn btn--sm" data-act="open-extra">' + icon('swap', 15) + ' حضور خارجی</button>' +
          '<a class="btn btn--sm btn--ghost" href="#/students">مدیریت شاگردان</a>' +
        '</div>' +
      '</div>';
  }

  function rosterHTML() {
    var rows = state.day ? state.day.students : [];
    if (!rows.length) return emptyRosterHTML();
    return '<div class="roster">' + rows.map(rowHTML).join('') + '</div>';
  }

  function statsHTML() {
    var s = effectiveSummary();
    return '' +
      '<div class="statgrid">' +
        '<div class="stat"><span class="stat__value" id="stat-total">' + fa(s.total) + '</span><span class="stat__label">کل امروز</span></div>' +
        '<div class="stat stat--ok"><span class="stat__value" id="stat-present">' + fa(s.present) + '</span><span class="stat__label">حاضر</span></div>' +
        '<div class="stat stat--bad"><span class="stat__value" id="stat-absent">' + fa(s.absent) + '</span><span class="stat__label">غایب</span></div>' +
        '<div class="stat stat--brand"><span class="stat__value" id="stat-unmarked">' + fa(s.unmarked) + '</span><span class="stat__label">ثبت‌نشده</span></div>' +
      '</div>';
  }

  function actionbarHTML() {
    var dirty = state.pending.size;
    var note;
    if (dirty) note = fa(dirty) + ' تغییر ثبت‌نشده';
    else if (state.day && state.day.updatedAt) note = 'آخرین ثبت: ' + fa(fmtTime(state.day.updatedAt)) + (state.day.updatedBy ? ' — ' + state.day.updatedBy : '');
    else note = 'هنوز حضوری برای این روز ثبت نشده';
    return '' +
      '<div class="actionbar">' +
        '<p class="actionbar__note' + (dirty ? ' is-dirty' : '') + '">' + icon(dirty ? 'alert' : 'clock', 14) + '<span>' + note + '</span></p>' +
        '<div class="actionbar__actions">' +
          '<button class="btn" type="button" data-act="open-extra">' + icon('swap', 16) + ' حضور خارجی</button>' +
          '<button class="btn btn--primary" type="button" data-act="save-marks"' + (dirty ? '' : ' disabled') + '>' + icon('check', 16) + ' ثبت حضور</button>' +
        '</div>' +
      '</div>';
  }

  function dayHTML(day) {
    var isToday = day.date === todayStr();
    var title = isToday ? 'ثبت حضور امروز' : 'ثبت حضور';
    return '' +
      '<div class="page-head">' +
        '<div class="page-head__titles">' +
          '<h2>' + title + '</h2>' +
          '<p>' + esc(day.label) + (isToday ? ' • امروز' : '') + '</p>' +
        '</div>' +
        '<div class="datenav">' +
          '<button class="iconbtn" type="button" data-act="day-prev" title="روز قبل" aria-label="روز قبل">' + icon('right', 16) + '</button>' +
          '<button class="btn btn--sm btn--ghost" type="button" data-act="day-today"' + (isToday ? ' disabled' : '') + '>امروز</button>' +
          '<button class="iconbtn" type="button" data-act="day-next" title="روز بعد" aria-label="روز بعد">' + icon('left', 16) + '</button>' +
        '</div>' +
      '</div>' +
      statsHTML() +
      '<div class="card">' +
        '<div class="card__head">' +
          '<div class="card__title">' + icon('users', 17) + ' لیست حضور <span class="chip">' + fa(day.students.length) + ' نفر</span></div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            (day.students.length ? '<button class="btn btn--sm" type="button" data-act="all-present">همه حاضر</button>' : '') +
            '<button class="btn btn--sm btn--ghost" type="button" data-act="clear-marks"' + (state.pending.size ? '' : ' hidden') + '>لغو تغییرات</button>' +
          '</div>' +
        '</div>' +
        '<div class="card__body" id="roster-wrap">' + rosterHTML() + '</div>' +
      '</div>' +
      actionbarHTML();
  }

  async function renderDay(date) {
    var day = await api('/api/day?date=' + encodeURIComponent(date));
    state.day = day;
    state.dayDate = day.date;
    state.pending.clear();
    viewEl.innerHTML = dayHTML(day);
    var t = J.parse(day.date);
    $('#topbar-day').textContent = day.weekdayName + ' ' + fa(t.jd) + ' ' + J.MONTH_NAMES[t.jm - 1];
    $('#topbar-sub').textContent = 'سال ' + fa(t.jy);
  }

  function repaintRow(id) {
    var row = state.day.students.filter(function (r) { return r.id === id; })[0];
    var el = viewEl.querySelector('[data-row="' + id + '"]');
    if (!row || !el) return;
    var st = effectiveStatus(row);
    el.className = 'row ' + (st === 'present' ? 'is-present' : st === 'absent' ? 'is-absent' : '');
    el.querySelectorAll('.seg__btn').forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.dataset.status === st));
    });
  }

  function repaintSummaryAndBar() {
    var s = effectiveSummary();
    var set = function (id, val) { var el = $('#' + id); if (el) el.textContent = fa(val); };
    set('stat-total', s.total);
    set('stat-present', s.present);
    set('stat-absent', s.absent);
    set('stat-unmarked', s.unmarked);
    var bar = viewEl.querySelector('.actionbar');
    if (bar) bar.outerHTML = actionbarHTML();
    var clearBtn = viewEl.querySelector('[data-act="clear-marks"]');
    if (clearBtn) clearBtn.toggleAttribute('hidden', state.pending.size === 0);
  }

  function markStudent(id, status) {
    var row = state.day.students.filter(function (r) { return r.id === id; })[0];
    if (!row) return;
    var current = effectiveStatus(row);
    var next;
    if (current === status) next = 'none';        // toggling the same status unmarks it
    else next = status;

    var original = row.status;
    if (next === 'none') {
      if (original === 'none') state.pending.delete(id);
      else state.pending.set(id, 'clear');
    } else if (next === original) {
      state.pending.delete(id);
    } else {
      state.pending.set(id, next);
    }
    repaintRow(id);
    repaintSummaryAndBar();
  }

  async function flushPending() {
    if (!state.pending.size || !state.dayDate) return null;
    var marks = {};
    state.pending.forEach(function (status, id) { marks[id] = status; });
    try {
      var day = await api('/api/day/marks', { method: 'POST', body: { date: state.dayDate, marks: marks } });
      state.day = day;
      state.pending.clear();
      return day;
    } catch (err) {
      toast(err.message, 'bad');
      throw err;
    }
  }

  async function saveMarks() {
    if (!state.pending.size) return;
    var btn = viewEl.querySelector('[data-act="save-marks"]');
    if (btn) btn.disabled = true;
    try {
      var day = await flushPending();
      if (day && state.dayDate === day.date) {
        viewEl.innerHTML = dayHTML(day);
        toast('حضور ' + fa(day.summary.present) + ' نفر ثبت شد', 'ok');
      }
    } catch (err) {
      if (btn) btn.disabled = false;
    }
  }

  /* ---------------------------------------------------------- extra modal */

  async function openExtraModal() {
    state.extraQuery = '';
    var students = (await api('/api/students')).students;
    var day = state.day;
    openModal(
      '<div class="modal__head">' +
        '<div><h3>حضور خارجی</h3><p>شاگردی که در برنامه امروز نیست را به این روز اضافه کنید — ' + esc(day ? day.label : '') + '</p></div>' +
        '<button class="iconbtn" type="button" data-act="close-modal" aria-label="بستن">' + icon('x', 16) + '</button>' +
      '</div>' +
      '<div class="modal__body">' +
        '<div class="searchbox">' + icon('search', 17) + '<input type="search" placeholder="جستجوی شاگرد…" data-role="extra-filter" /></div>' +
        '<div class="picker" id="extra-list"></div>' +
      '</div>' +
      '<div class="modal__foot">' +
        '<button class="btn btn--grow" type="button" data-act="close-modal">بستن</button>' +
      '</div>'
    );
    state.extraStudents = students;
    paintExtraList();
  }

  function paintExtraList() {
    var wrap = $('#extra-list');
    if (!wrap) return;
    var day = state.day;
    var inDay = {};
    (day ? day.students : []).forEach(function (row) { inDay[row.id] = row; });
    var q = state.extraQuery.trim().toLowerCase();
    var students = (state.extraStudents || []).filter(function (s) {
      return !q || s.name.toLowerCase().indexOf(q) >= 0 || (s.cls || '').toLowerCase().indexOf(q) >= 0;
    });

    if (!students.length) {
      wrap.innerHTML = '<div class="empty" style="padding:26px 10px"><strong>شاگردی پیدا نشد</strong><p>می‌توانید از صفحه «شاگردان» شاگرد جدید اضافه کنید.</p></div>';
      return;
    }

    wrap.innerHTML = students.map(function (s) {
      var row = inDay[s.id];
      var scheduled = row && !row.extra;
      var added = row && row.extra;
      var cls = added ? ' is-added' : '';
      var hint = scheduled ? 'در برنامه امروز' : added ? 'افزوده شد — حذف' : s.active ? 'افزودن' : 'غیرفعال';
      return '<button class="pick' + cls + '" type="button" data-act="pick-extra" data-id="' + esc(s.id) + '"' + (scheduled ? ' disabled' : '') + '>' +
        '<span class="row__avatar" style="width:32px;height:32px;border-radius:10px;font-size:13px">' + esc(initial(s.name)) + '</span>' +
        '<span class="pick__name">' + esc(s.name) + (s.cls ? ' <span class="daytag">' + esc(s.cls) + '</span>' : '') + '</span>' +
        '<span class="pick__hint">' + (scheduled || added ? '' : icon('plus', 14)) + '</span>' +
        '<span class="pick__hint">' + esc(hint) + '</span>' +
      '</button>';
    }).join('');
  }

  async function toggleExtra(studentId) {
    var inDay = (state.day ? state.day.students : []).filter(function (r) { return r.id === studentId; })[0];
    var action = inDay && inDay.extra ? 'remove' : 'add';
    try {
      var day = await api('/api/day/extra', { method: 'POST', body: { date: state.dayDate, studentId: studentId, action: action } });
      state.day = day;
      var wrap = $('#roster-wrap');
      if (wrap) wrap.innerHTML = rosterHTML();
      var clearBtn = viewEl.querySelector('[data-act="clear-marks"]');
      if (clearBtn) clearBtn.toggleAttribute('hidden', state.pending.size === 0);
      var head = viewEl.querySelector('.card__title .chip');
      if (head) head.textContent = fa(day.students.length) + ' نفر';
      repaintSummaryAndBar();
      paintExtraList();
      toast(action === 'add' ? 'به حضور امروز اضافه شد' : 'از حضور امروز حذف شد', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  /* --------------------------------------------------------- students view */

  async function renderStudents() {
    var res = await api('/api/students');
    state.students = res.students;
    viewEl.innerHTML = studentsHTML();
    $('#topbar-day').textContent = 'شاگردان';
    $('#topbar-sub').textContent = fa(res.students.length) + ' نفر ثبت شده';
  }

  function studentsFiltered() {
    var q = state.search.trim().toLowerCase();
    return (state.students || []).filter(function (s) {
      return !q || s.name.toLowerCase().indexOf(q) >= 0 || (s.cls || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  function dayTagsHTML(weekdays) {
    return J.WEEKDAY_NAMES.map(function (name, i) {
      return '<span class="daytag' + (weekdays.indexOf(i) >= 0 ? ' is-on' : '') + '">' + name.replace('‌', '') + '</span>';
    }).join('');
  }

  function studentsHTML() {
    var list = studentsFiltered();
    var body;
    if (!state.students.length) {
      body = '<div class="empty"><div class="empty__icon">' + icon('users', 24) + '</div>' +
        '<strong>هنوز شاگردی اضافه نکرده‌اید</strong>' +
        '<p>شاگرد‌ها را همراه با روزهای حضورشان اضافه کنید تا در لیست حضور خودکار بیایند.</p>' +
        '<button class="btn btn--sm btn--primary" data-act="add-student">' + icon('plus', 15) + ' افزودن شاگرد</button></div>';
    } else if (!list.length) {
      body = '<div class="empty"><div class="empty__icon">' + icon('search', 22) + '</div><strong>نتیجه‌ای پیدا نشد</strong><p>عبارت دیگری را جستجو کنید.</p></div>';
    } else {
      body = '<div class="students">' + list.map(function (s) {
        return '' +
          '<div class="scard' + (s.active ? '' : ' is-inactive') + '">' +
            '<span class="row__avatar">' + esc(initial(s.name)) + '</span>' +
            '<div class="scard__info">' +
              '<div class="scard__top">' +
                '<span class="scard__name">' + esc(s.name) + '</span>' +
                (s.cls ? '<span class="chip">' + esc(s.cls) + '</span>' : '') +
                (s.active ? '' : '<span class="chip chip--warn">غیرفعال</span>') +
                (s.weekdays.length ? '' : '<span class="chip chip--brand">بدون روز ثابت</span>') +
              '</div>' +
              '<div class="scard__days">' + dayTagsHTML(s.weekdays) + '</div>' +
            '</div>' +
            '<div class="scard__actions">' +
              '<button class="iconbtn" type="button" data-act="edit-student" data-id="' + esc(s.id) + '" title="ویرایش" aria-label="ویرایش">' + icon('edit', 16) + '</button>' +
              '<button class="iconbtn iconbtn--danger" type="button" data-act="delete-student" data-id="' + esc(s.id) + '" title="حذف" aria-label="حذف">' + icon('trash', 16) + '</button>' +
            '</div>' +
          '</div>';
      }).join('') + '</div>';
    }

    return '' +
      '<div class="page-head">' +
        '<div class="page-head__titles"><h2>شاگردان</h2><p>' + fa(state.students.length) + ' شاگرد ثبت شده — روزهای حضور هر شاگرد را اینجا تعیین کنید</p></div>' +
        '<button class="btn btn--primary" type="button" data-act="add-student">' + icon('plus', 16) + ' افزودن شاگرد</button>' +
      '</div>' +
      '<div class="toolbar">' +
        '<div class="searchbox">' + icon('search', 17) + '<input type="search" id="student-search" placeholder="جستجوی نام یا کلاس…" value="' + esc(state.search) + '" /></div>' +
      '</div>' +
      '<div class="card"><div class="card__body">' + body + '</div></div>';
  }

  function openStudentModal(student) {
    var draft = student
      ? { id: student.id, name: student.name, cls: student.cls || '', weekdays: student.weekdays.slice(), active: student.active }
      : { name: '', cls: '', weekdays: [], active: true };
    state.draft = draft;

    openModal(
      '<div class="modal__head">' +
        '<div><h3>' + (student ? 'ویرایش شاگرد' : 'افزودن شاگرد') + '</h3><p>نام و روزهایی که این شاگرد در برنامه حضور دارد را مشخص کنید.</p></div>' +
        '<button class="iconbtn" type="button" data-act="close-modal" aria-label="بستن">' + icon('x', 16) + '</button>' +
      '</div>' +
      '<div class="modal__body">' +
        '<div class="formgrid">' +
          '<label class="field"><span class="field__label">نام و نام خانوادگی</span>' +
            '<span class="field__box"><input id="f-name" type="text" placeholder="مثلاً علی رضایی" maxlength="60" value="' + esc(draft.name) + '" /></span></label>' +
          '<label class="field"><span class="field__label">کلاس / پایه (اختیاری)</span>' +
            '<span class="field__box"><input id="f-cls" type="text" placeholder="مثلاً کلاس ۹ و ۱۰" maxlength="40" value="' + esc(draft.cls) + '" /></span></label>' +
          '<div class="field"><span class="field__label">روزهای حضور در هفته</span><div class="weekpicker" id="f-days">' + weekPickerHTML(draft.weekdays) + '</div></div>' +
          '<div class="switchline">' +
            '<div class="switchline__text"><strong>شاگرد فعال است</strong><small>شاگرد غیرفعال در لیست حضور خودکار نمی‌آید</small></div>' +
            '<button class="switch" type="button" id="f-active" role="switch" aria-checked="' + (draft.active ? 'true' : 'false') + '" aria-label="فعال"></button>' +
          '</div>' +
          '<p class="login__error" id="f-error" hidden></p>' +
        '</div>' +
      '</div>' +
      '<div class="modal__foot">' +
        '<button class="btn btn--ghost" type="button" data-act="close-modal">انصراف</button>' +
        '<button class="btn btn--primary" type="button" data-act="save-student">' + icon('check', 16) + (student ? ' ذخیره تغییرات' : ' افزودن شاگرد') + '</button>' +
      '</div>'
    );

    var activeBtn = $('#f-active');
    activeBtn.addEventListener('click', function () {
      var next = activeBtn.getAttribute('aria-checked') !== 'true';
      activeBtn.setAttribute('aria-checked', String(next));
      state.draft.active = next;
    });
  }

  function weekPickerHTML(selected) {
    return J.WEEKDAY_NAMES.map(function (name, i) {
      return '<button class="wchip' + (selected.indexOf(i) >= 0 ? ' is-on' : '') + '" type="button" data-act="toggle-day" data-day="' + i + '" aria-pressed="' + (selected.indexOf(i) >= 0) + '">' + name + '</button>';
    }).join('');
  }

  async function saveStudent() {
    var draft = state.draft;
    if (!draft) return;
    draft.name = ($('#f-name').value || '').trim();
    draft.cls = ($('#f-cls').value || '').trim();
    var errEl = $('#f-error');
    if (draft.name.length < 2) {
      errEl.textContent = 'نام شاگرد را وارد کنید (حداقل ۲ حرف).';
      errEl.hidden = false;
      $('#f-name').focus();
      return;
    }
    var payload = { name: draft.name, cls: draft.cls, weekdays: draft.weekdays, active: draft.active };
    try {
      if (draft.id) await api('/api/students/' + draft.id, { method: 'PATCH', body: payload });
      else await api('/api/students', { method: 'POST', body: payload });
      closeModal();
      toast(draft.id ? 'اطلاعات شاگرد به‌روز شد' : 'شاگرد جدید اضافه شد', 'ok');
      await renderStudents();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  }

  function confirmDelete(student) {
    openModal(
      '<div class="modal__head"><div><h3>حذف شاگرد</h3><p>این عمل قابل بازگشت نیست.</p></div>' +
        '<button class="iconbtn" type="button" data-act="close-modal" aria-label="بستن">' + icon('x', 16) + '</button></div>' +
      '<div class="modal__body"><p style="font-size:14px;line-height:1.9">آیا مطمئن هستید که «<strong>' + esc(student.name) + '</strong>» از لیست شاگردان حذف شود؟ سوابق حضور این شاگرد هم از همه روزها پاک می‌شود.</p></div>' +
      '<div class="modal__foot">' +
        '<button class="btn btn--ghost" type="button" data-act="close-modal">انصراف</button>' +
        '<button class="btn btn--danger" type="button" data-act="confirm-delete" data-id="' + esc(student.id) + '">' + icon('trash', 16) + ' حذف شود</button>' +
      '</div>'
    );
  }

  async function deleteStudent(id) {
    try {
      await api('/api/students/' + id, { method: 'DELETE' });
      closeModal();
      toast('شاگرد حذف شد', 'ok');
      await renderStudents();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  /* -------------------------------------------------------- calendar view */

  async function renderCalendar(dateStr) {
    var base = dateStr ? J.parse(dateStr) : J.today();
    if (dateStr || !state.month) state.month = { jy: base.jy, jm: base.jm };
    var cal = await api('/api/calendar?year=' + state.month.jy + '&month=' + state.month.jm);
    state.calendar = cal;
    viewEl.innerHTML = calendarHTML(cal);
    $('#topbar-day').textContent = 'تقویم';
    $('#topbar-sub').textContent = cal.monthName + ' ' + fa(cal.jy);
  }

  function calendarHTML(cal) {
    var t = J.today();
    var todayKey = J.format(t.jy, t.jm, t.jd);
    var firstWeekday = J.weekday(cal.jy, cal.jm, 1);
    var cells = [];

    for (var i = 0; i < firstWeekday; i += 1) cells.push('<div class="cal__cell is-blank"></div>');

    cal.days.forEach(function (d) {
      var expected = d.expected || 0;
      var present = d.present || 0;
      var absent = d.absent || 0;
      var pct = expected > 0 ? Math.round((present / expected) * 100) : 0;
      var apct = expected > 0 ? Math.round((absent / expected) * 100) : 0;
      var isToday = d.date === todayKey;
      var isFuture = d.date > todayKey;
      cells.push('' +
        '<button class="cal__cell' + (isToday ? ' is-today' : '') + (d.weekday === 6 ? ' is-friday' : '') + (d.extras ? ' has-extra' : '') + '" type="button" data-act="open-day" data-date="' + d.date + '" aria-label="' + esc(J.longLabel(cal.jy, cal.jm, d.jd)) + '"' + (isFuture ? ' style="opacity:.72"' : '') + '>' +
          '<div class="cal__num"><span>' + fa(d.jd) + '</span>' + (d.recorded ? '<small>' + fa(present) + '/' + fa(expected) + '</small>' : '') + '</div>' +
          '<div class="cal__bar">' +
            (pct ? '<span class="p" style="width:' + pct + '%"></span>' : '') +
            (apct ? '<span class="a" style="width:' + apct + '%"></span>' : '') +
          '</div>' +
          '<div class="cal__foot">' +
            '<span>' + (d.recorded ? fa(present) + ' حاضر' : expected ? fa(expected) + ' نفر' : '—') + '</span>' +
            (absent ? '<span>' + fa(absent) + ' غایب</span>' : '') +
          '</div>' +
        '</button>');
    });

    var tail = (7 - (cells.length % 7)) % 7;
    for (var k = 0; k < tail; k += 1) cells.push('<div class="cal__cell is-blank"></div>');

    var recordedDays = cal.days.filter(function (d) { return d.recorded; });
    var sumPresent = 0, sumExpected = 0, sumAbsent = 0;
    recordedDays.forEach(function (d) {
      sumPresent += d.present;
      sumAbsent += d.absent;
      sumExpected += Math.max(d.expected, d.present + d.absent);
    });
    var avg = sumExpected > 0 ? Math.round((sumPresent / sumExpected) * 100) : 0;

    return '' +
      '<div class="page-head">' +
        '<div class="page-head__titles"><h2>تقویم</h2><p>روی هر روز بزنید تا لیست حضور با همه جزئیات باز شود</p></div>' +
        '<div class="calhead__nav">' +
          '<button class="iconbtn" type="button" data-act="cal-prev" aria-label="ماه قبل">' + icon('right', 16) + '</button>' +
          '<button class="btn btn--sm btn--ghost" type="button" data-act="cal-today">ماه جاری</button>' +
          '<button class="iconbtn" type="button" data-act="cal-next" aria-label="ماه بعد">' + icon('left', 16) + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="statgrid">' +
        '<div class="stat"><span class="stat__value">' + fa(cal.days.length) + '</span><span class="stat__label">روز ماه</span></div>' +
        '<div class="stat stat--ok"><span class="stat__value">' + fa(sumPresent) + '</span><span class="stat__label">حضور ثبت‌شده</span></div>' +
        '<div class="stat stat--bad"><span class="stat__value">' + fa(sumAbsent) + '</span><span class="stat__label">غیبت ثبت‌شده</span></div>' +
        '<div class="stat stat--brand"><span class="stat__value">' + fa(avg) + '٪</span><span class="stat__label">میانگین حضور</span></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card__head">' +
          '<div class="card__title">' + icon('calendar', 17) + ' ' + cal.monthName + ' <span class="chip">' + fa(cal.jy) + '</span></div>' +
          '<div class="legend">' +
            '<span><i style="background:var(--ok)"></i>حاضر</span>' +
            '<span><i style="background:var(--bad)"></i>غایب</span>' +
            '<span><i style="background:var(--warn)"></i>حضور خارجی</span>' +
          '</div>' +
        '</div>' +
        '<div class="card__body">' +
          '<div class="cal">' +
            J.WEEKDAY_NAMES.map(function (n) { return '<div class="cal__dow">' + n + '</div>'; }).join('') +
            cells.join('') +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function shiftMonth(delta) {
    if (!state.month) return;
    var jm = state.month.jm + delta;
    var jy = state.month.jy;
    if (jm < 1) { jm = 12; jy -= 1; }
    if (jm > 12) { jm = 1; jy += 1; }
    state.month = { jy: jy, jm: jm };
    history.replaceState(null, '', '#/calendar/' + J.format(jy, jm, 1));
    renderCalendar(J.format(jy, jm, 1));
  }

  async function openDayModal(date) {
    openModal('<div class="modal__head"><div><h3>در حال بارگذاری…</h3></div></div><div class="modal__body"><div class="skeleton" style="height:120px"></div></div>');
    try {
      var day = await api('/api/day?date=' + encodeURIComponent(date));
      var rows = day.students;
      var listHTML = rows.length ? rows.map(function (r) {
        var st = r.status;
        var chip = st === 'present' ? '<span class="chip chip--ok">حاضر</span>'
          : st === 'absent' ? '<span class="chip chip--bad">غایب</span>'
          : '<span class="chip">ثبت‌نشده</span>';
        return '<div class="dlrow">' +
          '<span class="row__avatar" style="width:32px;height:32px;border-radius:10px;font-size:13px">' + esc(initial(r.name)) + '</span>' +
          '<span class="dlrow__name">' + esc(r.name) + (r.cls ? ' <span class="daytag">' + esc(r.cls) + '</span>' : '') + '</span>' +
          '<span class="dlrow__badges">' + (r.extra ? '<span class="chip chip--warn">خارجی</span>' : '') + chip + '</span>' +
        '</div>';
      }).join('') : '<div class="empty" style="padding:26px 8px"><strong>برای این روز کسی در برنامه نیست</strong></div>';

      var extraLine = day.summary.extra ? ' • ' + fa(day.summary.extra) + ' حضور خارجی' : '';
      openModal(
        '<div class="modal__head">' +
          '<div><h3>' + esc(day.weekdayName) + ' ' + fa(day.jd) + ' ' + day.monthName + ' ' + fa(day.jy) + '</h3>' +
          '<p>' + (day.recorded ? 'آخرین به‌روزرسانی: ' + fa(fmtTime(day.updatedAt)) + (day.updatedBy ? ' توسط ' + esc(day.updatedBy) : '') : 'برای این روز چیزی ثبت نشده') + '</p></div>' +
          '<button class="iconbtn" type="button" data-act="close-modal" aria-label="بستن">' + icon('x', 16) + '</button>' +
        '</div>' +
        '<div class="modal__body">' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px">' +
            '<span class="chip chip--ok">' + fa(day.summary.present) + ' حاضر</span>' +
            '<span class="chip chip--bad">' + fa(day.summary.absent) + ' غایب</span>' +
            '<span class="chip">' + fa(day.summary.unmarked) + ' ثبت‌نشده</span>' +
            '<span class="chip chip--brand">' + fa(day.summary.total) + ' نفر' + extraLine + '</span>' +
          '</div>' +
          '<div class="detaillist">' + listHTML + '</div>' +
        '</div>' +
        '<div class="modal__foot">' +
          '<button class="btn btn--ghost" type="button" data-act="close-modal">بستن</button>' +
          '<button class="btn btn--primary btn--grow" type="button" data-act="goto-day" data-date="' + day.date + '">' + icon('edit', 16) + ' باز کردن و ویرایش همین روز</button>' +
        '</div>'
      );
    } catch (err) {
      closeModal();
      toast(err.message, 'bad');
    }
  }

  /* -------------------------------------------------------------- actions */

  document.addEventListener('click', async function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.dataset.act;

    if (el.closest('.overlay') && act === 'overlay' && e.target === el) { closeModal(); return; }

    switch (act) {
      case 'theme-toggle': toggleTheme(); break;
      case 'logout': logout(); break;
      case 'reload': render(); break;
      case 'close-modal': closeModal(); break;

      case 'day-prev': navigate('#/day/' + shiftDate(state.dayDate, -1)); break;
      case 'day-next': navigate('#/day/' + shiftDate(state.dayDate, 1)); break;
      case 'day-today': navigate('#/today'); break;

      case 'mark': markStudent(el.dataset.id, el.dataset.status); break;
      case 'save-marks': saveMarks(); break;
      case 'clear-marks':
        state.pending.clear();
        viewEl.innerHTML = dayHTML(state.day);
        break;
      case 'all-present':
        (state.day ? state.day.students : []).forEach(function (row) {
          if (row.status === 'present') state.pending.delete(row.id);
          else state.pending.set(row.id, 'present');
        });
        viewEl.innerHTML = dayHTML(state.day);
        break;

      case 'open-extra': openExtraModal(); break;
      case 'pick-extra': toggleExtra(el.dataset.id); break;
      case 'remove-extra': toggleExtra(el.dataset.id); break;

      case 'add-student': openStudentModal(null); break;
      case 'edit-student': {
        var st = (state.students || []).filter(function (s) { return s.id === el.dataset.id; })[0];
        if (st) openStudentModal(st);
        break;
      }
      case 'delete-student': {
        var sd = (state.students || []).filter(function (s) { return s.id === el.dataset.id; })[0];
        if (sd) confirmDelete(sd);
        break;
      }
      case 'confirm-delete': deleteStudent(el.dataset.id); break;
      case 'save-student': saveStudent(); break;
      case 'toggle-day': {
        if (!state.draft) break;
        var day = Number(el.dataset.day);
        var idx = state.draft.weekdays.indexOf(day);
        if (idx >= 0) state.draft.weekdays.splice(idx, 1);
        else state.draft.weekdays.push(day);
        state.draft.weekdays.sort(function (a, b) { return a - b; });
        $('#f-days').innerHTML = weekPickerHTML(state.draft.weekdays);
        break;
      }

      case 'cal-prev': shiftMonth(-1); break;
      case 'cal-next': shiftMonth(1); break;
      case 'cal-today': {
        var t = J.today();
        state.month = { jy: t.jy, jm: t.jm };
        history.replaceState(null, '', '#/calendar/' + J.format(t.jy, t.jm, 1));
        renderCalendar(J.format(t.jy, t.jm, 1));
        break;
      }
      case 'open-day': openDayModal(el.dataset.date); break;
      case 'goto-day': closeModal(); navigate('#/day/' + el.dataset.date); break;
      default: break;
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target.id === 'student-search') {
      state.search = e.target.value;
      var list = viewEl.querySelector('.card__body');
      var scrollY = window.scrollY;
      var cursor = e.target.selectionStart;
      var focused = document.activeElement === e.target;
      viewEl.innerHTML = studentsHTML();
      if (focused) {
        var input = $('#student-search');
        input.focus();
        try { input.setSelectionRange(cursor, cursor); } catch (err) { /* ignore */ }
      }
      window.scrollTo(0, scrollY);
      void list;
    }
    if (e.target.dataset && e.target.dataset.role === 'extra-filter') {
      state.extraQuery = e.target.value;
      paintExtraList();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeModal(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      if (state.pending.size) {
        e.preventDefault();
        saveMarks();
      }
    }
  });

  window.addEventListener('beforeunload', function (e) {
    if (state.pending.size) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* ---------------------------------------------------------------- boot */

  initTheme();
  document.querySelectorAll('#theme-toggle, #theme-toggle-m').forEach(function (btn) {
    btn.addEventListener('click', toggleTheme);
  });
  $('#logout').addEventListener('click', logout);
  $('#logout-m').addEventListener('click', logout);

  (async function boot() {
    try {
      var me = await api('/api/me');
      state.user = me.user;
      showApp();
    } catch (err) {
      showLogin();
    }
  })();
})();
