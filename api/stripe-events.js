// /api/stripe-events — Subscription metrics matching Stripe's report
// Maps directly to Stripe's event types:
//   customer.subscription.deleted (with MRR > 0) → Churn
//   customer.subscription.created → New or Reactivation
//   customer.subscription.updated (MRR change) → Upgrade or Downgrade
//   invoice.payment_failed → Failed Payment

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
    const [deletedMonth, createdMonth, updatedMonth, deletedYTD, failedMonth] = await Promise.all([
      paginatedFetch('https://api.stripe.com/v1/events?type=customer.subscription.deleted&created[gte]=' + currentMonthUnix + '&limit=100', 2, 'del', headers, timings),
      paginatedFetch('https://api.stripe.com/v1/events?type=customer.subscription.created&created[gte]=' + currentMonthUnix + '&limit=100', 2, 'cre', headers, timings),
      paginatedFetch('https://api.stripe.com/v1/events?type=customer.subscription.updated&created[gte]=' + currentMonthUnix + '&limit=100', 4, 'upd', headers, timings),
      paginatedFetch('https://api.stripe.com/v1/events?type=customer.subscription.deleted&created[gte]=' + yearStartUnix + '&limit=100', 5, 'del_ytd', headers, timings),
      paginatedFetch('https://api.stripe.com/v1/events?type=invoice.payment_failed&created[gte]=' + currentMonthUnix + '&limit=100', 2, 'fail', headers, timings)
    ]);

    // Build set of customers who canceled before this month (for reactivation detection)
    // Use both YTD deletion events AND a quick scan of canceled subs
    const priorCanceledCustomers = new Set();
    for (const event of deletedYTD) {
      const sub = event.data && event.data.object;
      if (!sub) continue;
      if (event.created < currentMonthUnix) priorCanceledCustomers.add(sub.customer);
    }
    // Also scan canceled subs directly (catches cancellations from before YTD)
    const canceledSubs = await paginatedFetch(
      'https://api.stripe.com/v1/subscriptions?status=canceled&limit=100',
      3, 'canceled_scan', headers, timings
    );
    for (const sub of canceledSubs) {
      const canceledAt = sub.canceled_at || 0;
      if (canceledAt > 0 && canceledAt < currentMonthUnix) {
        priorCanceledCustomers.add(sub.customer);
      }
    }
    // Also add customers from current month deletions that happened BEFORE their creation
    const deletedTimestamps = {};
    for (const event of deletedMonth) {
      const sub = event.data && event.data.object;
      if (sub) deletedTimestamps[sub.customer] = event.created;
    }

    // ============================================================
    // CHURN: deleted subs with MRR > 0 (filters out $0 plan switches)
    // ============================================================
    let churnCount = 0, churnMRR = 0;
    const weeklyChurn = weeks.map(() => 0);

    for (const event of deletedMonth) {
      const sub = event.data && event.data.object;
      if (!sub) continue;
      const mrr = calcMRR(sub);
      if (mrr < 1) continue; // Skip $0 MRR subscriptions (plan switches, trials)

      churnCount += 1;
      churnMRR += mrr;
      const cancelDate = new Date(event.created * 1000);
      const wi = findWeekIndex(weeks, cancelDate);
      if (wi !== -1) weeklyChurn[wi] += 1;
    }

    // YTD weekly churn for chart
    const weeklyChurnYTD = weeks.map(() => 0);
    for (const event of deletedYTD) {
      const sub = event.data && event.data.object;
      if (!sub) continue;
      const mrr = calcMRR(sub);
      if (mrr < 1) continue;
      const cancelDate = new Date(event.created * 1000);
      const cwi = findWeekIndex(weeks, cancelDate);
      if (cwi !== -1) weeklyChurnYTD[cwi] += 1;
    }

    // ============================================================
    // NEW & REACTIVATION: created subs
    // ============================================================
    let newCount = 0, newMRR = 0;
    let reactivationCount = 0, reactivationMRR = 0;

    for (const event of createdMonth) {
      const sub = event.data && event.data.object;
      if (!sub) continue;
      const mrr = calcMRR(sub);
      if (mrr < 1) continue;

      // Check if customer had a prior cancellation (before this month)
      // OR had a deletion earlier in the same month (churn then reactivate)
      const hadPriorCancel = priorCanceledCustomers.has(sub.customer);
      const deletedEarlierThisMonth = deletedTimestamps[sub.customer] && deletedTimestamps[sub.customer] < event.created;

      if (hadPriorCancel || deletedEarlierThisMonth) {
        reactivationCount += 1;
        reactivationMRR += mrr;
      } else {
        newCount += 1;
        newMRR += mrr;
      }
    }

    // ============================================================
    // UPGRADES: updated subs with MRR increase
    // Stripe counts EACH individual price change event
    // Strategy: for each updated event, try multiple methods to detect MRR change
    // ============================================================
    let upgradeCount = 0, upgradeMRR = 0;
    let downgradeCount = 0, downgradeMRR = 0;
    const weeklyUpgrades = weeks.map(() => 0);
    const weeklyDowngrades = weeks.map(() => 0);

    for (const event of updatedMonth) {
      const sub = event.data && event.data.object;
      const prev = event.data && event.data.previous_attributes;
      if (!sub || !prev) continue;

      let currMRR = calcMRR(sub);
      let prevMRR = -1; // -1 = not determined

      // Method 1: previous_attributes has full items array
      if (prev.items && prev.items.data && prev.items.data.length > 0) {
        prevMRR = 0;
        for (const item of prev.items.data) {
          const price = item.price || item.plan;
          if (!price) continue;
          const amount = (price.unit_amount || 0) / 100;
          const interval = (price.recurring && price.recurring.interval) || price.interval || 'month';
          const qty = item.quantity || 1;
          prevMRR += interval === 'year' ? (amount * qty) / 12 : amount * qty;
        }
      }

      // Method 2: previous_attributes has plan object
      if (prevMRR < 0 && prev.plan) {
        const amount = (prev.plan.amount || 0) / 100;
        const interval = prev.plan.interval || 'month';
        const qty = sub.quantity || 1;
        prevMRR = interval === 'year' ? (amount * qty) / 12 : amount * qty;
      }

      // Method 3: quantity changed — use current price with old quantity
      if (prevMRR < 0 && prev.quantity !== undefined && sub.items && sub.items.data) {
        prevMRR = 0;
        for (const item of sub.items.data) {
          const price = item.price || item.plan;
          if (!price) continue;
          const amount = (price.unit_amount || 0) / 100;
          const interval = (price.recurring && price.recurring.interval) || price.interval || 'month';
          prevMRR += interval === 'year' ? (amount * prev.quantity) / 12 : amount * prev.quantity;
        }
      }

      // Method 4: items changed but prev.items.data items don't have price details
      // Check if the price ID changed — indicates a plan switch
      if (prevMRR < 0 && prev.items) {
        // prev.items might have a different structure — try to detect any change
        // If we can't compute prev MRR but items DID change, use the event's
        // previous_attributes to at least detect the direction
        // Skip — we can't determine the MRR diff reliably
        continue;
      }

      if (prevMRR < 0) continue; // Couldn't determine previous MRR

      const diff = Math.round((currMRR - prevMRR) * 100) / 100;
      if (Math.abs(diff) < 0.50) continue;

      const eventDate = new Date(event.created * 1000);
      const wi = findWeekIndex(weeks, eventDate);

      if (diff > 0) {
        upgradeCount += 1;
        upgradeMRR += diff;
        if (wi !== -1) weeklyUpgrades[wi] += 1;
      } else {
        downgradeCount += 1;
        downgradeMRR += Math.abs(diff);
        if (wi !== -1) weeklyDowngrades[wi] += 1;
      }
    }

    // ============================================================
    // FAILED PAYMENTS (separate metric)
    // Deduplicate by customer to match Stripe's report
    // ============================================================
    let failedPaymentCount = 0;
    let failedPaymentAmount = 0;
    const failedCustomersSeen = new Set();

    for (const event of failedMonth) {
      const invoice = event.data && event.data.object;
      if (!invoice) continue;
      // Count unique customers with failed payments (not every retry)
      const custId = invoice.customer;
      if (!failedCustomersSeen.has(custId)) {
        failedCustomersSeen.add(custId);
        failedPaymentCount += 1;
        failedPaymentAmount += (invoice.amount_due || 0) / 100;
      }
    }

    timings.push('total:' + (Date.now() - t0) + 'ms');

    res.status(200).json({
      churnCount, churnMRR: Math.round(churnMRR),
      newCount, newMRR: Math.round(newMRR),
      reactivationCount, reactivationMRR: Math.round(reactivationMRR),
      upgradeCount, upgradeMRR: Math.round(upgradeMRR),
      downgradeCount, downgradeMRR: Math.round(downgradeMRR),
      failedPaymentCount, failedPaymentAmount: Math.round(failedPaymentAmount),
      // Fields for frontend merge
      cancelTotal: churnCount,
      cancelVoluntary: churnCount,
      cancelFailedPayment: 0,
      cancelOther: 0,
      cancelMRRLost: Math.round(churnMRR),
      totalUpgrades: upgradeCount,
      totalDowngrades: downgradeCount,
      resubscribeCount: reactivationCount,
      resubscribeMRR: Math.round(reactivationMRR),
      timings,
      weeks: weeks.map((w, i) => ({
        weekOf: w.label,
        cancellations: weeklyChurnYTD[i],
        upgrades: weeklyUpgrades[i],
        downgrades: weeklyDowngrades[i]
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message, timings });
  }
};

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
