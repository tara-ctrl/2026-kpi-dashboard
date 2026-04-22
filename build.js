const fs = require('fs');
const path = require('path');

// Create Build Output API structure
const outDir = '.vercel/output';
fs.mkdirSync(outDir + '/static', { recursive: true });

// Copy static files
fs.copyFileSync('public/index.html', outDir + '/static/index.html');

// Create the unified API function (stripe.js handles all three data sources)
const funcDir = outDir + '/functions/api/stripe.func';
fs.mkdirSync(funcDir, { recursive: true });
fs.copyFileSync('api/stripe.js', funcDir + '/index.js');
fs.writeFileSync(funcDir + '/.vc-config.json', JSON.stringify({
  runtime: 'nodejs20.x',
  handler: 'index.js',
  launcherType: 'Nodejs',
  maxDuration: 30
}));

// Create output config
const config = {
  version: 3,
  routes: [
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/index.html' }
  ]
};
fs.writeFileSync(outDir + '/config.json', JSON.stringify(config, null, 2));

console.log('Build complete: static files + 1 unified serverless function');
