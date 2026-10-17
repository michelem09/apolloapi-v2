const { sshExec } = require('./ssh');

// The runtime the units run on (2.2 and later) is the first choice: it is the very
// node the API runs, and it is at a fixed path. 2.1.x devices have only nvm, whose
// node is outside the PATH of a non-interactive ssh shell, so `node` alone is
// "command not found" there however well it works when you log in: those fall back
// to PATH, then to the nvm glob. Resolved once, by asking the device, instead of
// hardcoding a version that changes.
const RUNTIME_NODE = '/opt/apolloapi/backend/runtime/node/bin/node';
const NVM_NODE_GLOB = '/usr/local/nvm/versions/node/*/bin/node';
const nodeLookupCommand = ({ runtime = RUNTIME_NODE, nvmGlob = NVM_NODE_GLOB } = {}) =>
  `if [ -x ${runtime} ]; then echo ${runtime}; ` +
  `else command -v node || ls -d ${nvmGlob} 2>/dev/null | tail -1; fi`;

let cachedNode = null;
const deviceNode = async (profile) => {
  if (cachedNode) return cachedNode;
  const { stdout } = await sshExec(profile, nodeLookupCommand());
  if (!stdout) throw new Error('no node interpreter found on the device');
  cachedNode = stdout.split('\n').pop().trim();
  return cachedNode;
};

// The token is minted ON the device from its own APP_SECRET: the secret never
// travels, and the run needs no password of its own. It expires in two hours —
// longer than any run, short enough that one left in a log is not a standing key
// to the device.
const mintToken = async (profile) => {
  const script = [
    'const fs=require("fs");const jwt=require("/opt/apolloapi/node_modules/jsonwebtoken");',
    'const env=Object.fromEntries(fs.readFileSync("/opt/apolloapi/.env","utf8").split("\\n")',
    '.filter(Boolean).filter(l=>!l.startsWith("#")).map(l=>{const i=l.indexOf("=");',
    'return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));',
    'console.log(jwt.sign({sub:"apollouser",aud:"auth"},env.APP_SECRET,{expiresIn:"2h"}));',
  ].join('');
  const node = await deviceNode(profile);
  const { stdout } = await sshExec(profile, `${node} -e '${script}'`);
  return stdout;
};

const gql = async (profile, token, query, variables = {}) => {
  const res = await fetch(`${profile.apiBase}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) {
    const message = body.errors.map((e) => e.message).join('; ');
    const error = new Error(`GraphQL: ${message}`);
    // A query the schema rejects is a mistake in the suite, not a device that is
    // not ready yet. Flagged, so a polling check can stop instead of waiting out
    // its deadline for an answer that can never come.
    error.malformed = body.errors.some(
      (e) => e.extensions?.code === 'GRAPHQL_VALIDATION_FAILED'
    );
    error.graphqlErrors = body.errors;
    throw error;
  }
  return body.data;
};

// The v2.2 line moved state-changing actions (Auth.changePassword, Pool writes,
// Settings.update, ...) from Query to Mutation; 2.1.x still serves them as
// queries. A write goes out as a mutation first and, only if the server's schema
// does not know it there, again as the query of the same text.
// Keyed by host AND root field: a 2.1.4 device already serves Node and Mcu actions
// as mutations while Miner and Solo are still queries, so one form per host would
// send the wrong one for half the calls.
const writeForms = new Map(); // `${apiBase}|${rootField}` -> 'mutation' | 'query'

// The real root field, not its alias: `mutation { a: Miner { … } }` is still
// Miner, and the alias would otherwise split one field into several cache keys.
const rootFieldOf = (doc) =>
  /\{\s*(?:\w+\s*:\s*)?(\w+)/.exec(doc.replace(/^\s*\w+\s*\w*\s*(\([^)]*\))?/, ''))?.[1] || '';

// True only when EVERY error is a validation failure about the Mutation root: an
// unknown field on type "Mutation", or a schema with no Mutation type at all.
// Auth errors, network errors and business errors (other Apollo codes, or a
// field-level `error` payload) never match, so they surface instead of being
// retried as a query.
const mutationUnknown = (error) => {
  const errors = error?.graphqlErrors;
  if (!error?.malformed || !Array.isArray(errors) || errors.length === 0) return false;
  return errors.every(
    (e) =>
      e.extensions?.code === 'GRAPHQL_VALIDATION_FAILED' &&
      (/Cannot query field "[^"]+" on type "Mutation"/.test(e.message) ||
        /Schema is not configured for mutations/.test(e.message))
  );
};

const asQuery = (doc) => {
  if (!/^\s*mutation\b/.test(doc)) throw new Error('gqlWrite expects a document starting with "mutation"');
  return doc.replace(/^(\s*)mutation\b/, '$1query');
};

// `send` is the transport, injectable so the fallback is testable without a device.
const gqlWrite = async (profile, token, mutationDoc, variables = {}, send = gql) => {
  const key = `${profile.apiBase}|${rootFieldOf(mutationDoc)}`;
  if (writeForms.get(key) === 'query') return send(profile, token, asQuery(mutationDoc), variables);
  try {
    const data = await send(profile, token, mutationDoc, variables);
    writeForms.set(key, 'mutation');
    return data;
  } catch (error) {
    if (writeForms.get(key) === 'mutation' || !mutationUnknown(error)) throw error;
    const data = await send(profile, token, asQuery(mutationDoc), variables);
    writeForms.set(key, 'query');
    return data;
  }
};

const resetWriteForms = () => writeForms.clear();

module.exports = { mintToken, gql, gqlWrite, resetWriteForms, deviceNode, nodeLookupCommand, rootFieldOf };
