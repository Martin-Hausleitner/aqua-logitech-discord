const fs = require('fs');
const text = fs.readFileSync('index.js', 'utf8');

console.log("=== Endpoints ===");
const regex = /.{0,60}\.get\(['"`]\/search['"`].{0,60}/g;
let match;
while ((match = regex.exec(text)) !== null) {
  console.log(match[0]);
}

console.log("\n=== 403 status ===");
const regex2 = /.{0,60}403.{0,60}/g;
let count = 0;
while ((match = regex2.exec(text)) !== null && count++ < 10) {
  console.log(match[0]);
}

console.log("\n=== Bearer token ===");
const regex3 = /.{0,60}Bearer.{0,60}/g;
count = 0;
while ((match = regex3.exec(text)) !== null && count++ < 10) {
  console.log(match[0]);
}
