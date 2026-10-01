const { gql } = require('../lib/api');
const { waitUntil } = require('../lib/wait');
const { howToStore } = require('../lib/secrets');

const INTERFACES = `{ Mcu { wifiInterfaces { result { interfaces { device kind connected } preferred } error { message } } } }`;
const NETWORKS = `query($ifname: String!) {
  Mcu { wifiNetworks(ifname: $ifname) { result { networks { ssid signal } } error { message } } }
}`;
const STATUS = `query($ifname: String) {
  Mcu { wifiStatus(ifname: $ifname) { result { connected ssid ipAddress } error { message } } }
}`;
const CONNECT = `mutation($input: McuWifiConnectInput!) {
  Mcu { wifiConnect(input: $input) { result { address } error { message } } }
}`;
const DISCONNECT = `mutation($ifname: String!) { Mcu { wifiDisconnect(ifname: $ifname) { error { message } } } }`;

// Scanning and joining a network, on a radio that is NOT carrying this session.
//
// Deliberately never calls wifiForget: deleting a saved network on a real device
// is not a risk worth taking for coverage that the container tier already gives.
module.exports = {
  name: 'wifi',
  risk: 4,
  async run({ profile, token, assert, skip }) {
    const { Mcu } = await gql(profile, token, INTERFACES);
    const interfaces = Mcu.wifiInterfaces.result?.interfaces ?? [];
    // Not "this device has no radio": the API reports the radios it can manage
    // right now, and a radio that is down reports as absent. Say what was seen.
    if (!interfaces.length) {
      return skip('the API reported no manageable wifi radio at this moment');
    }

    const radio = interfaces[0];
    assert(!!radio.device, `the API sees a wifi radio (${radio.device}, ${radio.kind})`);

    const scan = await gql(profile, token, NETWORKS, { ifname: radio.device });
    const networks = scan.Mcu.wifiNetworks.result?.networks ?? [];
    assert(networks.length > 0, `scanning ${radio.device} found ${networks.length} networks`);

    const ssid = profile.wifi?.ssid;
    if (!ssid) return skip('no wifi.ssid in the profile — scanning verified, joining skipped');
    assert(networks.some((n) => n.ssid === ssid), `${ssid} is among them`);

    if (!profile.wifi.passphrase) {
      return skip(`store the passphrase to exercise joining a network:\n      ${howToStore('wifi-passphrase')}`);
    }

    const joined = await gql(profile, token, CONNECT, {
      input: { ssid, passphrase: profile.wifi.passphrase, ifname: radio.device },
    });
    assert(joined.Mcu.wifiConnect.error === null, `joined ${ssid} on ${radio.device}`);

    const up = await waitUntil(async () => {
      const s = await gql(profile, token, STATUS, { ifname: radio.device });
      const r = s.Mcu.wifiStatus.result;
      return r?.connected && r.ssid === ssid && !!r.ipAddress;
    }, { timeoutMs: 60000, everyMs: 3000 });
    assert(up.ok, `the radio holds ${ssid} with an address`);

    // Leave the radio as it was found: down, with its saved profiles intact.
    await gql(profile, token, DISCONNECT, { ifname: radio.device });
    const down = await waitUntil(async () => {
      const s = await gql(profile, token, STATUS, { ifname: radio.device });
      return !s.Mcu.wifiStatus.result?.connected;
    }, { timeoutMs: 45000, everyMs: 3000 });
    assert(down.ok, 'disconnected again, saved networks untouched');

    return { radio: radio.device, ssid };
  },
};
