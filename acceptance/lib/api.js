const { sshExec } = require('./ssh');

// nvm puts node outside the PATH of a non-interactive ssh shell, so `node` alone
// is "command not found" there however well it works when you log in. Resolve it
// once, by asking the device, instead of hardcoding a version that changes.
let cachedNode = null;
const deviceNode = async (profile) => {
  if (cachedNode) return cachedNode;
  const { stdout } = await sshExec(
    profile,
    'command -v node || ls -d /usr/local/nvm/versions/node/*/bin/node 2>/dev/null | tail -1'
  );
  if (!stdout) throw new Error('no node interpreter found on the device');
  cachedNode = stdout.split('\n').pop().trim();
  return cachedNode;
};

// The token is minted ON the device from its own APP_SECRET: the secret never
// travels, and the run needs no password of its own. Short-lived and local to
// the run.
const mintToken = async (profile) => {
  const script = [
    'const fs=require("fs");const jwt=require("/opt/apolloapi/node_modules/jsonwebtoken");',
    'const env=Object.fromEntries(fs.readFileSync("/opt/apolloapi/.env","utf8").split("\\n")',
    '.filter(Boolean).filter(l=>!l.startsWith("#")).map(l=>{const i=l.indexOf("=");',
    'return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));',
    'console.log(jwt.sign({sub:"apollouser",aud:"auth"},env.APP_SECRET));',
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
  if (body.errors) throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  return body.data;
};

module.exports = { mintToken, gql, deviceNode };
