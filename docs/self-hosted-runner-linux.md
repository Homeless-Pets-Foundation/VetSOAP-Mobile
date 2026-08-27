# Self-Hosted CI Runner — Linux (WSL2)

Runbook for `vetsoap-local-ci-linux`, the Ubuntu 24.04/WSL2 runner that executes 7 of the 8 required checks. Only `Swift typecheck (durable recorder)` runs on the Mac mini. **When this runner is down, nothing merges.**

Written after the 2026-08-27 outage, where the runner had been started by hand and no procedure existed to detect or recover it.

## Facts

| | |
|---|---|
| Runner name | `vetsoap-local-ci-linux` |
| Labels | `self-hosted, Linux, X64, local-ci` |
| Account | `vetsoapci` (uid 1001, gid 1002) |
| Install dir | `/home/vetsoapci/actions-runner` |
| Service unit | `actions.runner.Homeless-Pets-Foundation-VetSOAP-Mobile.vetsoap-local-ci-linux.service` |
| Diagnostic logs | `/home/vetsoapci/actions-runner/_diag/` |

## Security invariants

`vetsoapci` must stay in **no supplementary groups** — verify with `id vetsoapci`, which must print only `groups=1002(vetsoapci)`.

Membership in `sudo` or `docker` is disqualifying. The docker group is root-equivalent, and this runner executes pull-request code. It must never be able to reach a developer account's SSH keys, `.env` files, or EAS/App Store/Play credentials. The same reasoning is why the R2 Approval Gate and the PR attestation gate stay GitHub-hosted: a persistent runner that executes PR code cannot also be the trust boundary protecting R2 destinations.

The systemd unit must report `User=vetsoapci`. A unit running as root is worse than an outage — stop it and reinstall rather than leaving it up.

## Health check

```bash
gh api repos/Homeless-Pets-Foundation/VetSOAP-Mobile/actions/runners \
  --jq '.runners[] | "\(.name)\t\(.status)\tbusy=\(.busy)"'
```

**The API is the only ground truth.** A local `Runner.Listener` process that has lost its broker connection looks perfectly healthy to `ps` and to `systemctl status` while GitHub reports it `offline`. Never conclude the runner is up from process state alone.

Re-registration is not instant. After a restart, expect `offline` for roughly 20 s (listener respawn) to 100 s (full service restart) before it flips to `online`. Poll before concluding anything is wrong.

## Service lifecycle

```bash
sudo bash -c 'cd /home/vetsoapci/actions-runner && ./svc.sh status'
sudo systemctl restart actions.runner.Homeless-Pets-Foundation-VetSOAP-Mobile.vetsoap-local-ci-linux.service
sudo systemctl stop    actions.runner.Homeless-Pets-Foundation-VetSOAP-Mobile.vetsoap-local-ci-linux.service
```

Fresh install, if the service is ever missing:

```bash
sudo bash -c 'cd /home/vetsoapci/actions-runner && ./svc.sh install vetsoapci && ./svc.sh start && ./svc.sh status'
```

The `vetsoapci` argument is load-bearing — omitting it installs a unit that runs as root.

## The two shell traps

**Wrap the whole command in `sudo bash -c '...'`.** `/home/vetsoapci` is `drwx------`, so any part of a command that runs as your own user fails. A bare `sudo` on the final binary is not enough:

```bash
# WRONG — cd runs as you, before sudo applies
cd /home/vetsoapci/actions-runner && sudo ./svc.sh status

# WRONG — the glob expands as you, inside the $( ), and resolves to nothing
sudo tail -60 "$(sudo ls -1t /home/vetsoapci/actions-runner/_diag/Runner_*.log | head -1)"

# RIGHT
sudo bash -c 'cd /home/vetsoapci/actions-runner/_diag && tail -60 "$(ls -1t Runner_*.log | head -1)"'
```

**Run `svc.sh` only from `/home/vetsoapci/actions-runner`.** Other runner installs on this machine under `/home/philgood/actions-runner-*` serve *different repositories* (`dvm-calc-mobile`, `VetSOAP-Connect`) and ship their own `svc.sh`. Running it there registers a service for the wrong repo. Confirm before acting:

```bash
sudo sed 's/[^[:print:]]//g' /home/vetsoapci/actions-runner/.runner
```

`gitHubUrl` must be `https://github.com/Homeless-Pets-Foundation/VetSOAP-Mobile` and `agentName` must be `vetsoap-local-ci-linux`.

## Recovery layers

Three independent mechanisms, all verified 2026-08-27:

| Failure | Recovered by | Measured |
|---|---|---|
| `Runner.Listener` killed | `RunnerService.js` respawns it | back online ~20 s |
| Whole process tree killed | systemd `Restart=always` | `NRestarts` increments, online ~100 s |
| WSL distro boots | unit is `enabled` (`WantedBy=multi-user.target`) | online 5-8 s after boot, `NRestarts=0` |

