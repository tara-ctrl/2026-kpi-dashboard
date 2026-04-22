// /api/stripe — Fetches MRR, subscription events, and impl fees from Stripe
// Uses native fetch — no npm packages required

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const SK = process.env.STRIPE_SECRET_KEY;
    if (!SK) throw new Error('STRIPE_SECRET_KEY not configured');

    const headers = { 'Authorization': 'Bearer ' + SK };
    const now = new Date();
    const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const yearStartUnix = Math.floor(yearStart.getTime() / 1000);
    const weeks = getWeekBuckets(yearStart);

    const weeklyData = weeks.map(w => ({
      weekOf: w.label, newMRR: 0, churn: 0, upgrade: 0, downgrade: 0,
      reactivation: 0, implFeeCount: 0, implFeeRevenue: 0,
      cancellations: 0, upgrades: 0, downgrades: 0, reactivations: 0, newSubs: 0
    }));

    // --- 1. Active subscriptions for current MRR ---
    let currentMRR = 0;
    let hasMore = true;
    let startingAfter = '';

    while (hasMore) {
      const url = 'https://api.stripe.com/v1/subscriptions?status=active&limit=100' +
        (startingAfter ? '&starting_after=' + startingAfter : '');
      const resp = await fetch(url, { headers });
      const data = await resp.json();
      if (data.error) throw new Error(data.error.message);

      for (const sub of data.data) {
        currentMRR += calcMRR(sub);
      }
      hasMore = data.has_more;
      if (data.data.length > 0) startingAfter = data.data[data.data.length - 1].id;
    }

    // --- 2. Subscription events (created, deleted, updated) ---
    const eventTypes = [
      'customer.subscription.created',
      'customer.subscription.deleted',
      'customer.subscription.updated'
    ];

    for (const eventType of eventTypes) {
      hasMore = true;
      startingAfter = '';
      while (hasMore) {
        const url = 'https://api.stripe.com/v1/events?type=' + eventType +
          '&created[gte]=' + yearStartUnix + '&limit=100' +
          (startingAfter ? '&starting_after=' + startingAfter : '');
        const resp = await fetch(url, { headers });
        const data = await resp.json();
        if (data.error) throw new Error(data.error.message);

        for (const event of data.data) {
          const createdAt = new Date(event.created * 1000);
          const wi = findWeekIndex(weeks, createdAt);
          if (wi === -1) continue;
          const sub = event.data.object;

          if (event.type === 'customer.subscription.created') {
            weeklyData[wi].newSubs += 1;
            weeklyData[wi].newMRR += calcMRR(sub);
          } else if (event.type === 'customer.subscription.deleted') {
            weeklyData[wi].cancellations += 1;
            weeklyData[wi].churn -= calcMRR(sub);
          } else if (event.type === 'customer.subscription.updated') {
            const prev = event.data.previous_attributes;
            if (prev && prev.status === 'canceled' && sub.status === 'active') {
              weeklyData[wi].reactivations += 1;
              weeklyData[wi].reactivation += calcMRR(sub);
            } else if (prev && (prev.items || prev.plan)) {
              const newMrr = calcMRR(sub);
              const diff = newMrr - calcMRR(sub); // approximate
              if (diff > 0) { weeklyData[wi].upgrades += 1; weeklyData[wi].upgrade += diff; }
              else if (diff < 0) { weeklyData[wi].downgrades += 1; weeklyData[wi].downgrade += diff; }
            }
          }
        }
        hasMore = data.has_more;
        if (data.data.length > 0) startingAfter = data.data[data.data.length - 1].id;
      }
    }

    // --- 3. Invoices for implementation fees ---
    const IMPL_PRODUCT = process.env.STRIPE_IMPL_FEE_PRODUCT_ID || 'prod_O8U4J6dnCkPZ1l';
    hasMore = true;
    startingAfter = '';

    while (hasMore) {
      const url = 'https://api.stripe.com/v1/invoices?status=paid&created[gte]=' + yearStartUnix +
        '&limit=100&expand[]=data.lines' +
        (startingAfter ? '&starting_after=' + startingAfter : '');
      const resp = await fetch(url, { headers });
      const data = await resp.json();
      if (data.error) throw new Error(data.error.message);

      for (const inv of data.data) {
        const createdAt = new Date(inv.created * 1000);
        const wi = findWeekIndex(weeks, createdAt);
        if (wi === -1) continue;

        if (inv.lines && inv.lines.data) {
          for (const line of inv.lines.data) {
            const productId = (line.price && line.price.product) || (line.plan && line.plan.product);
            if (productId === IMPL_PRODUCT) {
              weeklyData[wi].implFeeCount += 1;
              weeklyData[wi].implFeeRevenue += (line.amount || 0) / 100;
            }
          }
        }
      }
      hasMore = data.has_more;
      if (data.data.length > 0) startingAfter = data.data[data.data.length - 1].id;
    }

    // Add current month impl fees to MRR
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    let monthImplFees = 0;
    for (const wd of weeklyData) {
      const ws = new Date(weeks[weeklyData.indexOf(wd)]?.start || 0);
      if (ws >= monthStart) monthImplFees += wd.implFeeRevenue;
    }

    res.status(200).json({
      currentMRR: Math.round(currentMRR + monthImplFees),
      currentARR: Math.round((currentMRR + monthImplFees) * 12),
      weeks: weeklyData
    });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Stripe API failed', details: err.message });
  }
};

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
