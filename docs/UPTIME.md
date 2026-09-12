# Keeping the demo up for a week

Two different things stay up, and only one of them needs you.

## The website: nothing to do

`https://blackbox-e57ff9.gitlab.io/` is a static export on GitLab Pages. There
is no server, no container, no free tier that sleeps. It stays up until GitLab
does, whether or not your machine is on, and it re-deploys itself on every push
to `main`.

It also degrades honestly. With no live round the arena shows the last settled
one — final equities, ranks, published strategy hashes — and says so. `/proof`,
`/hall`, `/studio` and `/disclosures` do not need a live round at all; the
privacy proof runs its sixteen read attempts against whatever round it finds.

## A live round: this is the part that needs a machine

The Native Crank ticks inside the rollup, so a round keeps running without
anything of ours attached, and **ticking costs no L1 SOL** — measured on round 6,
zero lamports over a ticking interval. What does need a caller is the two ends:
something has to create a round, and something has to settle it when the clock
runs out.

`scripts/keep-live.sh` is that something. It runs one round after another, so a
failure costs one round instead of the week:

```bash
HOURS=12 scripts/keep-live.sh          # 12-hour rounds, back to back
HOURS=24 MAX_ROUNDS=7 scripts/keep-live.sh
```

It refuses to start a round when the admin wallet drops below `MIN_SOL` (0.5 by
default) and picks up again on its own once you top it up, rather than half
creating rounds it cannot finish.

### Surviving logout and reboot

```bash
mkdir -p ~/.config/systemd/user
cp scripts/blackbox-rounds.service ~/.config/systemd/user/
sed -i "s|%WORKDIR%|$PWD|" ~/.config/systemd/user/blackbox-rounds.service
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now blackbox-rounds

systemctl --user status blackbox-rounds
journalctl --user -u blackbox-rounds -f
```

`enable-linger` is the part people miss: without it a user service stops the
moment you log out. `Restart=always` brings the supervisor back after a crash
or a reboot.

## Why long rounds rather than short ones

Ticking is free and per-round setup is not, so twelve-hour rounds cost a
fraction of what forty-two one-hour rounds would, and expose the demo to far
fewer create-and-delegate sequences that could fail. The reason not to run one
single seven-day round is recovery: if MagicBlock's devnet TEE validator is
redeployed mid-round, that round's rollup state goes with it, and a supervisor
running twelve-hour rounds simply starts the next one.

## What breaks it, honestly

| Risk | Effect | Cover |
|---|---|---|
| Your machine sleeps or loses power | No new rounds; the current one keeps ticking on the rollup and ends unsettled | `/arena` lets any visitor close a settled-out round; the supervisor starts a new one when the machine is back |
| Devnet SOL runs out | No new rounds | Supervisor stops before starting one it cannot finish and says so in the log |
| MagicBlock redeploys the devnet TEE | The running round's rollup state is lost | Next round starts clean; older rounds already committed to L1 are unaffected |
| A round ends with nobody to settle it | Sits in `Settling`; prizes unpaid | Either the supervisor's next pass or a visitor from `/arena` — every settlement instruction takes a bare signer |

If you want it genuinely independent of your laptop, the supervisor is an
ordinary Node process with one secret (the admin keypair): it runs unchanged on
any always-on box. Nothing about it is tied to this machine.

## Round discovery

The site finds whatever round is newest by probing Round PDAs forward from the
one baked in at build time, in batches of eight, stopping at the first empty
batch. So a site built today still finds round 60 a week from now without a
rebuild — which is what makes the supervisor and the static host work together.