A *Windows* reboot still needs a WSL terminal opened once — systemd only runs while the distro is up.

The boot row was confirmed across **three** WSL restarts on 2026-08-27 (14:34, 18:07, 18:28). Most recent:

```
WSL boot:              2026-08-27 18:28:56
unit ActiveEnterTime:  2026-08-27 18:29:04     # 8s later
NRestarts=0                                    # started by boot, not crash-restarted
```

`NRestarts=0` is the load-bearing detail: it proves the unit was started by boot rather than recovered by `Restart=always`. Check that field, not merely that the runner is up, or a crash-restart will read as boot persistence.

Those same three reboots are also the clearest argument for using a service at all. Three other runners on this host (`/home/philgood/actions-runner-*`, serving other repos) were hand-started with `./run.sh` and no unit. They went down at the first reboot and stayed down through all three, blocking their repos' CI, while this one returned unattended every time.

### The stock unit is not enough

`svc.sh` generates a unit with **`Restart=no`** and `OOMScoreAdjust=0`. It survives shell exit and starts at boot, but a killed process stays dead — the exact 2026-08-27 failure. The drop-in at `/etc/systemd/system/<unit>.d/override.conf` supplies what is missing:

```ini
[Service]
Restart=always
RestartSec=10
OOMScoreAdjust=-500
```

`OOMScoreAdjust=-500` makes the kernel prefer reaping something else under memory pressure. On a WSL2 box that also runs editors and agent processes, that is a deliberate trade: CI infrastructure is prioritised over interactive sessions. Drop the line if you would rather not make it — `Restart=always` alone still gives automatic recovery.

**If `svc.sh` is ever re-run, re-check the drop-in survived**, and re-verify `Restart=always` with `systemctl show -p Restart -p OOMScoreAdjust <unit>`.

Note that `KillMode=process` means systemd tracks only `runsvc.sh`. If just the listener dies, systemd sees a healthy service and `NRestarts` stays at 0 — recovery comes from `RunnerService.js`, not systemd. Both layers are needed; neither covers the other's case.

## Diagnosing a death

```bash
sudo bash -c 'cd /home/vetsoapci/actions-runner/_diag && tail -40 "$(ls -1t Runner_*.log | head -1)"'
sudo bash -c 'cd /home/vetsoapci/actions-runner/_diag && grep -niE "error|exception|shutdown|terminat|signal|unauthor|expired" "$(ls -1t Runner_*.log | head -1)" | tail -30'
```

Reading the log:

- A healthy idle runner writes an `RSAFileKeyManager` / `GitHubActionsService` token-refresh pair every **~50 minutes**. That heartbeat is the best evidence of when it was last alive.
- Transient `BrokerServer` socket exceptions (`SocketException (125): Operation canceled`) around job boundaries are **normal** and self-heal. Do not treat them as the cause if token refreshes continue afterwards.
- A log that simply **stops** with no shutdown line means `SIGKILL` or a torn-down process group — not a graceful exit. `Restart=always` now covers this regardless of cause.
- Kernel OOM evidence is generally **unavailable** under WSL2: `dmesg` is empty, and `/var/log/syslog`, `/var/log/kern.log`, and `journalctl _TRANSPORT=kernel` typically hold nothing. Absence of OOM records is not evidence against OOM.

Never print `.credentials` or `.credentials_rsaparams` — they hold the runner's registration token. `.runner` is config only and is safe to read.

## Re-registration

Needed only when the log shows an authentication or token failure — not for ordinary crashes. Successful token refreshes right up to the moment of death rule this out.

Get a fresh token from **Settings → Actions → Runners**, then:

```bash
sudo bash -c 'cd /home/vetsoapci/actions-runner && ./svc.sh stop && ./svc.sh uninstall'
sudo -u vetsoapci bash -c 'cd /home/vetsoapci/actions-runner && ./config.sh remove --token <TOKEN>'
sudo -u vetsoapci bash -c 'cd /home/vetsoapci/actions-runner && ./config.sh --url https://github.com/Homeless-Pets-Foundation/VetSOAP-Mobile --token <TOKEN> --name vetsoap-local-ci-linux --labels local-ci --unattended'
sudo bash -c 'cd /home/vetsoapci/actions-runner && ./svc.sh install vetsoapci && ./svc.sh start'
```

Re-apply the drop-in afterwards, then re-run the health check.

## Running CI

Full PR CI is manual by design:

```bash
gh workflow run self-hosted-ci.yml --ref <pr-branch>
```

Confirm the run's head matches the PR head, then let `Self-hosted CI Attestation Bridge` attach the required contexts. See the **Self-Hosted CI** section of `CLAUDE.md` for the gate and attestation model.
