// /api/stripe-events — Reads subscription metrics from Supabase
// Data uploaded weekly from Stripe's subscription metrics report
// Also fetches failed payments live from Stripe Events API

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SK = process.env.STRIPE_SECRET_KEY;

  if (!SUPA_URL || !SUPA_KEY) return res.status(500).json({ error: 'Supabase not configured' });

  const now = new Date();
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const currentMonthUnix = Math.floor(currentMonthStart.getTime() / 1000);
  const weeks = getWeekBuckets(yearStart);

  const headers = {
    'apikey': SUPA_KEY,
    'Authorization': 'Bearer ' + SUPA_KEY,
    'Content-Type': 'application/json'
  };

  try {
    // Fetch current month MRR events from Supabase
    const eventsUrl = SUPA_URL + '/rest/v1/stripe_mrr_events?select=*' +
      '&event_timestamp=gte.' + currentMonthStart.toISOString() +
      '&order=event_timestamp.asc&limit=1000';

    const eventsResp = await fetch(eventsUrl, { headers });
    const events = eventsResp.ok ? await eventsResp.json() : [];

    // Tally by event type
    let churnCount = 0, churnMRR = 0;
    let newCount = 0, newMRR = 0;
    let reactivationCount = 0, reactivationMRR = 0;
    let upgradeCount = 0, upgradeMRR = 0;
    let downgradeCount = 0, downgradeMRR = 0;

    const weeklyChurn = weeks.map(() => 0);
    const weeklyUpgrades = weeks.map(() => 0);

    for (const evt of events) {
      const mrr = Math.abs(evt.mrr_change || 0);
      const ts = new Date(evt.event_timestamp);
      const wi = findWeekIndex(weeks, ts);

      switch (evt.event_type) {
        case 'Churn':
          churnCount += 1; churnMRR += mrr;
          if (wi !== -1) weeklyChurn[wi] += 1;
          break;
        case 'New':
          newCount += 1; newMRR += mrr;
          break;
        case 'Reactivation':
          reactivationCount += 1; reactivationMRR += mrr;
          break;
        case 'Upgrade':
          upgradeCount += 1; upgradeMRR += mrr;
          if (wi !== -1) weeklyUpgrades[wi] += 1;
          break;
        case 'Downgrade':
          downgradeCount += 1; downgradeMRR += mrr;
          break;
      }
    }

    // Also fetch YTD churn for weekly chart
    const ytdUrl = SUPA_URL + '/rest/v1/stripe_mrr_events?select=event_timestamp,event_type' +
      '&event_timestamp=gte.' + yearStart.toISOString() +
      '&event_type=eq.Churn' +
      '&order=event_timestamp.asc&limit=5000';
    const ytdResp = await fetch(ytdUrl, { headers });
    const ytdChurn = ytdResp.ok ? await ytdResp.json() : [];

    const weeklyChurnYTD = weeks.map(() => 0);
    for (const evt of ytdChurn) {
      const ts = new Date(evt.event_timestamp);
      const cwi = findWeekIndex(weeks, ts);
      if (cwi !== -1) weeklyChurnYTD[cwi] += 1;
    }

    // Fetch failed payments live from Stripe (these change daily, not worth uploading)
    let failedPaymentCount = 0, failedPaymentAmount = 0;
    if (SK) {
      const stripeHeaders = { 'Authorization': 'Bearer ' + SK };
      try {
        const failUrl = 'https://api.stripe.com/v1/events?type=invoice.payment_failed' +
          '&created[gte]=' + currentMonthUnix + '&limit=100';
        const failResp = await fetch(failUrl, { headers: stripeHeaders });
        const failData = await failResp.json();
        if (failData.data) {
          const seen = new Set();
          for (const event of failData.data) {
            const inv = event.data && event.data.object;
            if (!inv) continue;
            if (!seen.has(inv.customer)) {
              seen.add(inv.customer);
              failedPaymentCount += 1;
              failedPaymentAmount += (inv.amount_due || 0) / 100;
            }
          }
        }
      } catch (e) { /* Failed payments are nice-to-have, don't break if Stripe fails */ }
    }

    const hasData = events.length > 0;

    res.status(200).json({
      hasData,
      dataSource: hasData ? 'supabase_upload' : 'no_data',
      eventCount: events.length,
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
      weeks: weeks.map((w, i) => ({
        weekOf: w.label,
        cancellations: weeklyChurnYTD[i],
        upgrades: weeklyUpgrades[i],
        downgrades: 0
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
