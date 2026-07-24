const fs = require('fs');
const s = fs.readFileSync('server.js', 'utf8');
let depth = 0, line = 1, state = 'code', stack = [];
for (let i = 0; i < s.length; i++) {
  const ch = s[i], nx = s[i + 1];
  if (ch === '\n') line++;
  if (state === 'lc') { if (ch === '\n') state = 'code'; continue; }
  if (state === 'bc') { if (ch === '*' && nx === '/') { state = 'code'; i++; } continue; }
  if (state === 'sq') { if (ch === '\\' && nx) { i++; continue; } if (ch === "'") state = 'code'; continue; }
  if (state === 'dq') { if (ch === '\\' && nx) { i++; continue; } if (ch === '"') state = 'code'; continue; }
  if (state === 'tmpl') { if (ch === '\\' && nx) { i++; continue; } if (ch === '`') state = 'code'; continue; }
  if (ch === '/' && nx === '/') { state = 'lc'; i++; continue; }
  if (ch === '/' && nx === '*') { state = 'bc'; i++; continue; }
  if (ch === "'") { state = 'sq'; continue; }
  if (ch === '"') { state = 'dq'; continue; }
  if (ch === '`') { state = 'tmpl'; continue; }
  if (ch === '{') { depth++; stack.push(line); }
  if (ch === '}') { depth--; stack.pop(); }
}
console.log('FINAL depth (0=balanced):', depth);
console.log('open braces still pending:', stack);
