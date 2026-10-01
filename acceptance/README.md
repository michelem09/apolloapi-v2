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
