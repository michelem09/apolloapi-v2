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

Secrets never live in the profile: the WiFi passphrase comes from
`ACCEPTANCE_WIFI_PASSPHRASE` in the environment.

Exit codes: `0` all checks passed · `1` a check failed · `2` the run never
started (no profile, device not declared, ssh unreachable).
