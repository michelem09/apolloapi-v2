# Acceptance runs

Development only. Install its dependencies here, never in the repo root:

    yarn --cwd acceptance install
    acceptance/node_modules/.bin/playwright install chromium   # once, for the browser tier

Playwright is pinned, not ranged: `test.skip()` at the top of a file is a load
error from 1.62 on, and a range quietly moved the suite onto a version it had
never been run against.

The repo root keeps its own `@playwright/test` for the pre-existing `e2e/` tier
(a fake device, no hardware). This directory does not share it: one tier pinned
to a version it was proven on, the other free to move with the rest of the repo.
 This directory is never packaged: the release workflow stages
an allow-list (`src config migrations knexfile.js package.json node_modules` plus
the UI standalone), and it carries no dependencies, so nothing here can reach a
device through an install. See `docs-ai/ACCEPTANCE_SUITE.md`.

    cp acceptance/profile.example.json acceptance/profile.json   # edit host/ssid
    node acceptance/run.js --profile acceptance/profile.json
    node acceptance/run.js --profile acceptance/profile.json --only timezone

Offline tier (no device, no network): `node --test acceptance/test/*.test.js`.

State-changing calls go through `gqlWrite` (`lib/api.js`): mutation first, and the
query form of the same text only when the server's schema rejects the mutation
(v2.1.x serves these as queries). The form that worked is cached per host.

The device must declare itself disposable first, or the run refuses to start:

    ssh futurebit@<host> "sudo mkdir -p /var/lib/apollo && \
      echo 'acceptance test device' | sudo tee /var/lib/apollo/ACCEPTANCE_OK"

Secrets never live in the profile. Store them once in the keychain and every
run from then on picks them up — nothing in a file, nothing in shell history:

    security add-generic-password -s apollo-acceptance -a device-password -w
    security add-generic-password -s apollo-acceptance -a wifi-passphrase -w

Both prompt for the value. `-a device-password` is the device's CURRENT password:
the password check needs it to set a new one and put the old one back, because
restoring the database would put back the hash the dashboard checks while the
Linux user kept the new password — the two would silently disagree.

`ACCEPTANCE_DEVICE_PASSWORD` and `ACCEPTANCE_WIFI_PASSPHRASE` still work and win
over the keychain, for a one-off run. Without either, those checks skip and print
the command above.

Checks run in order of increasing risk: preflight, timezone, miner, browser,
node, password, wifi, reboot. A failure stops the run there, so nothing riskier
follows it.

Exit codes: `0` everything ran and passed · `1` a check failed · `2` the run
never started (no profile, device not declared, ssh unreachable) · `3` everything
that ran passed, but something skipped — a skip proves nothing, so it is not a
green light.

## User journeys (the real UI, on a guinea-pig device)

The checks above drive the API and a few UI specs. The journeys drive the UI the
way a person does — solo on with an address, a pooled worker, padded input, node
software, Tor, Wi-Fi, units and time zone, the password — plus two regression
journeys that are meant to FAIL on a build with a known defect — and then ask the
**device** whether it happened (`systemctl`, the miner's `miner_config` and stat
file, ckpool's `pool.status`, `bitcoind -version`, `nmcli`, `timedatectl`, the
shadow file). A toast that says "saved" proves the page got an answer, nothing
more. Run from the Mac; the LAN is not reachable from the cloud.

    node acceptance/journeys.js --profile acceptance/profiles/apollo2.json
    node acceptance/journeys.js --profile acceptance/profiles/apollo2.json --only solo,password
    node acceptance/journeys.js --list
    yarn --cwd acceptance journeys --profile profiles/apollo2.json    # same thing

One command is the whole round. `--only` takes short names (`solo`, `pooled`,
`padded`, `node-software`, `tor`, `wifi`, `units-timezone`, `password`,
`stop-during-start`, `early-click`, `edit-during-refetch`, `save-stopped-miner`, `usb-miner`), in file
order whatever the order typed; a name that matches nothing is an error. `--bail`
stops at the first failure. Each journey is one spec in `journeys/specs/`.

**`wifi` is opt-in**: it is not in the default round. Run it with `--only wifi` or
add it with `--with wifi`. Taking the radio down and up on a device whose ethernet
and wifi sit on the same subnet (Linux's defaults, `arp_ignore=0`,
`arp_announce=0`: ARP flux) can make the ethernet address unreachable for minutes,
and everything after it then fails for that reason. When it does run, it first
reads the device's addresses and sysctls; on the same subnet without
`arp_ignore>=1` and `arp_announce=2` it ends *inconclusive* with that reason rather
than risk it. `--force-wifi` runs it anyway.

