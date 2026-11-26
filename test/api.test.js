'use strict';

/**
 * End-to-end API tests for Train Count.
 * Runs the real server on a random port with a throw-away data directory.
 *
 *   npm test        (or: node test/api.test.js)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Jalali = require('../lib/jalali');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'train-count-test-'));
const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
let cookie = '';
let base = '';

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  \u001b[32m✓\u001b[0m ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  \u001b[31m✗\u001b[0m ' + name + '\n      ' + err.message);
  }
}

async function req(method, url, body, opts = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie && opts.auth !== false) headers.Cookie = cookie;
  const res = await fetch(base + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text, setCookie };
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
    const timer = setTimeout(() => reject(new Error('server did not start in time:\n' + out)), 15000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const m = /listening on http:\/\/[^:]+:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        base = 'http://127.0.0.1:' + m[1];
        resolve(child);
      }
    });
    child.stderr.on('data', (chunk) => { out += chunk.toString(); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('server exited with code ' + code + '\n' + out));
    });
  });
}

/* ------------------------------------------------------------------ tests */

async function run() {
  const server = await startServer();
  console.log('\n\u001b[1mTrain Count — API tests\u001b[0m\n');

  /* ------------------------------------------------------------ calendar */
  console.log('Jalali calendar:');
  check('1 Farvardin 1404 = Friday 21 March 2025', () => {
    const g = Jalali.toGregorian(1404, 1, 1);
    assert.deepStrictEqual([g.gy, g.gm, g.gd], [2025, 3, 21]);
    assert.strictEqual(Jalali.weekday(1404, 1, 1), 6); // جمعه
    assert.strictEqual(Jalali.WEEKDAY_NAMES[6], 'جمعه');
  });
  check('Nowruz of recent years lands on the right Gregorian day', () => {
    const expected = {
      1399: [2020, 3, 20], 1400: [2021, 3, 21], 1401: [2022, 3, 21],
      1402: [2023, 3, 21], 1403: [2024, 3, 20], 1404: [2025, 3, 21], 1405: [2026, 3, 21],
    };
    Object.keys(expected).forEach((y) => {
      const g = Jalali.toGregorian(Number(y), 1, 1);
      assert.deepStrictEqual([g.gy, g.gm, g.gd], expected[y], 'year ' + y);
    });
  });
  check('round-trip conversion for a whole year', () => {
    let jdnErrors = 0;
    for (let jm = 1; jm <= 12; jm += 1) {
      const len = Jalali.monthLength(1404, jm);
      for (let jd = 1; jd <= len; jd += 1) {
        const g = Jalali.toGregorian(1404, jm, jd);
        const back = Jalali.toJalaali(g.gy, g.gm, g.gd);
        if (back.jy !== 1404 || back.jm !== jm || back.jd !== jd) jdnErrors += 1;
      }
    }
    assert.strictEqual(jdnErrors, 0);
  });
  check('month lengths: 6×31, 5×30, last month 29 or 30', () => {
    assert.strictEqual(Jalali.monthLength(1404, 1), 31);
    assert.strictEqual(Jalali.monthLength(1404, 7), 30);
    const last = Jalali.monthLength(1404, 12);
    assert.ok(last === 29 || last === 30);
  });
  check('invalid dates are rejected', () => {
    assert.strictEqual(Jalali.parse('1404-13-01'), null);
    assert.strictEqual(Jalali.parse('1404-07-31'), null);
    assert.strictEqual(Jalali.parse('nope'), null);
  });
  check('weekday advances +1 per day and wraps', () => {
    const a = Jalali.weekday(1404, 9, 1);
    const b = Jalali.weekday(1404, 9, 2);
    assert.strictEqual((a + 1) % 7, b);
  });
  check('addDays crosses month boundaries', () => {
    const n = Jalali.addDays(1404, 6, 31, 1);
    assert.deepStrictEqual(n, { jy: 1404, jm: 7, jd: 1 });
  });

  /* --------------------------------------------------------------- auth */
  console.log('\nAuthentication:');
  await (async () => {
    const r = await req('GET', '/api/me', undefined, { auth: false });
    check('unauthenticated /api/me → 401', () => assert.strictEqual(r.status, 401));
  })();
  await (async () => {
    const r = await req('GET', '/api/students', undefined, { auth: false });
    check('unauthenticated /api/students → 401', () => assert.strictEqual(r.status, 401));
  })();
  let wrongMsg = '';
  await (async () => {
    const r = await req('POST', '/api/login', { username: 'teacher', password: 'wrong' });
    wrongMsg = r.json && r.json.error;
    check('wrong password → 401', () => assert.strictEqual(r.status, 401));
  })();
  let unknownMsg = '';
  await (async () => {
    const r = await req('POST', '/api/login', { username: 'nobody', password: 'x' });
    unknownMsg = r.json && r.json.error;
    await check('unknown user → 401', () => assert.strictEqual(r.status, 401));
  })();
  await (async () => {
    const r = await req('POST', '/api/login', { username: 'teacher', password: 'test-pass-teacher' });
    check('valid credentials → 200 + session cookie', () => {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.user.username, 'teacher');
      const sc = r.setCookie.join(';');
      assert.ok(/tc_session=/.test(sc), 'cookie must be set');
      assert.ok(/HttpOnly/.test(sc), 'cookie must be HttpOnly');
      assert.ok(/Max-Age=/.test(sc), 'cookie must be persistent (stay logged in)');
      cookie = /tc_session=([^;]+)/.exec(sc)[1];
      cookie = 'tc_session=' + cookie;
    });
  })();
  await (async () => {
    const r = await req('GET', '/api/me');
    check('session cookie keeps the user logged in', () => {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.user.username, 'teacher');
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.json.today));
    });
  })();
  await (async () => {
    const r = await req('POST', '/api/login', { username: 'admin', password: 'test-pass-admin' });
    const r2 = await req('POST', '/api/login', { username: 'teacher2', password: 'test-pass-teacher2' });
    check('all three seeded accounts can log in', () => {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r2.status, 200);
      assert.strictEqual(r.json.user.username, 'admin');
      assert.strictEqual(r2.json.user.username, 'teacher2');
    });
  })();
  check('unknown user and wrong password give the same message (no user enumeration)', () => {
    assert.ok(unknownMsg && wrongMsg, 'both errors must be captured');
    assert.strictEqual(unknownMsg, wrongMsg);
  });
  await (async () => {
    const r = await req('POST', '/api/login', { username: 'TEACHER', password: 'test-pass-teacher' });
    check('username is case-insensitive', () => assert.strictEqual(r.status, 200));
  })();
  await (async () => {
    const r = await req('POST', '/api/login', { username: 'teacher', password: '' });
    check('empty password → 400', () => assert.strictEqual(r.status, 400));
  })();
  await (async () => {
    const bad = await req('GET', '/api/me', undefined, { auth: false });
    const forged = await fetch(base + '/api/me', { headers: { Cookie: 'tc_session=eyJ1IjoiYWRtaW4ifQ.fake' } });
    check('forged session cookie is rejected', () => assert.strictEqual(forged.status, 401 && bad.status));
  })();

  /* ----------------------------------------------------------- students */
  console.log('\nStudents:');
  let s1, s2, s3;
  await (async () => {
    const r = await req('POST', '/api/students', { name: 'علی رضایی', cls: 'کلاس ۹', weekdays: [0, 2] });
    s1 = r.json && r.json.student;
    check('create student → 201 with generated id', () => {
      assert.strictEqual(r.status, 201);
      assert.ok(/^st_[0-9a-f]{16}$/.test(s1.id));
      assert.deepStrictEqual(s1.weekdays, [0, 2]);
      assert.strictEqual(s1.active, true);
    });
  })();
  await (async () => {
    const r = await req('POST', '/api/students', { name: '  سارا   محمدی  ', weekdays: [1, 1, 2, 2] });
    s2 = r.json.student;
    check('whitespace is trimmed and duplicate weekdays collapse', () => {
      assert.strictEqual(s2.name, 'سارا محمدی');
      assert.deepStrictEqual(s2.weekdays, [1, 2]);
    });
  })();
  await (async () => {
    const r = await req('POST', '/api/students', { name: 'مریم کریمی', weekdays: [5] });
    s3 = r.json.student;
    check('third student created', () => assert.strictEqual(r.status, 201));
  })();
  await (async () => {
    const r = await req('POST', '/api/students', { name: 'ا' });
    check('too-short name → 400', () => assert.strictEqual(r.status, 400));
  })();
  await (async () => {
    const r = await req('POST', '/api/students', { name: 'تست بد', weekdays: [9] });
    check('invalid weekday → 400', () => assert.strictEqual(r.status, 400));
  })();
  await (async () => {
    const r = await req('POST', '/api/students', { name: 'تست بد', weekdays: 'شنبه' });
    check('non-array weekdays → 400', () => assert.strictEqual(r.status, 400));
  })();
  await (async () => {
    const r = await req('POST', '/api/students', {});
    check('missing body fields → 400', () => assert.strictEqual(r.status, 400));
  })();
  await (async () => {
    const r = await req('POST', '/api/students', { name: 'بدون روز' });
    check('student without fixed days is allowed (guest-only)', () => {
      assert.strictEqual(r.status, 201);
      assert.deepStrictEqual(r.json.student.weekdays, []);
    });
    await req('DELETE', '/api/students/' + r.json.student.id);
  })();
  await (async () => {
    const r = await req('GET', '/api/students');
    check('list returns all students sorted by name', () => {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.count, 3);
      const names = r.json.students.map((s) => s.name);
      assert.deepStrictEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'fa')));
    });
  })();

  /* --------------------------------------------------------- attendance */
  console.log('\nAttendance day:');
  // pick a date whose weekday matches s1 (Saturday = 0) and another matching s2 (Sunday = 1)
  const base1404 = Jalali.toJalaali(2025, 4, 1); // 1404-01-12
  let satDate = null;
  let sunDate = null;
  for (let d = 1; d <= 31; d += 1) {
    const wd = Jalali.weekday(1404, 1, d);
    if (wd === 0 && !satDate) satDate = Jalali.format(1404, 1, d);
    if (wd === 1 && !sunDate) sunDate = Jalali.format(1404, 1, d);
  }
  void base1404;

  await (async () => {
    const r = await req('GET', '/api/day?date=' + satDate);
    check('saturday roster contains only scheduled students', () => {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.weekday, 0);
      assert.strictEqual(r.json.weekdayName, 'شنبه');
      assert.strictEqual(r.json.students.length, 1);
      assert.strictEqual(r.json.students[0].name, 'علی رضایی');
      assert.strictEqual(r.json.students[0].scheduled, true);
      assert.strictEqual(r.json.summary.unmarked, 1);
      assert.strictEqual(r.json.recorded, false);
    });
  })();
  await (async () => {
    const r = await req('GET', '/api/day?date=1404-13-01');
    check('invalid date → 400', () => assert.strictEqual(r.status, 400));
  })();
  await (async () => {
    const r = await req('GET', '/api/day');
    check('missing date param → 400', () => assert.strictEqual(r.status, 400));
  })();
  await (async () => {
    const r = await req('POST', '/api/day/marks', { date: satDate, marks: { [s1.id]: 'present' } });
    check('marking present is saved and summarised', () => {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.summary.present, 1);
      assert.strictEqual(r.json.summary.unmarked, 0);
      assert.strictEqual(r.json.students[0].status, 'present');
      assert.ok(r.json.updatedAt);
      assert.strictEqual(r.json.updatedBy, 'teacher');
      assert.strictEqual(r.json.recorded, true);
    });
  })();
  await (async () => {
    const r = await req('GET', '/api/day?date=' + satDate);
    check('marks are persisted and read back', () => {
      assert.strictEqual(r.json.students[0].status, 'present');
      assert.ok(r.json.students[0].markedAt);
    });
  })();
  await (async () => {
    const r = await req('POST', '/api/day/marks', { date: satDate, marks: { [s1.id]: 'absent' } });
    check('status can be switched to absent', () => assert.strictEqual(r.json.summary.absent, 1));
  })();
  await (async () => {
    const r = await req('POST', '/api/day/marks', { date: satDate, marks: { [s1.id]: 'clear' } });
    check('mark can be cleared', () => {
      assert.strictEqual(r.json.summary.unmarked, 1);
      assert.strictEqual(r.json.recorded, false, 'empty day record should be pruned');
    });
  })();
  await (async () => {
    const r = await req('POST', '/api/day/marks', { date: satDate, marks: { [s1.id]: 'maybe' } });
    check('invalid status → 400', () => assert.strictEqual(r.status, 400));
  })();
  await (async () => {
    const r = await req('POST', '/api/day/marks', { date: satDate, marks: { st_doesnotexist: 'present' } });
    check('marking unknown student → 404', () => assert.strictEqual(r.status, 404));
  })();
  await (async () => {
    const r = await req('POST', '/api/day/marks', { date: satDate, marks: [] });
    check('non-object marks → 400', () => assert.strictEqual(r.status, 400));
  })();

  /* ----------------------------------------------------- extra attendance */
  console.log('\nExtra (guest) attendance:');
  await (async () => {
    const r = await req('POST', '/api/day/extra', { date: satDate, studentId: s3.id, action: 'add' });
    check('adding an off-schedule student puts them on the day', () => {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.students.length, 2);
      const extra = r.json.students.find((s) => s.id === s3.id);
      assert.ok(extra, 'guest student must appear');
      assert.strictEqual(extra.extra, true);
      assert.strictEqual(extra.scheduled, false);
      assert.strictEqual(r.json.summary.extra, 1);
      assert.strictEqual(r.json.summary.total, 2);
    });
  })();
  await (async () => {
    const r = await req('POST', '/api/day/extra', { date: satDate, studentId: s3.id, action: 'add' });
    check('adding the same guest twice is idempotent', () => assert.strictEqual(r.json.students.length, 2));
  })();
  await (async () => {
    const r = await req('POST', '/api/day/marks', { date: satDate, marks: { [s1.id]: 'present', [s3.id]: 'present' } });
    check('guest can be marked present', () => assert.strictEqual(r.json.summary.present, 2));
  })();
  await (async () => {
    const r = await req('POST', '/api/day/extra', { date: satDate, studentId: s3.id, action: 'remove' });
    check('removing a guest also drops their mark', () => {
      assert.strictEqual(r.json.students.length, 1);
      assert.strictEqual(r.json.summary.extra, 0);
      assert.strictEqual(r.json.summary.present, 1);
    });
  })();
  await (async () => {
    const r = await req('POST', '/api/day/extra', { date: satDate, studentId: s1.id, action: 'add' });
    check('a scheduled student is never duplicated as guest', () => {
      assert.strictEqual(r.json.students.length, 1);
      assert.strictEqual(r.json.students[0].extra, false);
    });
    await req('POST', '/api/day/extra', { date: satDate, studentId: s1.id, action: 'remove' });
  })();
  await (async () => {
    const r = await req('POST', '/api/day/extra', { date: satDate, studentId: 'st_nope', action: 'add' });
    check('unknown student as guest → 404', () => assert.strictEqual(r.status, 404));
  })();

  /* ------------------------------------------------------------- calendar */
  console.log('\nCalendar:');
  await (async () => {
    const r = await req('GET', '/api/calendar?year=1404&month=1');
    check('month has the right number of days', () => {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.days.length, 31);
      assert.strictEqual(r.json.days[0].date, '1404-01-01');
      assert.strictEqual(r.json.monthName, 'فروردین');
    });
  })();
  await (async () => {
    const r = await req('GET', '/api/calendar?year=1404&month=1');
    const sat = r.json.days.find((d) => d.date === satDate);
    check('calendar day aggregates attendance correctly', () => {
      assert.ok(sat.present >= 1, 'present count should include recorded day');
      assert.ok(sat.expected >= 1, 'expected count should include scheduled students');
      assert.strictEqual(sat.recorded, true);
    });
  })();
  await (async () => {
    const r = await req('GET', '/api/calendar?year=1404&month=12');
    check('esfand length is 29 or 30', () => assert.ok([29, 30].includes(r.json.days.length)));
  })();
  await (async () => {
    const r = await req('GET', '/api/calendar?year=9999&month=1');
    check('bad year → 400', () => assert.strictEqual(r.status, 400));
  })();
  await (async () => {
    const r = await req('GET', '/api/calendar?month=5');
    check('year defaults to current year', () => assert.strictEqual(r.status, 200));
  })();

  /* -------------------------------------------------------- student edits */
  console.log('\nStudent updates & cascades:');
  await (async () => {
    const r = await req('PATCH', '/api/students/' + s2.id, { name: 'سارا احمدی', weekdays: [0, 1, 2], active: false });
    check('patch updates fields', () => {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.student.name, 'سارا احمدی');
      assert.deepStrictEqual(r.json.student.weekdays, [0, 1, 2]);
      assert.strictEqual(r.json.student.active, false);
    });
  })();
  await (async () => {
    const r = await req('GET', '/api/day?date=' + sunDate);
    check('inactive student disappears from automatic roster', () => {
      assert.strictEqual(r.json.students.filter((s) => s.id === s2.id).length, 0);
    });
  })();
  await (async () => {
    await req('PATCH', '/api/students/' + s2.id, { active: true });
    const r = await req('GET', '/api/day?date=' + sunDate);
    check('reactivated student comes back', () => assert.strictEqual(r.json.students.length, 1));
  })();
  await (async () => {
    const r = await req('DELETE', '/api/students/' + s1.id);
    const day = await req('GET', '/api/day?date=' + satDate);
    check('deleting a student cascades into attendance', () => {
      assert.strictEqual(r.status, 200);
      assert.ok(!day.json.students.some((s) => s.id === s1.id), 'deleted student must be gone from the day');
      assert.strictEqual(day.json.summary.present, 0, 'their marks must be gone too');
      assert.strictEqual(day.json.recorded, false);
    });
  })();
  await (async () => {
    const r = await req('DELETE', '/api/students/st_unknown');
    check('deleting unknown student → 404', () => assert.strictEqual(r.status, 404));
  })();
  await (async () => {
    const r = await req('PATCH', '/api/students/' + s3.id, { name: 'x' });
    check('patch with invalid name → 400', () => assert.strictEqual(r.status, 400));
  })();

  /* ------------------------------------------------------- static & misc */
  console.log('\nHTTP layer:');
  await (async () => {
    const r = await fetch(base + '/');
    const html = await r.text();
    check('index.html is served', () => {
      assert.strictEqual(r.status, 200);
      assert.ok(/ترین کانت/.test(html));
      assert.ok(/dir="rtl"/.test(html));
    });
  })();
  await (async () => {
    const r = await fetch(base + '/lib/jalali.js');
    check('shared jalali.js is served', () => assert.strictEqual(r.status, 200));
  })();
  await (async () => {
    const r = await fetch(base + '/');
    const html = (await r.text()).toLowerCase();
    check('login page leaks no usernames or passwords', () => {
      ['test-pass-teacher', 'test-pass-admin', 'test-pass-teacher2'].forEach((secret) => {
        assert.ok(html.indexOf(secret) === -1, 'leaked on the login page: ' + secret);
      });
      assert.ok(html.indexOf('placeholder=') === -1, 'the login form must not carry placeholder hints at all');
    });
  })();
  await (async () => {
    const r = await fetch(base + '/app.js');
    check('client bundle is served', () => assert.strictEqual(r.status, 200));
  })();
  await (async () => {
    const r1 = await fetch(base + '/%2e%2e%2fserver.js');
    const r2 = await fetch(base + '/..%2f..%2fetc%2fpasswd');
    check('path traversal is blocked', () => {
      assert.strictEqual(r1.status, 404);
      assert.strictEqual(r2.status, 404);
    });
  })();
  await (async () => {
    const r = await fetch(base + '/api/unknown');
    check('unknown api route → 404', () => assert.strictEqual(r.status, 404));
  })();
  await (async () => {
    const r = await req('POST', '/api/day/marks');
    check('empty body → 400', () => assert.strictEqual(r.status, 400));
  })();

  /* ----------------------------------------------------- persistence */
  console.log('\nPersistence & logout:');
  await (async () => {
    await req('POST', '/api/students', { name: 'شاگرد ماندگار', weekdays: [0] });
    const before = (await req('GET', '/api/students')).json.count;
    // restart the server with the same data directory
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
    const again = await startServer();
    global.__server2 = again;
    const after = await req('GET', '/api/students');
    check('data survives a server restart', () => {
      assert.strictEqual(after.json.count, before);
      assert.ok(after.json.students.some((s) => s.name === 'شاگرد ماندگار'));
    });
    check('session survives a server restart (secret is persisted)', () => {
      assert.strictEqual(after.status, 200);
    });
  })();
  await (async () => {
    const r = await req('POST', '/api/logout');
    const me = await req('GET', '/api/me');
    check('logout clears the session', () => {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(me.status, 401);
    });
  })();

  /* ------------------------------------------------------ rate limiting */
  console.log('\nBrute-force protection:');
  await (async () => {
    let last = null;
    for (let i = 0; i < 12; i += 1) {
      last = await req('POST', '/api/login', { username: 'admin', password: 'wrong-' + i });
    }
    check('repeated failed logins get throttled (429)', () => assert.strictEqual(last.status, 429));
  })();

  /* ---------------------------------------------------------------- done */
  (global.__server2 || server).kill();

  console.log('\n' + '─'.repeat(52));
  if (failures.length === 0) {
    console.log(`\u001b[32m✓ همه ${passed} تست با موفقیت گذشت\u001b[0m`);
    console.log('All ' + passed + ' checks passed.\n');
  } else {
    console.log(`\u001b[31m✗ ${failures.length} تست ناموفق از ${passed + failures.length}\u001b[0m`);
    failures.forEach((f) => console.log('  - ' + f.name + '\n    ' + f.err.message));
    process.exitCode = 1;
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

run().catch((err) => {
  console.error('\nTest run crashed:', err);
  process.exitCode = 1;
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
