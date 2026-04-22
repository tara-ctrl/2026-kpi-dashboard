// /api/stripe — Unified endpoint: fetches from Stripe, HubSpot, AND Supabase
// Uses native fetch — no npm packages required
// Returns combined data from all three sources in one response
// Optimized with timeouts and pagination limits to avoid serverless timeout

const MENDELSOHN_PORTAL_ID = '370b66bd-a47f-4ff8-8b0a-a5d439e15e57';
const MAX_PAGES = 8; // Max pagination pages per endpoint (800 subs capacity)
const FETCH_TIMEOUT = 6000; // 6s timeout per individual API call
const SERVICE_TIMEOUT = 28000; // 28s max per service (function has 30s limit)

// Helper: fetch with timeout
async function fetchWithTimeout(url, options, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('Request timed out');
    throw e;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const now = new Date();
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const weeks = getWeekBuckets(yearStart);

  // Wrap each service in its own timeout so partial results still come through
  function withTimeout(promise, ms, name) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(name + ' timed out after ' + (ms/1000) + 's')), ms))
    ]);
  }

  // Run all three fetches in parallel — each has its own timeout
  const [stripeResult, hubspotResult, supabaseResult] = await Promise.allSettled([
    withTimeout(fetchStripe(weeks, yearStart, now), SERVICE_TIMEOUT, 'Stripe'),
    withTimeout(fetchHubSpot(weeks, yearStart), SERVICE_TIMEOUT, 'HubSpot'),
    withTimeout(fetchSupabase(weeks, yearStart), SERVICE_TIMEOUT, 'Supabase')
  ]);

  const response = {};
  const errors = [];

  // Stripe
  if (stripeResult.status === 'fulfilled') {
    response.stripe = stripeResult.value;
  } else {
    errors.push('Stripe: ' + stripeResult.reason.message);
    response.stripe = { currentMRR: 0, currentARR: 0, weeks: weeks.map(w => ({ weekOf: w.label })) };
  }

  // HubSpot
  if (hubspotResult.status === 'fulfilled') {
    response.hubspot = hubspotResult.value;
  } else {
    errors.push('HubSpot: ' + hubspotResult.reason.message);
    response.hubspot = { weeks: weeks.map(w => ({ weekOf: w.label })) };
  }

  // Supabase
  if (supabaseResult.status === 'fulfilled') {
    response.supabase = supabaseResult.value;
  } else {
    errors.push('Supabase: ' + supabaseResult.reason.message);
    response.supabase = { weeks: weeks.map(w => ({ weekOf: w.label })) };
  }

  if (errors.length > 0) response.errors = errors;

  res.status(200).json(response);
};

