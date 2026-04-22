// /api/supabase — Fetches searches, new estates, and subscriptions from Supabase
// Uses native fetch — no npm packages required
// Excludes Mendelsohn portal (internal testing)

const MENDELSOHN_PORTAL_ID = '370b66bd-a47f-4ff8-8b0a-a5d439e15e57';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const SUPA_URL = process.env.SUPABASE_URL;
    const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPA_URL || !SUPA_KEY) throw new Error('Supabase env vars not configured');

    const headers = {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };

    const now = new Date();
    const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const weeks = getWeekBuckets(yearStart);

    const weeklyData = weeks.map(w => ({
      weekOf: w.label, searches: 0, newEstates: 0, newSubs: 0
    }));

    // --- 1. Searches (estate_task with label containing "search") ---
    let allTasks = [];
    let offset = 0;
    const batchSize = 1000;
    let keepGoing = true;

    while (keepGoing) {
      const url = SUPA_URL + '/rest/v1/estate_task?select=id,createdAt,label,estateId' +
        '&createdAt=gte.' + yearStart.toISOString() +
        '&label=ilike.*search*' +
        '&order=createdAt.asc' +
        '&offset=' + offset + '&limit=' + batchSize;

      const resp = await fetch(url, { headers });
      if (!resp.ok) { console.error('Supabase estate_task error:', resp.status); break; }
      const data = await resp.json();
      if (!data || data.length === 0) { keepGoing = false; break; }
      allTasks = allTasks.concat(data);
      offset += batchSize;
      if (data.length < batchSize) keepGoing = false;
    }

    // Get Mendelsohn estates to exclude
    const exclUrl = SUPA_URL + '/rest/v1/estate?select=id&portalId=eq.' + MENDELSOHN_PORTAL_ID;
    const exclResp = await fetch(exclUrl, { headers });
    const exclData = exclResp.ok ? await exclResp.json() : [];
    const excludedIds = new Set(exclData.map(e => e.id));

    for (const task of allTasks) {
      if (excludedIds.has(task.estateId)) continue;
      const ts = new Date(task.createdAt);
      const wi = findWeekIndex(weeks, ts);
      if (wi !== -1) weeklyData[wi].searches += 1;
    }

    // --- 2. New estates (excluding Mendelsohn) ---
    const estateUrl = SUPA_URL + '/rest/v1/estate?select=id,createdAt,portalId' +
      '&createdAt=gte.' + yearStart.toISOString() +
      '&portalId=neq.' + MENDELSOHN_PORTAL_ID +
      '&order=createdAt.asc&limit=10000';

    const estateResp = await fetch(estateUrl, { headers });
    if (estateResp.ok) {
      const estates = await estateResp.json();
      for (const estate of estates) {
        const ts = new Date(estate.createdAt);
        const wi = findWeekIndex(weeks, ts);
        if (wi !== -1) weeklyData[wi].newEstates += 1;
      }
    }

    // --- 3. New subscriptions ---
    const subUrl = SUPA_URL + '/rest/v1/feature_subscription?select=id,createdAt' +
      '&createdAt=gte.' + yearStart.toISOString() +
      '&order=createdAt.asc&limit=10000';

    const subResp = await fetch(subUrl, { headers });
    if (subResp.ok) {
      const subs = await subResp.json();
      for (const sub of subs) {
        const ts = new Date(sub.createdAt);
        const wi = findWeekIndex(weeks, ts);
        if (wi !== -1) weeklyData[wi].newSubs += 1;
      }
    }

    res.status(200).json({ weeks: weeklyData });
  } catch (err) {
    console.error('Supabase error:', err);
    res.status(500).json({ error: 'Supabase API failed', details: err.message });
  }
};

function getWeekBuckets(yearStart) {
  const weeks = [];
  const d = new Date(yearStart);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  const now = new Date();
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  while (d < now) {
    const end = new Date(d); end.setUTCDate(end.getUTCDate() + 6);
    weeks.push({ label: monthNames[d.getUTCMonth()] + ' ' + d.getUTCDate(), start: d.toISOString(), end: end.toISOString() });
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return weeks;
}

function findWeekIndex(weeks, date) {
  for (let i = 0; i < weeks.length; i++) {
    if (date >= new Date(weeks[i].start) && date <= new Date(weeks[i].end)) return i;
  }
  return -1;
}
