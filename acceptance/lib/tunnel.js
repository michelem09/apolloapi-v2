const { spawn } = require('child_process');
const net = require('net');

// HTTP to the device over an ssh tunnel rather than straight across the LAN.
//
// It is not a workaround for one machine: an operator may sit behind a VPN, a
// different subnet or a host firewall, and a release gate that only runs from
// the right desk is not a gate. ssh is the one path already required to be
// working — the guard and the snapshot both need it — so the HTTP rides it.
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const waitForPort = async (port, attempts = 50) => {
  for (let i = 0; i < attempts; i += 1) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1');
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the ssh tunnel never opened on 127.0.0.1:${port}`);
};

const openTunnel = async (profile, remotePort, localPort = null) => {
  // A fixed local port when the caller needs one: the UI asks for GraphQL at its
  // own hostname on a port baked into the build, so for the browser tier the
  // tunnel cannot land anywhere it likes.
  const port = localPort || (await freePort());
  const child = spawn('ssh', [
    '-N',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    // A tunnel that dies silently was the end of a whole round: ssh now notices a
    // dead path in ~45 s and exits, so whoever holds the tunnel can see it and
    // open another.
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-L', `${port}:127.0.0.1:${remotePort}`,
    `${profile.user}@${profile.host}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  // What ssh said when it died is the only evidence of why.
  let stderr = '';
  let exit = null;
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  child.on('exit', (code, signal) => { exit = { code, signal, at: new Date().toISOString() }; });
  child.on('error', (err) => { exit = { error: err.message, at: new Date().toISOString() }; });
  try {
    await waitForPort(port);
  } catch (err) {
    child.kill();
    throw err;
  }

  return {
    port,
    close: () => child.kill(),
    alive: () => exit === null,
    stderr: () => stderr.trim(),
    exit: () => exit,
  };
};

module.exports = { openTunnel };
