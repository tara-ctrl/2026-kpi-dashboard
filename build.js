const fs = require('fs');
const path = require('path');

// Create Build Output API structure
const outDir = '.vercel/output';
fs.mkdirSync(outDir + '/static', { recursive: true });

// Copy static files
fs.copyFileSync('public/index.html', outDir + '/static/index.html');
fs.copyFileSync('public/upload.html', outDir + '/static/upload.html');

// Create serverless functions
const functions = [
  { src: 'api/stripe.js', name: 'api/stripe' },
  { src: 'api/stripe-events.js', name: 'api/stripe-events' },
  { src: 'api/upload-metrics.js', name: 'api/upload-metrics' }
];

for (const fn of functions) {
  const funcDir = outDir + '/functions/' + fn.name + '.func';
  fs.mkdirSync(funcDir, { recursive: true });
  fs.copyFileSync(fn.src, funcDir + '/index.js');
  fs.writeFileSync(funcDir + '/.vc-config.json', JSON.stringify({
    runtime: 'nodejs20.x',
    handler: 'index.js',
    launcherType: 'Nodejs',
    maxDuration: 30
  }));
}

// Create output config
const config = {
  version: 3,
  routes: [
    { handle: 'filesystem' },
    { src: '/api/(.*)', dest: '/api/$1' },
    { src: '/(.*)', dest: '/index.html' }
  ]
};
fs.writeFileSync(outDir + '/config.json', JSON.stringify(config, null, 2));

console.log('Build complete: static files + ' + functions.length + ' serverless functions');
