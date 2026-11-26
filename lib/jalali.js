/*
 * Jalali (Solar Hijri / Shamsi) calendar helpers.
 * Algorithm based on the well-known jalaali-js routines (Borkowski break years).
 * Works in Node (module.exports) and in the browser (window.Jalali).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Jalali = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BREAKS = [
    -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210,
    1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178,
  ];

  var MONTH_NAMES = [
    'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
    'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
  ];

  // Saturday-first week, matching the Persian calendar.
  var WEEKDAY_NAMES = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];
  var WEEKDAY_SHORT = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];

  function div(a, b) { return ~~(a / b); }
  function mod(a, b) { return a - ~~(a / b) * b; }

  function jalCal(jy, withoutLeap) {
    var bl = BREAKS.length;
    var gy = jy + 621;
    var leapJ = -14;
    var jp = BREAKS[0];
    var jm, jump = 0, leap = 0, leapG, march, n, i;

    if (jy < jp || jy >= BREAKS[bl - 1]) throw new Error('Invalid Jalaali year ' + jy);

    for (i = 1; i < bl; i += 1) {
      jm = BREAKS[i];
      jump = jm - jp;
      if (jy < jm) break;
      leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
      jp = jm;
    }
    n = jy - jp;

    leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
    if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;

    leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
    march = 20 + leapJ - leapG;

    if (!withoutLeap) {
      if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
      leap = mod(mod(n + 1, 33) - 1, 4);
      if (leap === -1) leap = 4;
    }

    return { leap: leap, gy: gy, march: march };
  }

  /*
   * Day numbers use "days since the Unix epoch" (UTC), which is exact for the
   * whole Jalali range we support and avoids integer overflow traps.
   * g2d() and d2g() are exact inverses, all that the Jalali math needs.
   */
  function g2d(gy, gm, gd) {
    return Math.floor(Date.UTC(gy, gm - 1, gd) / 86400000);
  }

  function d2g(dayNumber) {
    var d = new Date(dayNumber * 86400000);
    return { gy: d.getUTCFullYear(), gm: d.getUTCMonth() + 1, gd: d.getUTCDate() };
  }

  function j2d(jy, jm, jd) {
    var r = jalCal(jy, true);
    return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
  }

  function d2j(jdn) {
    var gy = d2g(jdn).gy;
    var jy = gy - 621;
    var r = jalCal(jy, false);
    var jdn1f = g2d(gy, 3, r.march);
    var jd, jm, k;

    k = jdn - jdn1f;
    if (k >= 0) {
      if (k <= 185) {
        jm = 1 + div(k, 31);
        jd = mod(k, 31) + 1;
        return { jy: jy, jm: jm, jd: jd };
      }
      k -= 186;
    } else {
      jy -= 1;
      k += 179;
      if (r.leap === 1) k += 1;
    }
    jm = 7 + div(k, 30);
    jd = mod(k, 30) + 1;
    return { jy: jy, jm: jm, jd: jd };
  }

  function toJalaali(gy, gm, gd) { return d2j(g2d(gy, gm, gd)); }
  function toGregorian(jy, jm, jd) { return d2g(j2d(jy, jm, jd)); }

  function isLeapYear(jy) {
    try { return jalCal(jy, false).leap === 0; } catch (e) { return false; }
  }

  function monthLength(jy, jm) {
    if (jm <= 6) return 31;
    if (jm <= 11) return 30;
    return isLeapYear(jy) ? 30 : 29;
  }

  function isValidDate(jy, jm, jd) {
    if (!Number.isInteger(jy) || !Number.isInteger(jm) || !Number.isInteger(jd)) return false;
    if (jy < 1200 || jy > 1600 || jm < 1 || jm > 12 || jd < 1) return false;
    return jd <= monthLength(jy, jm);
  }

  /** 0 = Saturday ... 6 = Friday */
  function weekday(jy, jm, jd) {
    var g = toGregorian(jy, jm, jd);
    var dow = new Date(Date.UTC(g.gy, g.gm - 1, g.gd)).getUTCDay(); // 0 = Sunday
    return (dow + 1) % 7;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function format(jy, jm, jd) {
    return String(jy) + '-' + pad2(jm) + '-' + pad2(jd);
  }

  function parse(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!m) return null;
    var jy = Number(m[1]), jm = Number(m[2]), jd = Number(m[3]);
    if (!isValidDate(jy, jm, jd)) return null;
    return { jy: jy, jm: jm, jd: jd };
  }

  function today() {
    var now = new Date();
    return toJalaali(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  function addDays(jy, jm, jd, delta) {
    return d2j(j2d(jy, jm, jd) + delta);
  }

  function longLabel(jy, jm, jd) {
    return WEEKDAY_NAMES[weekday(jy, jm, jd)] + ' ' + jd + ' ' + MONTH_NAMES[jm - 1] + ' ' + jy;
  }

  return {
    MONTH_NAMES: MONTH_NAMES,
    WEEKDAY_NAMES: WEEKDAY_NAMES,
    WEEKDAY_SHORT: WEEKDAY_SHORT,
    toJalaali: toJalaali,
    toGregorian: toGregorian,
    isLeapYear: isLeapYear,
    monthLength: monthLength,
    isValidDate: isValidDate,
    weekday: weekday,
    format: format,
    parse: parse,
    today: today,
    addDays: addDays,
    longLabel: longLabel,
  };
});