// ============================================================
// STRIPE — Ultra-lean: fetches subscriptions page by page
//          with timing, then invoices separately. No expansion.
// ============================================================
async function fetchStripe(weeks, yearStart, now) {
  const SK = process.env.STRIPE_SECRET_KEY;
  if (!SK) throw new Error('STRIPE_SECRET_KEY not configured');

  const headers = { 'Authorization': 'Bearer ' + SK };
  const yearStartUnix = Math.floor(yearStart.getTime() / 1000);
  const timings = [];
  const t0 = Date.now();

  const weeklyData = weeks.map(w => ({
    weekOf: w.label, newMRR: 0, churn: 0, upgrade: 0, downgrade: 0,
    reactivation: 0, implFeeCount: 0, implFeeRevenue: 0,
    cancellations: 0, upgrades: 0, downgrades: 0, reactivations: 0, newSubs: 0
  }));

  // 1. Active subscriptions — page by page with timing
  let currentMRR = 0;
  let totalActiveSubs = 0;
  let annualSubs = 0;
  let monthlySubs = 0;
  let annualRevenue = 0;
  let monthlyRevenue = 0;
  let hasMore = true;
  let startingAfter = '';
  let pages = 0;

  while (hasMore && pages < MAX_PAGES) {
    const pt = Date.now();
    const url = 'https://api.stripe.com/v1/subscriptions?status=active&limit=100' +
      (startingAfter ? '&starting_after=' + startingAfter : '');
    const resp = await fetch(url, { headers });
    const data = await resp.json();
    timings.push('subs_p' + (pages+1) + ':' + (Date.now() - pt) + 'ms/' + (data.data ? data.data.length : 0) + 'items');

    if (data.error) throw new Error('Stripe API error: ' + data.error.message);

    for (const sub of data.data) {
      const mrr = calcMRR(sub);
      currentMRR += mrr;
      totalActiveSubs += 1;

      let isAnnual = false;
      if (sub.items && sub.items.data) {
        for (const item of sub.items.data) {
          const price = item.price || item.plan;
          if (!price) continue;
          const interval = (price.recurring && price.recurring.interval) || price.interval || 'month';
          if (interval === 'year') { isAnnual = true; break; }
        }
      }
      if (isAnnual) {
        annualSubs += 1;
        annualRevenue += mrr * 12;
      } else {
        monthlySubs += 1;
        monthlyRevenue += mrr;
      }
    }
    hasMore = data.has_more;
    if (data.data.length > 0) startingAfter = data.data[data.data.length - 1].id;
    pages++;
  }

  // 2. Implementation fee invoices — skip expand, search by product directly
  //    Use line_items endpoint per invoice would be slow, so search invoices
  //    and filter by metadata or just count paid invoices with the impl product
  const IMPL_PRODUCT = process.env.STRIPE_IMPL_FEE_PRODUCT_ID || 'prod_O8U4J6dnCkPZ1l';
  hasMore = true;
  startingAfter = '';
  pages = 0;
  let totalImplFeeRevenue = 0;
  let totalImplFeeCount = 0;

  // Use search API for invoices with specific product (faster, no expand needed)
  // Fallback: just fetch invoices without expansion and check line items in first page
  while (hasMore && pages < 3) {
    const pt = Date.now();
    const url = 'https://api.stripe.com/v1/invoices?status=paid&created[gte]=' + yearStartUnix +
      '&limit=50&expand[]=data.lines' +
      (startingAfter ? '&starting_after=' + startingAfter : '');
    const resp = await fetch(url, { headers });
    const data = await resp.json();
    timings.push('inv_p' + (pages+1) + ':' + (Date.now() - pt) + 'ms/' + (data.data ? data.data.length : 0) + 'items');

    if (data.error) throw new Error('Stripe invoices error: ' + data.error.message);

    for (const inv of data.data) {
      const createdAt = new Date(inv.created * 1000);
      const wi = findWeekIndex(weeks, createdAt);

      if (inv.lines && inv.lines.data) {
        for (const line of inv.lines.data) {
          const productId = (line.price && line.price.product) || (line.plan && line.plan.product);
          if (productId === IMPL_PRODUCT) {
            const amount = (line.amount || 0) / 100;
            totalImplFeeCount += 1;
            totalImplFeeRevenue += amount;
            if (wi !== -1) {
              weeklyData[wi].implFeeCount += 1;
              weeklyData[wi].implFeeRevenue += amount;
            }
          }
        }
      }
    }
    hasMore = data.has_more;
    if (data.data.length > 0) startingAfter = data.data[data.data.length - 1].id;
    pages++;
  }

  timings.push('total:' + (Date.now() - t0) + 'ms');

  return {
    currentMRR: Math.round(currentMRR),
    currentARR: Math.round(currentMRR * 12),
    totalActiveSubs: totalActiveSubs,
    annualSubs: annualSubs,
    monthlySubs: monthlySubs,
    annualRevenue: Math.round(annualRevenue),
    monthlyRevenue: Math.round(monthlyRevenue),
    implFeeCount: totalImplFeeCount,
    implFeeRevenue: Math.round(totalImplFeeRevenue),
    timings: timings,
    weeks: weeklyData
  };
}

// ============================================================
// HUBSPOT
// ============================================================
async function fetchHubSpot(weeks, yearStart) {
  const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!TOKEN) throw new Error('HUBSPOT_ACCESS_TOKEN not configured');

  const headers = {
    'Authorization': 'Bearer ' + TOKEN,
    'Content-Type': 'application/json'
  };

  const weeklyData = weeks.map(w => ({
    weekOf: w.label, demos: 0, infoSessions: 0, demosSpecific: 0, totalDemos: 0, dealsCreated: 0
  }));

  // 1. Meetings
  let after = undefined;
  let hasMore = true;
  let pages = 0;

  while (hasMore && pages < MAX_PAGES) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'hs_timestamp', operator: 'GTE', value: yearStart.getTime().toString() },
          { propertyName: 'hs_meeting_outcome', operator: 'HAS_PROPERTY' }
        ]
      }],
      properties: ['hs_meeting_title', 'hs_timestamp', 'hs_meeting_outcome'],
      sorts: [{ propertyName: 'hs_timestamp', direction: 'ASCENDING' }],
      limit: 100
    };
    if (after) body.after = after;

    const resp = await fetchWithTimeout('https://api.hubapi.com/crm/v3/objects/meetings/search', {
      method: 'POST', headers, body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (data.status === 'error') throw new Error(data.message || 'HubSpot meetings search failed');

    const meetings = data.results || [];
    for (const meeting of meetings) {
      const ts = new Date(meeting.properties.hs_timestamp);
      const wi = findWeekIndex(weeks, ts);
      if (wi === -1) continue;

      const title = (meeting.properties.hs_meeting_title || '').toLowerCase();
      weeklyData[wi].infoSessions += 1;
      weeklyData[wi].totalDemos += 1;
      if (title.includes('demo')) weeklyData[wi].demosSpecific += 1;
    }

    after = data.paging && data.paging.next && data.paging.next.after;
    hasMore = !!after;
    pages++;
  }

  // 2. Deals
  after = undefined;
  hasMore = true;
  pages = 0;

  while (hasMore && pages < MAX_PAGES) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'createdate', operator: 'GTE', value: yearStart.getTime().toString() }
        ]
      }],
      properties: ['createdate', 'dealname', 'amount', 'dealstage'],
      sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
      limit: 100
    };
    if (after) body.after = after;

    const resp = await fetchWithTimeout('https://api.hubapi.com/crm/v3/objects/deals/search', {
      method: 'POST', headers, body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (data.status === 'error') throw new Error(data.message || 'HubSpot deals search failed');

    const deals = data.results || [];
    for (const deal of deals) {
      const ts = new Date(deal.properties.createdate);
      const wi = findWeekIndex(weeks, ts);
      if (wi !== -1) weeklyData[wi].dealsCreated += 1;
    }

    after = data.paging && data.paging.next && data.paging.next.after;
    hasMore = !!after;
    pages++;
  }

  return { weeks: weeklyData };
}

