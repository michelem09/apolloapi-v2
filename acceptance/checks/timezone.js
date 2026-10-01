const { sshExec } = require('../lib/ssh');
const { gql } = require('../lib/api');

const READ = `{ Mcu { timezone { result { timezone available rebootPending } error { message } } } }`;
const SET = `mutation($input: McuSetTimezoneInput!) {
  Mcu { setTimezone(input: $input) { result { timezone } error { message } } }
}`;

// Reversible, and it exercises a write that reaches the operating system.
module.exports = {
  name: 'timezone',
  risk: 1,
  async run({ profile, token, assert }) {
    const before = (await gql(profile, token, READ)).Mcu.timezone.result;
    assert(before.available.length > 100, `the device offers ${before.available.length} zones from timedatectl`);

    // Somewhere the device is definitely not, so the change is observable.
    const target = before.timezone === 'Pacific/Auckland' ? 'Atlantic/Reykjavik' : 'Pacific/Auckland';

    const set = await gql(profile, token, SET, { input: { timezone: target } });
    assert(set.Mcu.setTimezone.error === null, `setTimezone(${target}) was accepted`);

    const { stdout: onDevice } = await sshExec(profile, 'timedatectl show -p Timezone --value');
    assert(onDevice === target, `timedatectl itself reports ${target}`);

    const after = (await gql(profile, token, READ)).Mcu.timezone.result;
    assert(after.rebootPending === true, 'the API now says a restart is owed');

    // A zone the system does not know must be refused before it reaches spawn.
    const bad = await gql(profile, token, SET, { input: { timezone: 'Mars/Olympus; rm -rf /' } });
    assert(!!bad.Mcu.setTimezone.error, 'an invented zone is refused');
    const { stdout: stillTarget } = await sshExec(profile, 'timedatectl show -p Timezone --value');
    assert(stillTarget === target, 'the refused write changed nothing');

    // Put it back here rather than leaving it to the restore: the next checks
    // read logs, and they should read them in the zone the device lives in.
    await gql(profile, token, SET, { input: { timezone: before.timezone } });
    const { stdout: restored } = await sshExec(profile, 'timedatectl show -p Timezone --value');
    assert(restored === before.timezone, `put back to ${before.timezone}`);

    return { was: before.timezone, tried: target };
  },
};
