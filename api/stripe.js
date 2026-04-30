// /api/stripe — Core Stripe + HubSpot + Supabase data
// Events-based data (cancellations, upgrades) handled by /api/stripe-events
// Split into two endpoints to stay within Vercel's 30s serverless limit

// Excluded test/fake portal IDs
const EXCLUDED_PORTALS = [
  '370b66bd-a47f-4ff8-8b0a-a5d439e15e57',
  '51e52be2-5999-4641-b256-0bdbcf60d391',
  'fe2fc1c3-f3c8-4306-a02e-b61e05d82d60',
  '57292abe-a999-4d31-8491-720da8a45326',
  '101e5b08-829e-49fe-bbc4-5b7d0cf71904',
  '07da4649-5a65-4303-b783-b7c520af73f7',
  '5a2ae4c4-8bcd-4928-98c2-282e10179321',
  'd1a5a666-1b65-4d39-bca8-4731ad966437',
  '6184f97a-176c-4019-81b2-40d05db4c5c9',
  '67beba74-c190-4311-9c75-bb40d8206613',
  'd37cb6ba-f184-452c-ba9d-b0cf43acf0cc',
  '4ab7223e-bcf5-4723-80b2-31127346b893',
  'f78d6778-a15d-4a25-8f3b-193c70f44940',
  '9fd0b24a-11f7-43e1-9d68-00022d9b8821',
  '0e6ca2a1-7e1e-4d42-a0f7-401ed3ede75d',
  'daa9515a-6896-4efe-a497-e4e8e05737ef',
  'ec639e9b-05c4-4049-8e8d-6f49e02a6380',
  '7477d99a-cee7-40b4-9557-02a09f61ea14',
  '1f25b2d3-56fc-4835-8eb7-074367c06a25',
  'cd2cfafa-4d53-457f-94bf-19fa164abd34'
];
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

  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const priorMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const IMPL_PRODUCT = process.env.STRIPE_IMPL_FEE_PRODUCT_ID || 'prod_O8U4J6dnCkPZ1l';

  // 1. Active subscriptions — page by page
  let currentMRR = 0, totalActiveSubs = 0, annualSubs = 0, monthlySubs = 0;
  let annualRevenue = 0, monthlyRevenue = 0;
  let newRevenueThisMonth = 0, newRevenuePriorMonth = 0, newMRRThisMonth = 0;
  let hasMore = true, startingAfter = '', pages = 0;

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

      const subCreated = new Date(sub.created * 1000);
      if (subCreated >= currentMonthStart) {
        newRevenueThisMonth += calcBillingAmount(sub);
        newMRRThisMonth += mrr;
      } else if (subCreated >= priorMonthStart && subCreated < currentMonthStart) {
        newRevenuePriorMonth += calcBillingAmount(sub);
      }

      if (subCreated >= yearStart) {
        const wi = findWeekIndex(weeks, subCreated);
        if (wi !== -1) {
          weeklyData[wi].newSubs += 1;
          weeklyData[wi].newMRR += mrr;
        }
      }

      let isAnnual = false;
      if (sub.items && sub.items.data) {
        for (const item of sub.items.data) {
          const price = item.price || item.plan;
          if (!price) continue;
          const interval = (price.recurring && price.recurring.interval) || price.interval || 'month';
          if (interval === 'year') { isAnnual = true; break; }
        }
      }
      if (isAnnual) { annualSubs += 1; annualRevenue += mrr * 12; }
      else { monthlySubs += 1; monthlyRevenue += mrr; }
    }
    hasMore = data.has_more;
    if (data.data.length > 0) startingAfter = data.data[data.data.length - 1].id;
    pages++;
  }

  // 2. Implementation fee invoices (with line expansion, max 3 pages)
  hasMore = true;
  startingAfter = '';
  pages = 0;
  let totalImplFeeRevenue = 0, totalImplFeeCount = 0;

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

  // Roll current month's impl fee revenue into MRR
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  let monthImplFees = 0;
  for (let i = 0; i < weeklyData.length; i++) {
    const ws = new Date(weeks[i]?.start || 0);
    if (ws >= monthStart) monthImplFees += weeklyData[i].implFeeRevenue;
  }

  const ADDON_ADJUSTMENT = 14000;
  const mrrWithImpl = currentMRR + monthImplFees + ADDON_ADJUSTMENT;
  const priorMonthMRR = mrrWithImpl - newMRRThisMonth;

  return {
    currentMRR: Math.round(mrrWithImpl),
    currentARR: Math.round(mrrWithImpl * 12),
    priorMonthMRR: Math.round(priorMonthMRR),
    subscriptionMRR: Math.round(currentMRR),
    implFeesMRR: Math.round(monthImplFees),
    totalActiveSubs, annualSubs, monthlySubs,
    annualRevenue: Math.round(annualRevenue),
    monthlyRevenue: Math.round(monthlyRevenue),
    newRevenueThisMonth: Math.round(newRevenueThisMonth),
    newRevenuePriorMonth: Math.round(newRevenuePriorMonth),
    implFeeCount: totalImplFeeCount,
    implFeeRevenue: Math.round(totalImplFeeRevenue),
    timings, weeks: weeklyData
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

  // 1. Searches — from quick_search_result table, excluding test portals
  const excludedFilter = 'not.in.(' + EXCLUDED_PORTALS.join(',') + ')';
  let offset = 0;
  const batchSize = 1000;
  let keepGoing = true;
  let pages = 0;

  while (keepGoing && pages < 10) {
    const url = SUPA_URL + '/rest/v1/quick_search_result?select=id,createdAt,portalId' +
      '&createdAt=gte.' + yearStart.toISOString() +
      '&portalId=' + excludedFilter +
      '&order=createdAt.asc' +
      '&offset=' + offset + '&limit=' + batchSize;

    const resp = await fetchWithTimeout(url, { headers });
    if (!resp.ok) { console.error('Supabase quick_search_result error:', resp.status); break; }
    const data = await resp.json();
    if (!data || data.length === 0) { keepGoing = false; break; }

    for (const row of data) {
      const ts = new Date(row.createdAt);
      const wi = findWeekIndex(weeks, ts);
      if (wi !== -1) weeklyData[wi].searches += 1;
    }

    offset += batchSize;
    if (data.length < batchSize) keepGoing = false;
    pages++;
  }

  // 2. New estates/matters (excluding test portals) — paginated
  //    Estate types: TRUPLANNING, TRUADMIN, TRUSTADMIN, TRUPROXY
  //    Column is "type" on the estate table
  offset = 0;
  keepGoing = true;
  pages = 0;
  let totalEstates = 0;
  let estatesByType = { TRUPLANNING: 0, TRUADMIN: 0, TRUSTADMIN: 0, TRUPROXY: 0, OTHER: 0 };

  while (keepGoing && pages < 15) {
    const estateUrl = SUPA_URL + '/rest/v1/estate?select=id,createdAt,portalId,type' +
      '&createdAt=gte.' + yearStart.toISOString() +
      '&portalId=' + excludedFilter +
      '&order=createdAt.asc' +
      '&offset=' + offset + '&limit=' + batchSize;

    const estateResp = await fetchWithTimeout(estateUrl, { headers });
    if (!estateResp.ok) { console.error('Supabase estate error:', estateResp.status); break; }
    const estates = await estateResp.json();
    if (!estates || estates.length === 0) { keepGoing = false; break; }

    for (const estate of estates) {
      const ts = new Date(estate.createdAt);
      const wi = findWeekIndex(weeks, ts);
      if (wi !== -1) weeklyData[wi].newEstates += 1;
      totalEstates += 1;

      // Track by type
      const etype = (estate.type || '').toUpperCase();
      if (estatesByType.hasOwnProperty(etype)) {
        estatesByType[etype] += 1;
      } else {
        estatesByType.OTHER += 1;
      }
    }

    offset += batchSize;
    if (estates.length < batchSize) keepGoing = false;
    pages++;
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

  return { totalEstates, estatesByType, weeks: weeklyData };
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

// Actual billing amount (what Stripe charges per billing cycle, not normalized to monthly)
// This matches Stripe's "subscription creation" payment amounts
function calcBillingAmount(sub) {
  let total = 0;
  if (sub.items && sub.items.data) {
    for (const item of sub.items.data) {
      const price = item.price || item.plan;
      if (!price) continue;
      const amount = (price.unit_amount || 0) / 100;
      const qty = item.quantity || 1;
      total += amount * qty;
    }
  }
  return Math.round(total * 100) / 100;
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
