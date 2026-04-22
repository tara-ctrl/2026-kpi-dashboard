// /api/hubspot — Fetches demos, info sessions, and deals from HubSpot CRM
// Uses native fetch — no npm packages required

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!TOKEN) throw new Error('HUBSPOT_ACCESS_TOKEN not configured');

    const headers = {
      'Authorization': 'Bearer ' + TOKEN,
      'Content-Type': 'application/json'
    };

    const now = new Date();
    const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const weeks = getWeekBuckets(yearStart);

    const weeklyData = weeks.map(w => ({
      weekOf: w.label, demos: 0, infoSessions: 0, demosSpecific: 0, totalDemos: 0, dealsCreated: 0
    }));

    // --- 1. Meetings (demos + info sessions) ---
    let after = undefined;
    let hasMore = true;

    while (hasMore) {
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

      const resp = await fetch('https://api.hubapi.com/crm/v3/objects/meetings/search', {
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
    }

    // --- 2. Deals created ---
    after = undefined;
    hasMore = true;

    while (hasMore) {
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

      const resp = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
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
    }

    res.status(200).json({ weeks: weeklyData });
  } catch (err) {
    console.error('HubSpot error:', err);
    res.status(500).json({ error: 'HubSpot API failed', details: err.message });
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
