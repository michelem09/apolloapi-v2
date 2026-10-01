# Acceptance runs

Development only. This directory is never packaged: the release workflow stages
an allow-list (`src config migrations knexfile.js package.json node_modules` plus
the UI standalone), and it carries no dependencies, so nothing here can reach a
device through an install. See `docs-ai/ACCEPTANCE_SUITE.md`.

    cp acceptance/profile.example.json acceptance/profile.json   # edit host/ssid
    node acceptance/run.js --profile acceptance/profile.json
    node acceptance/run.js --profile acceptance/profile.json --only timezone

The device must declare itself disposable first, or the run refuses to start:

    ssh futurebit@<host> "sudo mkdir -p /var/lib/apollo && \
      echo 'acceptance test device' | sudo tee /var/lib/apollo/ACCEPTANCE_OK"

Secrets never live in the profile, only in the environment of the run:

    ACCEPTANCE_WIFI_PASSPHRASE     exercises joining a network, not just scanning
    ACCEPTANCE_DEVICE_PASSWORD     the device's CURRENT password, so the password
                                   check can change it and put it back

Without them those checks skip and say so. The password one needs the current
value because restoring the database would put back the hash the dashboard
checks while the Linux user kept the new password — the two would disagree.

Checks run in order of increasing risk: preflight, timezone, miner, password,
wifi, reboot. A failure stops the run there, so nothing riskier follows it.

Exit codes: `0` all checks passed · `1` a check failed · `2` the run never
started (no profile, device not declared, ssh unreachable).
