// Fixes the has_central_air missing closing paren in the canonical extractor.
const fs = require('fs');
const file = 'src/extractors/shared-extractors.js';
let s = fs.readFileSync(file, 'utf8');

// The broken line ends with: includes('central'))),
// It needs one more closing paren: includes('central')))),

const needle = "central'))),";
const replacement = "central')))),";

if (s.includes(needle)) {
  const count = s.split(needle).length - 1;
  s = s.split(needle).join(replacement);
  fs.writeFileSync(file, s);
  console.log('FIXED ' + count + ' occurrence(s) - has_central_air paren corrected.');
} else if (s.includes(replacement)) {
  console.log('ALREADY FIXED - has_central_air paren is correct.');
} else {
  console.error('PATTERN NOT FOUND - has_central_air line may differ.');
  const lines = s.split('\n');
  lines.forEach((l, i) => { if (l.includes('has_central_air')) console.error((i + 1) + ': ' + l); });
  process.exit(1);
}