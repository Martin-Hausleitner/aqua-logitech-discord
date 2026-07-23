const fs = require('fs');
const text = fs.readFileSync('index.js', 'utf8');

const regex = /\.get\(['"`]\/[a-zA-Z0-9_\-\/]*['"`]/g;
let match;
const routes = new Set();
while ((match = regex.exec(text)) !== null) {
  routes.add(match[0]);
}
console.log(Array.from(routes).join('\n'));
