const AR_TZ = 'America/Argentina/Buenos_Aires';

// Devuelve 'YYYY-MM-DD' según la hora actual en Argentina.
export function todayAR() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: AR_TZ }); // en-CA => YYYY-MM-DD
  return fmt.format(new Date());
}

// Devuelve fecha y hora actual en Argentina como ISO string con offset -03:00.
export function nowAR() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: AR_TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}-03:00`;
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('T')[0].split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('T')[0].split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString().slice(0, 10);
}

// Diferencia en días (a - b), donde a y b son 'YYYY-MM-DD'
export function diffDays(a, b) {
  const [ay, am, ad] = a.split('T')[0].split('-').map(Number);
  const [by, bm, bd] = b.split('T')[0].split('-').map(Number);
  const da = Date.UTC(ay, am - 1, ad);
  const db_ = Date.UTC(by, bm - 1, bd);
  return Math.round((da - db_) / 86400000);
}
