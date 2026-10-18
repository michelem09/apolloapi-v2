const fs = require('fs');
const path = require('path');

const SPECS = path.join(__dirname, 'specs');

// One journey per spec file, in file order (01-, 02-, …). The short name is what
// `--only` takes: `--only solo,password`.
const list = () =>
  fs.readdirSync(SPECS)
    .filter((f) => /^\d+-.+\.spec\.js$/.test(f))
    .sort()
    .map((f) => {
      const id = f.replace(/\.spec\.js$/, '');
      return { id, name: id.replace(/^\d+-/, ''), file: path.join(SPECS, f) };
    });

// Accepts ids ("04-node-software"), short names ("node-software") or a prefix of
// either ("node"), and refuses a name that matches nothing: a typo that selects
// zero journeys would be a green run that tested nothing.
const select = (all, only) => {
  if (!only) return all;
  const wanted = only.split(',').map((s) => s.trim()).filter(Boolean);
  const picked = [];
  for (const w of wanted) {
    const hits = all.filter((j) => j.id === w || j.name === w || j.name.startsWith(w));
    if (!hits.length) throw new Error(`no journey named "${w}" — try one of: ${all.map((j) => j.name).join(', ')}`);
    hits.forEach((h) => { if (!picked.includes(h)) picked.push(h); });
  }
  return all.filter((j) => picked.includes(j));
};

module.exports = { list, select };
