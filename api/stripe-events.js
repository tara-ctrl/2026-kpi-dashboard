// /api/stripe-events — Subscription metrics matching Stripe's report definitions
// Classifies events at the CUSTOMER level (not subscription level) to match
// Stripe's subscription metrics: Churn, New, Reactivation, Upgrade, Downgrade
// Also tracks failed payments separately

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
    // Fetch ALL subscription event types for the month + failed payments in parallel
    // Also fetch YTD cancellations for weekly chart and prior-customer detection
    const [deletedEvents, createdEvents, updatedEvents, deletedYTD, failedPaymentEvents] = await Promise.all([
      paginatedFetch('https://api.stripe.com/v1/events?type=customer.subscription.deleted&created[gte]=' + currentMonthUnix + '&limit=100', 2, 'del', headers, timings),
      paginatedFetch('https://api.stripe.com/v1/events?type=customer.subscription.created&created[gte]=' + currentMonthUnix + '&limit=100', 2, 'cre', headers, timings),
      paginatedFetch('https://api.stripe.com/v1/events?type=customer.subscription.updated&created[gte]=' + currentMonthUnix + '&limit=100', 3, 'upd', headers, timings),
      paginatedFetch('https://api.stripe.com/v1/events?type=customer.subscription.deleted&created[gte]=' + yearStartUnix + '&limit=100', 3, 'del_ytd', headers, timings),
      paginatedFetch('https://api.stripe.com/v1/events?type=invoice.payment_failed&created[gte]=' + currentMonthUnix + '&limit=100', 2, 'fail', headers, timings)
    ]);

    // Build set of customers who canceled before this month (for reactivation detection)
    const priorCanceledCustomers = new Set();
    for (const event of deletedYTD) {
      const sub = event.data && event.data.object;
      if (!sub) continue;
      const canceledAt = sub.canceled_at || event.created;
      if (canceledAt < currentMonthUnix) {
        priorCanceledCustomers.add(sub.customer);
      }
    }

    // ============================================================
    // CUSTOMER-LEVEL MRR CLASSIFICATION (matches Stripe's metrics)
    // ============================================================
    // Collect all MRR changes per customer this month, then classify

    // Track per-customer: { mrrChanges: [{amount, timestamp, type}] }
    const customerEvents = {};

    function addCustomerEvent(customerId, mrrChange, timestamp, eventType) {
      if (!customerEvents[customerId]) customerEvents[customerId] = [];
      customerEvents[customerId].push({ mrrChange, timestamp, eventType });
    }

    // Deleted subs = negative MRR
    for (const event of deletedEvents) {
      const sub = event.data && event.data.object;
      if (!sub) continue;
      const mrr = calcMRR(sub);
      addCustomerEvent(sub.customer, -mrr, event.created, 'deleted');
    }

    // Created subs = positive MRR
    for (const event of createdEvents) {
      const sub = event.data && event.data.object;
      if (!sub) continue;
      const mrr = calcMRR(sub);
      addCustomerEvent(sub.customer, mrr, event.created, 'created');
    }

    // Updated subs = MRR diff (upgrade or downgrade)
    for (const event of updatedEvents) {
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

      addCustomerEvent(sub.customer, diff, event.created, 'updated');
    }

    // Now classify each customer's net MRR movement
    let churnCount = 0, churnMRR = 0;
    let newCount = 0, newMRR = 0;
    let reactivationCount = 0, reactivationMRR = 0;
    let upgradeCount = 0, upgradeMRR = 0;
    let downgradeCount = 0, downgradeMRR = 0;

    const weeklyChurn = weeks.map(() => 0);
    const weeklyUpgrades = weeks.map(() => 0);
    const weeklyDowngrades = weeks.map(() => 0);

    for (const [customerId, events] of Object.entries(customerEvents)) {
      const netMRR = events.reduce((sum, e) => sum + e.mrrChange, 0);
      const hasCreated = events.some(e => e.eventType === 'created');
      const hasDeleted = events.some(e => e.eventType === 'deleted');
      const wasPreviousCustomer = priorCanceledCustomers.has(customerId);

      // Use the latest event timestamp for weekly bucketing
      const latestTimestamp = Math.max(...events.map(e => e.timestamp));
      const eventDate = new Date(latestTimestamp * 1000);
      const wi = findWeekIndex(weeks, eventDate);

      if (Math.abs(netMRR) < 0.50) continue; // Ignore tiny rounding differences

      if (netMRR < 0 && hasDeleted && !hasCreated) {
        // Customer lost MRR and deleted a sub without creating a new one = Churn
        churnCount += 1;
        churnMRR += Math.abs(netMRR);
        if (wi !== -1) weeklyChurn[wi] += 1;
      } else if (netMRR < 0 && !hasDeleted) {
        // MRR decreased but sub still active = Downgrade
        downgradeCount += 1;
        downgradeMRR += Math.abs(netMRR);
        if (wi !== -1) weeklyDowngrades[wi] += 1;
      } else if (netMRR < 0 && hasDeleted && hasCreated) {
        // Deleted old sub AND created new one, but net negative = Downgrade
        downgradeCount += 1;
        downgradeMRR += Math.abs(netMRR);
        if (wi !== -1) weeklyDowngrades[wi] += 1;
      } else if (netMRR > 0 && hasCreated && wasPreviousCustomer) {
        // Positive MRR, new sub, had a prior cancellation = Reactivation
        reactivationCount += 1;
        reactivationMRR += netMRR;
      } else if (netMRR > 0 && hasCreated && !wasPreviousCustomer) {
        // Positive MRR, new sub, no prior history = New
        newCount += 1;
        newMRR += netMRR;
      } else if (netMRR > 0 && !hasCreated) {
        // MRR increased, no new sub = Upgrade
        upgradeCount += 1;
        upgradeMRR += netMRR;
        if (wi !== -1) weeklyUpgrades[wi] += 1;
      } else if (netMRR > 0 && hasCreated && hasDeleted) {
        // Deleted old sub AND created new one, net positive = Upgrade
        upgradeCount += 1;
        upgradeMRR += netMRR;
        if (wi !== -1) weeklyUpgrades[wi] += 1;
      }
    }

    // YTD weekly cancellations for chart
    const weeklyChurnYTD = weeks.map(() => 0);
    for (const event of deletedYTD) {
      const sub = event.data && event.data.object;
      if (!sub) continue;
      const canceledAt = sub.canceled_at || event.created;
      const cancelDate = new Date(canceledAt * 1000);
      const cwi = findWeekIndex(weeks, cancelDate);
      if (cwi !== -1) weeklyChurnYTD[cwi] += 1;
    }

    // Failed payments
    let failedPaymentCount = 0;
    let failedPaymentAmount = 0;
    for (const event of failedPaymentEvents) {
      const invoice = event.data && event.data.object;
      if (!invoice) continue;
      failedPaymentCount += 1;
      failedPaymentAmount += (invoice.amount_due || 0) / 100;
    }

    timings.push('total:' + (Date.now() - t0) + 'ms');

    res.status(200).json({
      // Matches Stripe's subscription metrics categories
      churnCount, churnMRR: Math.round(churnMRR),
      newCount, newMRR: Math.round(newMRR),
      reactivationCount, reactivationMRR: Math.round(reactivationMRR),
      upgradeCount, upgradeMRR: Math.round(upgradeMRR),
      downgradeCount, downgradeMRR: Math.round(downgradeMRR),
      failedPaymentCount, failedPaymentAmount: Math.round(failedPaymentAmount),
      // Legacy fields for backwards compatibility
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