**`usb-miner` is opt-in** too: it needs a USB hashboard physically attached (Solo Node,
`profiles/solonode.json`, or an Apollo II with a USB board, `profiles/apollo2.json`).
`--only usb-miner`, or `--with usb-miner`; add `--with usb-expiry` to also leave the board
unplugged for the 15-minute expiry (~20 minutes more). It simulates the unplug by unbinding the `cdc_acm` driver from the board's USB
*interface* over ssh (`sudo -n`), never touching the cable and never writing `authorized`
(which wedged the board); the interface is checked to belong to a `0483:5740` device
(a level higher is the hub) with the chosen serial and an SLV product, and the miner must
be running. The board is bound back in a `finally` and again by the round's restore; a
board a killed run left unbound is bound again at the start of the next round. It skips, not fails, when the API has no `Miner.boards` or no USB board is listed.
The device must carry `ACCEPTANCE_OK` as for every journey.

Needs the same things as the rest of the suite (`ACCEPTANCE_OK` on the device, the
device password in the keychain, `yarn --cwd acceptance install`, chromium), plus
the Wi-Fi passphrase for the Wi-Fi journey. The profile's optional `journeys`
object overrides what is typed (`worker`, `soloAddress`, …; see
`journeys/defaults.js`).

What a round guarantees, even when a journey fails or the run is interrupted:

1. It starts only on a device that carries `ACCEPTANCE_OK`, and only if the stored
   password still logs in.
2. It photographs the device first — database, system timezone, the miner/node/
   ckpool config files, service states, the NetworkManager connections, the
   installed `bitcoind`, pools and settings — and after a failed journey, and
   again at the end, puts all of it back — including each saved wifi profile's name
and `autoconnect`. Ethernet is never taken down; a connection that is already not
active is left alone, once. Anything
   that did not come back is listed as **drift** and fails the round.
3. The round ends with, in this order: the state restored, the **original
   password set again** (through the API, unconditionally if the password journey
   ran, and checked on the dashboard and on the Linux user), the **miner off** (it
   waits until the unit is no longer `activating` — systemd skips `ExecStop` for
   one that is — stops through the API, and confirms `miner_stop.sh` logged its
   closing line), and a final check of both.

The report is `journeys/out/<timestamp>/report.md` (+ `report.json`): per journey
the result, duration, every step with the device checks marked, every toast in
order (a toast shown twice, or an empty one, is called out), console errors,
findings (a save that said nothing), and a screenshot per step, plus a failure
shot. Exit codes as above: `0` clean, `1` failure or drift, `2` never started,
`3` something skipped.

Regression journeys: `stop-during-start` presses Stop while systemd still says
`activating` and reads the journal for miner_stop.sh's closing line (not
`activating` at the click means *inconclusive*, a skip, never green); if the stop
script was skipped, the end of the round runs it by hand and the report says so.
`early-click` holds the settings response for 4 s with a route, clicks a node
software at once, and expects the pick and the Save bar to survive its arrival;
nothing is saved. `edit-during-refetch` saves the unit, holds the settings refetch
that follows, picks a time zone meanwhile and expects the pick to survive (finding
"edit lost during refetch" if not). Every Save waits for the bar to close
(`j.save`), and a guard records "edit lost before save" instead of saving something
else. `save-stopped-miner` (new behaviour on 2.1.4, expected to FAIL on a build that still says "Save & Restart") stops the miner, changes the worker and expects a button reading exactly "Save", the "The miner is stopped" toast, and the unit still stopped 45 s later with no start in the journal; device only, skipped on a Solo Node.
A toast shown twice within 1.5 s is listed under Findings.

The API is reached through an ssh tunnel that is watched (ServerAlive keepalives; a
dead one is reopened with backoff and its exit and stderr go in the report under
"API transport") and, when it cannot be, over the LAN at `http://<host>:<apiPort>`.
The end of a round does not depend on the tunnel: the miner is stopped with
`systemctl` if the API will not do it, and the last line of the report is always
`LEFT TO DO BY HAND: …` (or `nothing`).

Offline: `node --test acceptance/test/*.test.js` covers the snapshot/restore logic,
the ordering of the end-of-round steps when a journey (or the restore) throws, and
the parsers. A local dev backend and UI can run the UI half of most journeys:

    node acceptance/journeys.js --local http://127.0.0.1:48811 --api http://127.0.0.1:47811

In that mode every device check is recorded as skipped, nothing is snapshotted or
restored, and the exit code is always `3`: it proves the page, not the device.
