const fs = require('fs');
const path = require('path');

// Create Build Output API structure
const outDir = '.vercel/output';
fs.mkdirSync(outDir + '/static', { recursive: true });

// Copy static files
fs.copyFileSync('public/index.html', outDir + '/static/index.html');

// Create serverless functions
const functions = ['stripe', 'hubspot', 'supabase'];
const vcConfig = JSON.stringify({ runtime: 'nodejs20.x', handler: 'index.js', launcherType: 'Nodejs' });

for (const fn of functions) {
  const funcDir = outDir + '/functions/api/' + fn + '.func';
  fs.mkdirSync(funcDir, { recursive: true });
  fs.copyFileSync('api/' + fn + '.js', funcDir + '/index.js');
  fs.writeFileSync(funcDir + '/.vc-config.json', vcConfig);
}

// Create output config
const config = {
  version: 3,
  routes: [
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/index.html' }
  ]
};
fs.writeFileSync(outDir + '/config.json', JSON.stringify(config, null, 2));

console.log('Build complete: static files + 3 serverless functions');
