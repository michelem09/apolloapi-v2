/**
 * Scrubbing for the diagnostic bundle.
 *
 * The bundle exists to be *sent to someone else*, so this is the one place in the
 * backend where privacy — not just secrecy — matters. Two different concerns:
 *
 *   - secrets   (RPC/pool/wifi passwords) must never leave the device;
 *   - identity  (BTC payout addresses) is not a secret, but it links the user to
 *               on-chain funds, so it is masked rather than shipped whole.
 *
 * Everything here is pure and exported so it can be tested directly: this file is
 * the actual guarantee, and a regression in it is a privacy incident, not a bug.
 */

// Key matching is WORD-based, not substring: `bypassRoute` contains "pass" but is
// not a secret, and silently blanking real diagnostic fields both loses data and
// makes support believe a secret was there.
const SENSITIVE_WORDS = new Set([
  'pass', 'passwd', 'password', 'passphrase', 'psk',
  'secret', 'token', 'credential', 'credentials',
  'authorization', 'apikey', 'rpcauth', 'rpcpassword',
]);

// Not secret, but identifies the user or their location.
const IDENTIFYING_WORDS = new Set(['ssid', 'connectedwifi']);

/**
 * Split an object key into comparable words: `nodeRpcPassword` and
 * `node_rpc_password` both become ['node','rpc','password'].
 */
function keyWords(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function matchesWords(key, vocabulary) {
  const words = keyWords(key);
  if (words.some((word) => vocabulary.has(word))) return true;
  // Two-word forms: "api key" / "connected wifi".
  const joined = words.join('');
  return vocabulary.has(joined);
}

const CENSOR = '[redacted]';

// BTC addresses: legacy/P2SH base58, bech32(m), and their testnet forms. Length
// bounds keep ordinary words from matching — a 25+ char base58 run is an address,
// not prose.
const BTC_ADDRESS = new RegExp(
  [
    '\\b(?:bc1|tb1)[a-z0-9]{8,87}\\b', // bech32 / bech32m
    '\\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\\b', // mainnet P2PKH / P2SH
    '\\b[mn2][a-km-zA-HJ-NP-Z1-9]{25,34}\\b', // testnet
  ].join('|'),
  'g'
);

/**
 * Keep just enough of an address to tell two of them apart inside one bundle
 * (support: "worker A vs worker B"), never enough to reconstruct it.
 */
function maskBtcAddress(address) {
  if (typeof address !== 'string' || address.length < 12) return `<btc:${CENSOR}>`;
  return `<btc:${address.slice(0, 4)}…${address.slice(-4)}>`;
}

function maskBtcAddresses(text) {
  if (typeof text !== 'string') return text;
  return text.replace(BTC_ADDRESS, (match) => maskBtcAddress(match));
}

// `key=value` secrets as they appear in config text (bitcoin.conf, wpa_supplicant)
// and log lines — where no object-key check can reach them.
const INLINE_SECRET =
  /\b(rpcpassword|rpcauth|password|passphrase|psk|secret|token|api_?key)\s*=\s*\S+/gi;

// The same secrets passed as COMMAND ARGUMENTS, which is how they reach the journal
// in the first place: sudo logs the full argv of
// `nmcli dev wifi connect <ssid> password <psk>`, and this release makes the
// journal persistent across boots — so without this the user's WiFi PSK travels
// inside the very bundle they attach to a public issue.
const ARG_SECRET = /\b(password|passphrase|psk|secret|token)\s+(?!=)(\S+)/gi;

// `nmcli … connect <ssid>`: the network name sits between the two, unlabelled.
const NMCLI_SSID = /\b(connect)\s+(\S+)/gi;

// SSID in the structured forms NetworkManager / wpa_supplicant emit.
const INLINE_SSID = /\b(ssid)\s*[=:]\s*("[^"]*"|\S+)/gi;

// Credentials embedded in a URL's userinfo (stratum+tcp://user:pass@host).
const URL_USERINFO = /(\w+:\/\/)[^/\s:@]+:[^/\s@]+@/g;

/**
 * Scrub a free-text blob: log output, a config file, a command's stdout.
 * Order matters — strip explicit secrets first, then mask identity.
 */
function scrubText(text) {
  if (typeof text !== 'string') return text;
  return maskBtcAddresses(
    text
      .replace(INLINE_SECRET, (_m, key) => `${key}=${CENSOR}`)
      .replace(ARG_SECRET, (_m, key) => `${key} ${CENSOR}`)
      .replace(NMCLI_SSID, (_m, verb) => `${verb} ${CENSOR}`)
      .replace(INLINE_SSID, (_m, key) => `${key}=${CENSOR}`)
      .replace(URL_USERINFO, (_m, scheme) => `${scheme}${CENSOR}:${CENSOR}@`)
  );
}

/**
 * Recursively scrub a structure: drop sensitive values by key, mask identifying
 * ones, and run every remaining string through the text scrubber (so an address
 * sitting in an innocuously-named field is still caught).
 */
function scrubValue(value, key = null) {
  if (key && matchesWords(key, SENSITIVE_WORDS)) return CENSOR;
  if (key && matchesWords(key, IDENTIFYING_WORDS)) {
    return value == null || value === '' ? value : CENSOR;
  }

  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubText(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item));

  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, k);
  return out;
}

module.exports = {
  scrubValue,
  scrubText,
  maskBtcAddresses,
  maskBtcAddress,
  CENSOR,
};
