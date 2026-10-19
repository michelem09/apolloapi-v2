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

// Journeys that are NOT in the default round. The Wi-Fi one takes the radio down
// and up; on a device with ethernet and wifi on the same subnet (Linux's default
// ARP behaviour, arp_ignore=0) that can cut the ethernet address too, for minutes,
// and everything after it fails for that reason. It runs when asked for by name
// (`--only wifi`) or with `--with wifi`.
// usb-miner needs a USB hashboard physically attached and unplugs it (in software)
// for several minutes.
const OPT_IN = new Set(['wifi', 'usb-miner']);

// Switches that ride on `--with` but are not journeys: `--with usb-expiry` makes
// the usb-miner journey also wait out the 15-minute expiry.
const OPTIONS = new Set(['usb-expiry']);
const OPTION_HELP = { 'usb-expiry': 'with usb-miner: also leave the board unplugged for the 15-minute expiry (~20 min more)' };
// An option for a journey that is not in the run is a mistake, not a no-op.
const checkOptions = (journeys, options) => {
  if (options.includes('usb-expiry') && !journeys.some((j) => j.name === 'usb-miner')) {
    throw new Error('--with usb-expiry only applies to the usb-miner journey: add --only usb-miner (or --with usb-miner)');
  }
};
const optionsOf = (extra) => names(extra).filter((w) => OPTIONS.has(w));

// Accepts ids ("04-node-software"), short names ("node-software") or a prefix of
// either ("node"), and refuses a name that matches nothing: a typo that selects
// zero journeys would be a green run that tested nothing. With no `only`, the
// default round is everything except the opt-in journeys, plus those in `extra`.
const match = (all, w) => {
  const hits = all.filter((j) => j.id === w || j.name === w || j.name.startsWith(w));
  if (!hits.length) throw new Error(`no journey named "${w}" — try one of: ${all.map((j) => j.name).join(', ')}`);
  return hits;
};
const names = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

const select = (all, only, extra = null) => {
  const picked = [];
  const add = (hits) => hits.forEach((h) => { if (!picked.includes(h)) picked.push(h); });
  if (only) names(only).forEach((w) => add(match(all, w)));
  else {
    add(all.filter((j) => !OPT_IN.has(j.name)));
    names(extra).filter((w) => !OPTIONS.has(w)).forEach((w) => add(match(all, w)));
  }
  return all.filter((j) => picked.includes(j));
};

module.exports = { list, select, OPT_IN, OPTIONS, OPTION_HELP, optionsOf, checkOptions };
