// /api/auth — Simple password authentication
// Password stored in DASHBOARD_PASSWORD environment variable

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { password } = req.body;
  const correctPassword = process.env.DASHBOARD_PASSWORD;

  if (!correctPassword) return res.status(500).json({ error: 'Password not configured' });

  if (password === correctPassword) {
    res.status(200).json({ success: true });
  } else {
    res.status(401).json({ error: 'Incorrect password' });
  }
};
