// /api/upload-metrics — Receives parsed Stripe MRR event data and stores in Supabase
// Called by the upload page after client-side xlsx parsing

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPA_URL || !SUPA_KEY) return res.status(500).json({ error: 'Supabase not configured' });

  const { events, batch } = req.body;
  if (!events || !Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'No events provided' });
  }

  const headers = {
    'apikey': SUPA_KEY,
    'Authorization': 'Bearer ' + SUPA_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };

  try {
    // Delete existing events for the same month range to avoid duplicates
    const timestamps = events.map(e => new Date(e.event_timestamp));
    const minDate = new Date(Math.min(...timestamps));
    const maxDate = new Date(Math.max(...timestamps));
    // Expand range to cover full month
    const monthStart = new Date(Date.UTC(minDate.getUTCFullYear(), minDate.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(maxDate.getUTCFullYear(), maxDate.getUTCMonth() + 1, 1));

    // Delete existing events in this date range
    const deleteUrl = SUPA_URL + '/rest/v1/stripe_mrr_events' +
      '?event_timestamp=gte.' + monthStart.toISOString() +
      '&event_timestamp=lt.' + monthEnd.toISOString();
    await fetch(deleteUrl, { method: 'DELETE', headers });

    // Insert new events in batches of 50
    let inserted = 0;
    for (let i = 0; i < events.length; i += 50) {
      const chunk = events.slice(i, i + 50).map(e => ({
        event_timestamp: e.event_timestamp,
        event_type: e.event_type,
        customer_id: e.customer_id,
        currency: e.currency || 'usd',
        mrr_change: e.mrr_change,
        upload_batch: batch || new Date().toISOString()
      }));

      const insertResp = await fetch(SUPA_URL + '/rest/v1/stripe_mrr_events', {
        method: 'POST',
        headers,
        body: JSON.stringify(chunk)
      });

      if (!insertResp.ok) {
        const err = await insertResp.text();
        throw new Error('Insert failed: ' + err);
      }
      inserted += chunk.length;
    }

    res.status(200).json({
      success: true,
      inserted,
      dateRange: monthStart.toISOString().slice(0, 10) + ' to ' + monthEnd.toISOString().slice(0, 10)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
