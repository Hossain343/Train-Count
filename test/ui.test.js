'use strict';

/**
 * Browser (Playwright) tests for the Train Count UI.
 * Requires playwright:  npm i -D playwright && npx playwright install chromium
 * Run with:             npm run test:ui
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Jalali = require('../lib/jalali');

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (err) {
  console.log('⚠️  playwright نصب نیست — test:ui رد شد. (npm i -D playwright && npx playwright install chromium)');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const SHOT_DIR = path.join(ROOT, 'docs', 'screenshots');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'train-count-ui-'));
let base = '';
let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  \u001b[32m✓\u001b[0m ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  \u001b[31m✗\u001b[0m ' + name + '\n      ' + err.message);
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        PORT: '0',
        HOST: '127.0.0.1',
        DATA_DIR,
        TZ: 'Asia/Tehran',
        // accounts for the test run only — nothing secret lives in the repo
        SEED_ACCOUNTS: JSON.stringify([
          { username: 'admin', name: 'Admin', password: 'test-pass-admin' },
          { username: 'teacher', name: 'Teacher', password: 'test-pass-teacher' },
          { username: 'teacher2', name: 'Teacher Two', password: 'test-pass-teacher2' },
        ]),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + out)), 15000);
    child.stdout.on('data', (c) => {
      out += c.toString();
      const m = /listening on http:\/\/[^:]+:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        base = 'http://127.0.0.1:' + m[1];
        resolve(child);
      }
    });
    child.stderr.on('data', (c) => { out += c.toString(); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('server exited ' + code + '\n' + out)); });
  });
}

const t = Jalali.today();
const todayStr = Jalali.format(t.jy, t.jm, t.jd);
const todayWeekday = Jalali.weekday(t.jy, t.jm, t.jd);
const otherWeekday = (todayWeekday + 1) % 7;

async function run() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'fa-IR', timezoneId: 'Asia/Tehran' });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    // 401s are expected: the app probes /api/me before the user logs in
    if (m.type() === 'error' && !/401|Unauthorized/.test(m.text())) consoleErrors.push('console: ' + m.text());
  });

  console.log('\n\u001b[1mTrain Count — UI tests (Playwright)\u001b[0m\n');

  /* ------------------------------------------------------------- login */
  console.log('Login:');
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await check('login screen is shown first', () => {
    assert.ok(page.locator('#login').isVisible(), 'login must be visible');
  });
  await check('username field is empty and hints at no real account', async () => {
    assert.strictEqual(await page.inputValue('#username'), '');
    assert.strictEqual(await page.inputValue('#password'), '');
    assert.strictEqual(await page.getAttribute('#username', 'placeholder'), null);
    assert.strictEqual(await page.getAttribute('#password', 'placeholder'), null);
    const text = (await page.textContent('#login')).toLowerCase();
    ['test-pass-teacher', 'test-pass-admin'].forEach((secret) => {
      assert.ok(text.indexOf(secret) === -1, 'login screen exposes ' + secret);
    });
  });
  await page.screenshot({ path: path.join(SHOT_DIR, '01-login.png') });

  await page.fill('#username', 'teacher');
  await page.fill('#password', 'nope');
  await page.click('#login-submit');
  await page.waitForSelector('#login-error:not([hidden])', { timeout: 5000 });
  await check('wrong password shows an inline error', async () => {
    const text = await page.textContent('#login-error');
    assert.ok(/اشتباه/.test(text || ''), 'error text: ' + text);
  });

  await page.fill('#username', 'teacher');
  await page.fill('#password', 'test-pass-teacher');
  await page.click('#login-submit');
  await page.waitForSelector('#view .page-head h2', { timeout: 8000 });
  await check('valid login opens the attendance page', async () => {
    const title = await page.textContent('#view .page-head h2');
    assert.ok(/ثبت حضور/.test(title || ''), 'title: ' + title);
    assert.strictEqual(await page.locator('#user-name').textContent(), 'Teacher');
  });
  await check('no javascript errors on load', () => assert.deepStrictEqual(consoleErrors, []));

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#app:not([hidden])', { timeout: 8000 });
  await check('session survives a page reload (no re-login)', async () => {
    assert.ok(await page.locator('#app').isVisible());
  });

  /* ----------------------------------------------------------- students */
  console.log('\nStudents:');
  await page.click('.navlink[data-route="students"]');
  await page.waitForSelector('[data-act="add-student"]', { timeout: 5000 });
  await check('empty students page shows an empty state', async () => {
    const txt = await page.textContent('#view');
    assert.ok(/هنوز شاگردی اضافه نکرده/.test(txt || ''));
  });

  async function addStudent(name, cls, weekday) {
    await page.click('[data-act="add-student"]');
    await page.waitForSelector('#f-name');
    await page.fill('#f-name', name);
    if (cls) await page.fill('#f-cls', cls);
    await page.click('#f-days [data-day="' + weekday + '"]');
    await page.click('[data-act="save-student"]');
    await page.waitForSelector('#modal-root .overlay', { state: 'detached', timeout: 5000 });
  }

  await addStudent('علی رضایی', 'کلاس ۹', todayWeekday);
  await page.waitForSelector('.scard');
  await check('added student appears in the list', async () => {
    const names = await page.$$eval('.scard__name', (els) => els.map((e) => e.textContent.trim()));
    assert.deepStrictEqual(names, ['علی رضایی']);
    const onDays = await page.$$eval('.scard:first-child .daytag.is-on', (els) => els.length);
    assert.strictEqual(onDays, 1, 'exactly one weekday must be active');
  });

  await addStudent('سارا محمدی', 'کلاس ۱۰', otherWeekday);
  await addStudent('مریم کریمی', '', todayWeekday);
  await page.waitForFunction(() => document.querySelectorAll('.scard').length === 3, null, { timeout: 5000 });
  await check('three students are listed', async () => {
    assert.strictEqual(await page.locator('.scard').count(), 3);
  });

  await page.fill('#student-search', 'سارا');
  await page.waitForFunction(() => document.querySelectorAll('.scard').length === 1, null, { timeout: 5000 });
  await check('search filters the list', async () => {
    assert.strictEqual(await page.locator('.scard__name').textContent(), 'سارا محمدی');
  });
  await page.fill('#student-search', '');
  await page.waitForFunction(() => document.querySelectorAll('.scard').length === 3, null, { timeout: 5000 });

  // edit the card of a specific student (not "first child": the list is sorted by name)
  const aliCard = page.locator('.scard', { hasText: 'علی رضایی' }).first();
  await aliCard.locator('[data-act="edit-student"]').click();
  await page.waitForSelector('#f-name');
  await page.fill('#f-name', 'علی رضایی پور');
  await page.click('#f-days [data-day="' + otherWeekday + '"]');
  await page.click('[data-act="save-student"]');
  await page.waitForSelector('#modal-root .overlay', { state: 'detached', timeout: 5000 });
  await page.waitForFunction(() => /علی رضایی پور/.test(document.querySelector('#view').textContent), null, { timeout: 5000 });
  await check('editing a student updates name and days', async () => {
    const card = page.locator('.scard', { hasText: 'علی رضایی پور' }).first();
    assert.strictEqual(await card.locator('.daytag.is-on').count(), 2);
  });

  await page.screenshot({ path: path.join(SHOT_DIR, '03-students.png') });

  /* --------------------------------------------------------- attendance */
  console.log('\nDaily attendance:');
  await page.click('.navlink[data-route="today"]');
  await page.waitForSelector('.row', { timeout: 6000 });
  await check('roster shows only students scheduled for today', async () => {
    const names = await page.$$eval('.row__name', (els) => els.map((e) => e.textContent.trim()));
    assert.deepStrictEqual(names, ['علی رضایی پور', 'مریم کریمی']);
    assert.strictEqual(await page.textContent('#stat-total'), '۲');
    assert.ok(await page.locator('[data-act="save-marks"]').isDisabled(), 'save button starts disabled');
  });

  await page.click('.row:first-child .seg__btn[data-status="present"]');
  await page.waitForSelector('.row.is-present', { timeout: 4000 });
  await check('marking present updates row state and counters', async () => {
    assert.strictEqual(await page.textContent('#stat-present'), '۱');
    assert.strictEqual(await page.textContent('#stat-unmarked'), '۱');
    assert.ok(!(await page.locator('[data-act="save-marks"]').isDisabled()), 'save becomes enabled');
  });
  await check('unsaved changes are announced', async () => {
    const note = await page.textContent('.actionbar__note');
    assert.ok(/ثبت‌نشده/.test(note || ''), 'note: ' + note);
  });

  await page.click('.row:nth-child(2) .seg__btn[data-status="absent"]');
  await page.waitForSelector('.row.is-absent', { timeout: 4000 });
  await check('marking absent is reflected', async () => {
    assert.strictEqual(await page.textContent('#stat-present'), '۱');
    assert.strictEqual(await page.textContent('#stat-absent'), '۱');
    assert.strictEqual(await page.textContent('#stat-unmarked'), '۰');
  });

  await page.click('[data-act="save-marks"]');
  await page.waitForFunction(() => document.querySelectorAll('.actionbar__note.is-dirty').length === 0, null, { timeout: 6000 });
  await check('saving persists the marks (button re-disabled)', async () => {
    assert.ok(await page.locator('[data-act="save-marks"]').isDisabled());
  });
  await page.screenshot({ path: path.join(SHOT_DIR, '02-today.png') });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.row.is-present', { timeout: 8000 });
  await check('marks survive a reload', async () => {
    assert.strictEqual(await page.textContent('#stat-present'), '۱');
    assert.strictEqual(await page.textContent('#stat-absent'), '۱');
    assert.strictEqual(await page.locator('.row.is-absent').count(), 1);
  });

  // toggle the same status again = clear it
  await page.click('.row:first-child .seg__btn[data-status="present"]');
  await page.waitForFunction(() => document.querySelector('#stat-present').textContent === '۰', null, { timeout: 4000 });
  await check('clicking the active status again clears the mark', async () => {
    assert.strictEqual(await page.textContent('#stat-unmarked'), '۱');
  });
  await page.click('[data-act="clear-marks"]');
  await page.waitForFunction(() => document.querySelector('#stat-present').textContent === '۱', null, { timeout: 4000 });
  await check('«لغو تغییرات» restores the last saved state', async () => {
    assert.strictEqual(await page.textContent('#stat-absent'), '۱');
    assert.strictEqual(await page.textContent('#stat-unmarked'), '۰');
    assert.ok(await page.locator('[data-act="save-marks"]').isDisabled());
  });

  // unsaved marks must not be lost when hopping to another page and back
  await page.click('.row:first-child .seg__btn[data-status="present"]');
  await page.waitForSelector('.actionbar__note.is-dirty', { timeout: 4000 });
  await page.click('.navlink[data-route="calendar"]');
  await page.waitForSelector('.cal__cell', { timeout: 6000 });
  await page.click('.navlink[data-route="today"]');
  await page.waitForSelector('.row', { timeout: 6000 });
  await check('unsaved marks are auto-saved when leaving the day', async () => {
    assert.strictEqual(await page.textContent('#stat-present'), '۰', 'the cleared mark was saved');
    assert.strictEqual(await page.textContent('#stat-absent'), '۱');
    assert.ok(await page.locator('[data-act="save-marks"]').isDisabled(), 'nothing left unsaved');
  });
  // put today back into a clean, known state for the rest of the run
  await page.click('.row:first-child .seg__btn[data-status="present"]');
  await page.waitForSelector('.actionbar__note.is-dirty', { timeout: 4000 });
  await page.click('[data-act="save-marks"]');
  await page.waitForFunction(() => document.querySelectorAll('.actionbar__note.is-dirty').length === 0, null, { timeout: 6000 });

  /* --------------------------------------------------- extra attendance */
  console.log('\nExtra (guest) attendance:');
  // create a student who is not scheduled today
  await page.click('.navlink[data-route="students"]');
  await page.waitForSelector('[data-act="add-student"]');
  await addStudent('مهمان امروز', 'مهمان', (todayWeekday + 3) % 7);
  await page.waitForFunction(() => document.querySelectorAll('.scard').length === 4, null, { timeout: 5000 });

  await page.click('.navlink[data-route="today"]');
  await page.waitForSelector('.row', { timeout: 6000 });
  await check('off-schedule student is not in the automatic roster', async () => {
    const names = await page.$$eval('.row__name', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(!names.includes('مهمان امروز'), names.join(','));
  });

  await page.click('[data-act="open-extra"]');
  await page.waitForSelector('#extra-list .pick', { timeout: 5000 });
  await check('guest picker lists every student', async () => {
    assert.strictEqual(await page.locator('#extra-list .pick').count(), 4);
    const disabled = await page.locator('#extra-list .pick[disabled]').count();
    assert.strictEqual(disabled, 2, 'the two students already in the day must be disabled');
  });

  await page.fill('[data-role="extra-filter"]', 'مهمان');
  await page.waitForFunction(() => document.querySelectorAll('#extra-list .pick').length === 1, null, { timeout: 4000 });
  await check('guest picker has its own search', async () => {
    assert.strictEqual(await page.locator('#extra-list .pick').count(), 1);
  });
  await page.screenshot({ path: path.join(SHOT_DIR, '04-extra.png') });

  await page.click('#extra-list .pick');
  await page.waitForSelector('.row .chip--warn', { timeout: 6000 });
  await check('guest is added to today with an «خارجی» badge', async () => {
    const names = await page.$$eval('.row__name', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(names.includes('مهمان امروز'), names.join(','));
    assert.strictEqual(await page.locator('.row .chip--warn').count(), 1);
    assert.strictEqual(names.length, 3);
  });
  await page.click('[data-act="close-modal"]');
  await page.waitForSelector('#modal-root .overlay', { state: 'detached', timeout: 4000 });

  await page.click('.navlink[data-route="calendar"]');
  await page.waitForSelector('.cal__cell', { timeout: 6000 });
  await check('calendar month view renders a full grid', async () => {
    const cells = await page.locator('.cal__cell:not(.is-blank)').count();
    assert.strictEqual(cells, Jalali.monthLength(t.jy, t.jm));
    assert.strictEqual(await page.locator('.cal__dow').count(), 7);
  });
  await check('today is highlighted in the calendar', async () => {
    assert.strictEqual(await page.locator('.cal__cell.is-today').count(), 1);
  });
  await page.screenshot({ path: path.join(SHOT_DIR, '05-calendar.png') });

  await page.click('.cal__cell.is-today');
  await page.waitForSelector('.detaillist', { timeout: 6000 });
  await check('clicking a day opens its full detail sheet', async () => {
    const txt = await page.textContent('#modal-root');
    assert.ok(/حاضر/.test(txt), 'must list statuses');
    assert.ok(/خارجی/.test(txt), 'must flag the guest');
    assert.ok(/آخرین به‌روزرسانی/.test(txt), 'must show who/when it was saved');
  });
  await page.screenshot({ path: path.join(SHOT_DIR, '06-day-detail.png') });

  await page.click('[data-act="goto-day"]');
  await page.waitForSelector('.actionbar', { timeout: 6000 });
  await check('«باز کردن و ویرایش» jumps to that day attendance page', async () => {
    assert.ok(page.url().endsWith('#/day/' + todayStr), page.url());
    assert.strictEqual(await page.locator('.row').count(), 3);
  });

  /* -------------------------------------------------------- day navigation */
  console.log('\nDay navigation:');
  await page.click('[data-act="day-prev"]');
  const prevExpected = Jalali.addDays(t.jy, t.jm, t.jd, -1);
  await page.waitForFunction(
    (d) => location.hash === '#/day/' + d,
    Jalali.format(prevExpected.jy, prevExpected.jm, prevExpected.jd),
    { timeout: 5000 }
  );
  await check('previous-day arrow moves one Jalali day back', async () => {
    assert.ok(page.url().includes(Jalali.format(prevExpected.jy, prevExpected.jm, prevExpected.jd)), page.url());
  });
  await page.click('[data-act="day-today"]');
  await page.waitForFunction(() => location.hash === '#/today', null, { timeout: 5000 });
  await page.waitForFunction(() => /امروز/.test(document.querySelector('.page-head h2').textContent), null, { timeout: 5000 });
  await check('«امروز» returns to today', async () => {
    assert.ok(/امروز/.test(await page.textContent('.page-head h2')));
    assert.ok(await page.locator('[data-act="day-today"]').isDisabled(), 'the today button is disabled on today');
  });

  /* ------------------------------------------------------------ dark mode */
  console.log('\nTheme & responsiveness:');
  await page.click('#theme-toggle');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 4000 });
  await check('dark mode toggles and persists', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    assert.strictEqual(await page.getAttribute('html', 'data-theme'), 'dark');
    await page.screenshot({ path: path.join(SHOT_DIR, '07-dark.png') });
  });
  await page.click('#theme-toggle');

  const sizes = [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'tablet', width: 820, height: 1180 },
    { name: 'desktop', width: 1440, height: 900 },
  ];
  for (const size of sizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.waitForTimeout(220);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await check('no horizontal overflow at ' + size.name + ' (' + size.width + 'px)', () => {
      assert.ok(overflow <= 1, 'overflow: ' + overflow + 'px');
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  await check('bottom tab bar is used on mobile', async () => {
    assert.ok(await page.locator('.tabbar').isVisible());
    assert.ok(!(await page.locator('.sidebar').isVisible()));
  });
  await page.screenshot({ path: path.join(SHOT_DIR, '08-mobile.png'), fullPage: false });

  await page.click('.tablink[data-route="calendar"]');
  await page.waitForSelector('.cal__cell', { timeout: 5000 });
  const overflowMobile = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await check('calendar fits a 390px screen', () => assert.ok(overflowMobile <= 1, 'overflow: ' + overflowMobile));
  await page.screenshot({ path: path.join(SHOT_DIR, '09-mobile-calendar.png') });

  /* ---------------------------------------------------------- logout */
  console.log('\nLogout & private access:');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.click('#logout');
  await page.waitForSelector('#login:not([hidden])', { timeout: 5000 });
  await check('logout returns to the login screen', async () => {
    assert.ok(await page.locator('#login').isVisible());
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#login:not([hidden])', { timeout: 5000 });
  await check('after logout a reload still requires login', async () => {
    assert.ok(await page.locator('#app').isHidden());
  });
  await check('no javascript errors during the whole run', () => {
    assert.deepStrictEqual(consoleErrors, []);
  });

  /* ------------------------------------------------------------ delete */
  console.log('\nDelete flow:');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'test-pass-admin');
  await page.click('#login-submit');
  await page.waitForSelector('#view .page-head', { timeout: 8000 });
  await page.click('.navlink[data-route="students"]');
  await page.waitForSelector('.scard [data-act="delete-student"]');
  await page.click('.scard:first-child [data-act="delete-student"]');
  await page.waitForSelector('[data-act="confirm-delete"]');
  await check('delete asks for confirmation', async () => {
    const txt = await page.textContent('#modal-root');
    assert.ok(/قابل بازگشت نیست/.test(txt || ''));
  });
  await page.click('[data-act="confirm-delete"]');
  await page.waitForFunction(() => document.querySelectorAll('.scard').length === 3, null, { timeout: 6000 });
  await check('deleting removes the student from the list', async () => {
    assert.strictEqual(await page.locator('.scard').count(), 3);
  });

  await browser.close();
  server.kill();

  console.log('\n' + '─'.repeat(52));
  if (failures.length === 0) {
    console.log('\u001b[32m✓ همه ' + passed + ' تست رابط کاربری با موفقیت گذشت\u001b[0m');
    console.log('All ' + passed + ' UI checks passed. Screenshots → docs/screenshots/\n');
  } else {
    console.log('\u001b[31m✗ ' + failures.length + ' تست ناموفق از ' + (passed + failures.length) + '\u001b[0m');
    failures.forEach((f) => console.log('  - ' + f.name + '\n    ' + f.err.message));
    process.exitCode = 1;
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

run().catch((err) => {
  console.error('\nUI test run crashed:', err);
  try { process.kill(0, 'SIGTERM'); } catch (e) { /* ignore */ }
  process.exitCode = 1;
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
