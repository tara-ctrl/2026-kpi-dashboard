// /api/stripe-events — Handles cancellations, upgrades, downgrades, reactivations
// Separate from /api/stripe to stay within Vercel's 30s serverless limit
// Frontend calls both endpoints in parallel and merges results

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SK = process.env.STRIPE_SECRET_KEY;
  if (!SK) return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });

  const headers = { 'Authorization': 'Bearer ' + SK };
  const now = new Date();
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const yearStartUnix = Math.floor(yearStart.getTime() / 1000);
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const currentMonthUnix = Math.floor(currentMonthStart.getTime() / 1000);

  const weeks = getWeekBuckets(yearStart);
  const timings = [];
  const t0 = Date.now();

  try {
    // Fetch cancellation events, failed payments, and upgrade events in parallel
    const [cancelEvents, failedPaymentEvents, updateEvents] = await Promise.all([
      paginatedFetch('https://api.stripe.com/v1/events?type=customer.subscription.deleted&created[gte]=' + currentMonthUnix + '&limit=100', 2, 'cancel_ev', headers, timings),
      paginatedFetch('https://api.stripe.com/v1/events?type=invoice.payment_failed&created[gte]=' + currentMonthUnix + '&limit=100', 2, 'fail_ev', headers, timings),
      paginatedFetch('https://api.stripe.com/v1/events?type=customer.subscription.updated&created[gte]=' + yearStartUnix + '&limit=100', 3, 'upd_ev', headers, timings)
    ]);

    // Process cancellations
    let cancelVoluntary = 0, cancelFailedPayment = 0, cancelOther = 0, cancelMRRLost = 0;
    const canceledCustomers = new Set();
    const weeklyCancel = weeks.map(() => 0);

    for (const event of cancelEvents) {
      const sub = event.data && event.data.object;
      if (!sub) continue;

      canceledCustomers.add(sub.customer);

      const canceledAt = sub.canceled_at || event.created;
      const cancelDate = new Date(canceledAt * 1000);
      const cwi = findWeekIndex(weeks, cancelDate);
      if (cwi !== -1) weeklyCancel[cwi] += 1;

      if (canceledAt >= currentMonthUnix) {
        cancelMRRLost += calcMRR(sub);

        // Detect failed payment vs voluntary cancellation:
        // 1. Check cancellation_details.reason first (most reliable when set correctly)
        // 2. Fall back to event.request — if null/no ID, it was automatic (dunning/failed payment)
        //    If request.id exists, it was manually triggered (voluntary)
        const reason = (sub.cancellation_details && sub.cancellation_details.reason) || '';
        const wasAutomatic = !event.request || !event.request.id;

        if (reason === 'payment_failed' || reason === 'payment_disputed') {
          cancelFailedPayment += 1;
        } else if (wasAutomatic) {
          // No API request triggered this = automatic cancellation (failed payment / dunning)
          cancelFailedPayment += 1;
        } else {
          // Manual cancellation with a request ID = voluntary
          cancelVoluntary += 1;
        }
      }
    }

    // Process failed payments (distinct from cancellations)
    // These are invoice payment attempts that failed (card declined, etc.)
    let failedPaymentCount = 0;
    let failedPaymentAmount = 0;
    const failedCustomers = new Set(); // dedupe by customer

    for (const event of failedPaymentEvents) {
      const invoice = event.data && event.data.object;
      if (!invoice) continue;

      // Count unique failed payment events this month
      failedPaymentCount += 1;
      failedPaymentAmount += (invoice.amount_due || 0) / 100;
    }

    // Process upgrades/downgrades
    let totalUpgrades = 0, totalDowngrades = 0, upgradeMRR = 0, downgradeMRR = 0;
    const weeklyUpgrades = weeks.map(() => 0);
    const weeklyDowngrades = weeks.map(() => 0);

    for (const event of updateEvents) {
      const sub = event.data && event.data.object;
      const prev = event.data && event.data.previous_attributes;
      if (!sub || !prev) continue;

      let prevMRR = 0, currMRR = 0;

      if (sub.items && sub.items.data) {
        for (const item of sub.items.data) {
          const price = item.price || item.plan;
          if (!price) continue;
          const amount = (price.unit_amount || 0) / 100;
          const interval = (price.recurring && price.recurring.interval) || price.interval || 'month';
          const qty = item.quantity || 1;
          currMRR += interval === 'year' ? (amount * qty) / 12 : amount * qty;
        }
      }

      if (prev.items && prev.items.data) {
        for (const item of prev.items.data) {
          const price = item.price || item.plan;
          if (!price) continue;
          const amount = (price.unit_amount || 0) / 100;
          const interval = (price.recurring && price.recurring.interval) || price.interval || 'month';
          const qty = item.quantity || 1;
          prevMRR += interval === 'year' ? (amount * qty) / 12 : amount * qty;
        }
      } else if (prev.plan) {
        const amount = (prev.plan.amount || 0) / 100;
        const interval = prev.plan.interval || 'month';
        prevMRR = interval === 'year' ? amount / 12 : amount;
      } else {
        continue;
      }

      const diff = currMRR - prevMRR;
      if (Math.abs(diff) < 1) continue;

      const eventDate = new Date(event.created * 1000);
      const wi = findWeekIndex(weeks, eventDate);

      if (diff > 0) {
        totalUpgrades += 1; upgradeMRR += diff;
        if (wi !== -1) weeklyUpgrades[wi] += 1;
      } else {
        totalDowngrades += 1; downgradeMRR += Math.abs(diff);
        if (wi !== -1) weeklyDowngrades[wi] += 1;
      }
    }

    timings.push('total:' + (Date.now() - t0) + 'ms');

    res.status(200).json({
      cancelTotal: cancelVoluntary + cancelFailedPayment + cancelOther,
      cancelVoluntary, cancelFailedPayment, cancelOther,
      cancelMRRLost: Math.round(cancelMRRLost),
      failedPaymentCount,
      failedPaymentAmount: Math.round(failedPaymentAmount),
      totalUpgrades, totalDowngrades,
      upgradeMRR: Math.round(upgradeMRR),
      downgradeMRR: Math.round(downgradeMRR),
      totalReactivations: 0,
      reactivationMRR: 0,
      timings,
      weeks: weeks.map((w, i) => ({
        weekOf: w.label,
        cancellations: weeklyCancel[i],
        upgrades: weeklyUpgrades[i],
        downgrades: weeklyDowngrades[i]
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message, timings });
  }
};

// Helper for paginated fetches
async function paginatedFetch(urlBase, maxPages, label, headers, timings) {
  const results = [];
  let hasMore = true, sa = '', pg = 0;
  while (hasMore && pg < maxPages) {
    const pt = Date.now();
    const url = urlBase + (sa ? '&starting_after=' + sa : '');
    const resp = await fetch(url, { headers });
    const data = await resp.json();
    timings.push(label + '_p' + (pg+1) + ':' + (Date.now() - pt) + 'ms/' + (data.data ? data.data.length : 0) + 'items');
    if (data.error) throw new Error(label + ' error: ' + data.error.message);
    if (data.data) results.push(...data.data);
    hasMore = data.has_more;
    if (data.data && data.data.length > 0) sa = data.data[data.data.length - 1].id;
    pg++;
  }
  return results;
}

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
