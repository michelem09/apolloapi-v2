const { test } = require('../fixtures');
const { wifiPassphrase, howToStore } = require('../../lib/secrets');

const INTERFACES = `{ Mcu { wifiInterfaces { result {
  interfaces { device kind connected connection carriesDefaultRoute } preferred
} error { message } } } }`;
const CONNECT = `mutation($input: McuWifiConnectInput!) {
  Mcu { wifiConnect(input: $input) { result { address } error { message } } }
}`;
const DISCONNECT = `mutation($ifname: String!) { Mcu { wifiDisconnect(ifname: $ifname) { error { message } } } }`;

// Journey 6 — leave the home network and join it again, from the Wi-Fi panel.
//
// The device is reached over ethernet and that must stay true: the journey
// refuses to start on a radio that carries the default route or the ssh session,
// and checks that ethernet is still connected after every step. It ends with the
// connections as it found them.
test('wifi: leave and rejoin the home network', async ({ j }) => {
  const ssid = j.profile.wifi?.ssid;
  if (!ssid) j.skip('no wifi.ssid in the profile');
  const passphrase = wifiPassphrase();
  if (!passphrase) j.skip(`store the passphrase first:\n  ${howToStore('wifi-passphrase')}`);

  const radios = async () => (await j.gql(INTERFACES)).Mcu.wifiInterfaces.result?.interfaces ?? [];
  const nm = () => j.probes.nmcliState(j.ssh);
  const ethUp = async () => {
    const { devices } = await nm();
    return devices.some((d) => j.probes.isEthernet(d) && /^connected/.test(d.state || ''));
  };
  const wifiActive = async (dev) => {
    const { active } = await nm();
    return active.find((c) => j.probes.isWifi(c) && (!dev || c.device === dev)) || null;
  };

  // The reason this journey is unsafe on this device, if it is. Checked before
  // anything is touched. `--force-wifi` overrides it.
  if (!j.local) {
    const risk = j.probes.arpFluxRisk({
      addrText: await j.ssh('ip -4 -o addr show'),
      arpIgnore: await j.ssh('sysctl -n net.ipv4.conf.all.arp_ignore'),
      arpAnnounce: await j.ssh('sysctl -n net.ipv4.conf.all.arp_announce'),
    });
    if (risk && !j.ctx.forceWifi) {
      j.finding(`inconclusive: ${risk}`);
      j.skip(`inconclusive: ${risk} (--force-wifi to run anyway)`);
    }
    if (risk) j.finding(`running anyway (--force-wifi): ${risk}`);
  }

  let radio;
  let startedConnected;
  await j.verify('a radio that is safe to touch', async () => {
    const list = await radios();
    j.must(list.length > 0, 'the API reports no wifi radio');
    // The radio on the target network, if any; else the first free one.
    radio = list.find((r) => r.connection === ssid) || list.find((r) => !r.connected) || list[0];
    const route = await j.probes.defaultRouteDevices(j.ssh);
    const session = await j.probes.sessionDevice(j.ssh);
    j.must(!radio.carriesDefaultRoute, `${radio.device} carries the default route`);
    j.must(session !== radio.device, `this ssh session arrives on ${radio.device}`);
    j.must(await ethUp(), 'ethernet is not connected: the way back in would be the radio');
    startedConnected = radio.connection === ssid;
    return `${radio.device} (${radio.kind}), ${startedConnected ? `on ${ssid}` : 'not on ' + ssid}; session via ${session}, route ${route.join(',')}`;
  });

  const panel = async () => {
    await j.open('/settings/system');
    await j.page.getByText(/Wi-?Fi/i).first().waitFor({ timeout: 20000 });
  };

  const rejoinViaApi = async () => {
    const out = await j.gqlWrite(CONNECT, { input: { ssid, passphrase, ifname: radio.device } });
    if (out.Mcu.wifiConnect.error) throw new Error(out.Mcu.wifiConnect.error.message);
  };

  await j.step('sign in', () => j.signIn());
  try {
    if (startedConnected) {
      await j.step('open the Wi-Fi panel', async () => { await panel(); await j.shot('panel-connected'); });
      await j.step('Disconnect and confirm', async () => {
        await j.page.getByRole('button', { name: /^Disconnect$/ }).first().click();
        await j.shot('confirm-dialog');
        await j.page.getByRole('alertdialog').getByRole('button', { name: /^Disconnect$/ }).click();
        await j.page.getByRole('alertdialog').waitFor({ state: 'hidden', timeout: 30000 });
      });
      await j.verify(`nmcli: ${radio.device} left ${ssid}, ethernet still up`, async () => {
        const r = await j.waitUntil(async () => !(await wifiActive(radio.device)), { timeoutMs: 60000, everyMs: 3000 });
        j.must(r.ok, `${radio.device} is still connected`);
        j.must(await ethUp(), 'ethernet went down');
      });
    }

    // The row of the AVAILABLE list: the one with a Connect button. The saved
    // list and the "Connected to" card also name the network, so waiting for the
    // text alone is satisfied before the scan has finished.
    const availableRow = () => j.page.locator('div')
      .filter({ has: j.page.getByText(ssid) })
      .filter({ has: j.page.getByRole('button', { name: /^Connect$/ }) })
      .last();

    await j.step('open the Wi-Fi panel and scan', async () => {
      await panel();
      await j.page.getByRole('button', { name: /Scan for networks|Refresh/ }).first().click();
      await availableRow().getByRole('button', { name: /^Connect$/ }).waitFor({ timeout: 90000 });
      await j.shot('scanned');
    });
    await j.step(`Connect to ${ssid}`, async () => {
      const row = availableRow();
      // A network on both bands offers a choice, and NetworkManager prefers 5 GHz,
      // which the built-in radio of an Apollo II cannot hold: it fails to activate.
      const band = row.locator('select');
      if (j.kind === 'apollo-legacy' && (await band.count())) {
        await band.selectOption('bg');
        j.finding(`${ssid} is on both bands: 2.4 GHz picked for the built-in radio`);
      }
      const since = j.toastCount();
      await row.getByRole('button', { name: /^Connect$/ }).click();
      // A network the device still has saved may join without asking; one it
      // forgot (a 2.1.x Disconnect deletes the profile) asks for the passphrase.
      const field = j.page.getByPlaceholder('Network password');
      if (await field.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)) {
        await field.fill(passphrase);
        await j.shot('passphrase-entered');
        await j.page.getByRole('dialog').getByRole('button', { name: /^Connect$/ }).click();
      }
      await j.waitForToast(/Connected to/i, { since, timeoutMs: 90000 });
      await j.shot('connected');
    });
    await j.verify(`nmcli: ${radio.device} is on ${ssid} with an address, ethernet still up`, async () => {
      const r = await j.waitUntil(async () => (await wifiActive(radio.device))?.name === ssid, { timeoutMs: 90000, everyMs: 3000 });
      j.must(r.ok, `${radio.device} is not on ${ssid}`);
      const ip = await j.ssh(`ip -4 -o addr show dev ${radio.device} | awk '{print $4}'`);
      j.must(!!ip, `${radio.device} has no IPv4 address`);
      j.must(await ethUp(), 'ethernet went down');
      return ip;
    });
    await j.verify('the API agrees', async () => {
      const now = (await radios()).find((r) => r.device === radio.device);
      j.must(now?.connected && now.connection === ssid, `Mcu.wifiInterfaces says ${JSON.stringify(now)}`);
    });

    // Not started on it: leave the radio the way it was found.
    if (!startedConnected) {
      await j.step('leave the network again', async () => {
        await j.page.getByRole('button', { name: /^Disconnect$/ }).first().click();
        await j.page.getByRole('alertdialog').getByRole('button', { name: /^Disconnect$/ }).click();
        await j.page.getByRole('alertdialog').waitFor({ state: 'hidden', timeout: 30000 });
      });
      await j.verify('nmcli: the radio is idle again', async () => {
        const r = await j.waitUntil(async () => !(await wifiActive(radio.device)), { timeoutMs: 60000, everyMs: 3000 });
        j.must(r.ok, `${radio.device} is still connected`);
      });
    }
  } finally {
    // Back to the start through the API, so a failed UI step cannot strand the
    // device. Ethernet is never touched.
    if (!j.local && radio) {
      try {
        const on = (await wifiActive(radio.device))?.name === ssid;
        if (startedConnected && !on) await rejoinViaApi();
        if (!startedConnected && on) await j.gqlWrite(DISCONNECT, { ifname: radio.device });
      } catch (err) {
        j.note('undoFailed', err.message);
      }
    }
  }
});