// ============================================================
// SUPABASE
// ============================================================
async function fetchSupabase(weeks, yearStart) {
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPA_URL || !SUPA_KEY) throw new Error('Supabase env vars not configured');

  const headers = {
    'apikey': SUPA_KEY,
    'Authorization': 'Bearer ' + SUPA_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  const weeklyData = weeks.map(w => ({
    weekOf: w.label, searches: 0, newEstates: 0, newSubs: 0
  }));

  // 1. Searches (limit to 5000 max)
  let allTasks = [];
  let offset = 0;
  const batchSize = 1000;
  let keepGoing = true;
  let pages = 0;

  while (keepGoing && pages < 5) {
    const url = SUPA_URL + '/rest/v1/estate_task?select=id,createdAt,label,estateId' +
      '&createdAt=gte.' + yearStart.toISOString() +
      '&label=ilike.*search*' +
      '&order=createdAt.asc' +
      '&offset=' + offset + '&limit=' + batchSize;

    const resp = await fetchWithTimeout(url, { headers });
    if (!resp.ok) { console.error('Supabase estate_task error:', resp.status); break; }
    const data = await resp.json();
    if (!data || data.length === 0) { keepGoing = false; break; }
    allTasks = allTasks.concat(data);
    offset += batchSize;
    if (data.length < batchSize) keepGoing = false;
    pages++;
  }

  // Exclude Mendelsohn estates
  const exclUrl = SUPA_URL + '/rest/v1/estate?select=id&portalId=eq.' + MENDELSOHN_PORTAL_ID;
  const exclResp = await fetchWithTimeout(exclUrl, { headers });
  const exclData = exclResp.ok ? await exclResp.json() : [];
  const excludedIds = new Set(exclData.map(e => e.id));

  for (const task of allTasks) {
    if (excludedIds.has(task.estateId)) continue;
    const ts = new Date(task.createdAt);
    const wi = findWeekIndex(weeks, ts);
    if (wi !== -1) weeklyData[wi].searches += 1;
  }

  // 2. New estates
  const estateUrl = SUPA_URL + '/rest/v1/estate?select=id,createdAt,portalId' +
    '&createdAt=gte.' + yearStart.toISOString() +
    '&portalId=neq.' + MENDELSOHN_PORTAL_ID +
    '&order=createdAt.asc&limit=10000';

  const estateResp = await fetchWithTimeout(estateUrl, { headers });
  if (estateResp.ok) {
    const estates = await estateResp.json();
    for (const estate of estates) {
      const ts = new Date(estate.createdAt);
      const wi = findWeekIndex(weeks, ts);
      if (wi !== -1) weeklyData[wi].newEstates += 1;
    }
  }

  // 3. New subscriptions
  const subUrl = SUPA_URL + '/rest/v1/feature_subscription?select=id,createdAt' +
    '&createdAt=gte.' + yearStart.toISOString() +
    '&order=createdAt.asc&limit=10000';

  const subResp = await fetchWithTimeout(subUrl, { headers });
  if (subResp.ok) {
    const subs = await subResp.json();
    for (const sub of subs) {
      const ts = new Date(sub.createdAt);
      const wi = findWeekIndex(weeks, ts);
      if (wi !== -1) weeklyData[wi].newSubs += 1;
    }
  }

  return { weeks: weeklyData };
}

// ============================================================
// SHARED HELPERS
// ============================================================
function calcMRR(sub) {
  let mrr = 0;
  if (sub.items && sub.items.data) {
    for (const item of sub.items.data) {
      const price = item.price || item.plan;
      if (!price) continue;
      const amount = (price.unit_amount || 0) / 100;
      const interval = (price.recurring && price.recurring.interval) || price.interval || 'month';
      const qty = item.quantity || 1;
      mrr += interval === 'year' ? (amount * qty) / 12 : amount * qty;
    }
  }
  return Math.round(mrr * 100) / 100;
}

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
