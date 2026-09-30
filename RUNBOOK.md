# stealthpad-warden Runbook

Operational procedures for the Stealthpad warden (indexer, attester, fallback keeper) and for the two
on-chain roles that watch it: the **guardian** and the **attester**. Written against the code in this
repository and in `stealthpad-foundry`. Pre-mainnet: addresses below are placeholders.

> **Ground rule.** Nothing in this runbook moves vault funds, because nothing can. The worst an
> operator mistake does here is delay claims. Keep it that way: never put a guardian key on the
> warden host, and never give the warden database role write access to anything outside its schema.

---

## 0. Roles, keys and where they live

| Role | Key | Where it lives | Needs ETH | Powers |
|---|---|---|---|---|
| Attester | `ATTESTER_PK` | warden host env, nowhere else | no | signs `PostRoot` digests |
| Keeper / relayer | `KEEPER_PK` | warden host env | a little, for gas | runs ready rounds, relays `postRoot` |
| Guardian | cold wallet (multisig in Phase 2) | **offline**, never on the warden host | a little, for gas | `veto()`, `proposeAttester`, `cancelAttester`, `setLaunchesOpen`, `proposeGuardian` |
| Database | `DATABASE_URL` | warden host env | n/a | read/write the warden schema |

Shell variables used below:

```bash
export RPC=https://rpc.mainnet.chain.robinhood.com
export FACTORY=0xFactory      # from the deployment
export VAULT=0xVault          # the vault in question
```

---

## 1. Start, stop, restart

### Containers (recommended)

```bash
docker compose up -d --build         # start or upgrade
docker compose logs -f --tail=200 warden
docker compose restart warden        # restart the worker only; db keeps running
docker compose stop warden           # stop the worker; vaults keep working, roots pause
docker compose down                  # stop everything; the pgdata volume is kept
```

After every start, verify the hardening is real, not assumed:

```bash
docker compose exec warden id                                   # uid=1000(node), never uid=0
docker inspect stealthpad-warden-warden-1 \
  --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}'
# true [ALL] [no-new-privileges:true]
docker compose port db 5432 || echo "db not published (expected)"
```

### Bare process

```bash
set -a; . ./.env; set +a
pnpm start                  # loop forever
ONCE=1 pnpm start           # one tick, then exit (smoke test)
```

### What "healthy" looks like

- A log line per tick with activity: `HH:MM:SS [index] blocks A..B: n transfers, ...`.
- Warnings are prefixed `[scope] !`. Repeated `[index] !` lines usually mean the RPC is failing.
- The heartbeat is fresh:

```sql
select value from meta where key = 'heartbeat';   -- ISO timestamp, updated every tick (TICK_MS, 15 s)
select value from meta where key = 'cursor';      -- last indexed block
```

A heartbeat older than 2 minutes means the loop is stuck or down. Go to section 5.

### Switching a role off without removing its key

| Want | Set | Effect |
|---|---|---|
| index only | `ATTESTER_ENABLED=0 KEEPER_ENABLED=0` | no signatures, no rounds |
| stop signing | `ATTESTER_ENABLED=0` | snapshots and roots pause; rounds continue |
| stop the fallback keeper | `KEEPER_ENABLED=0` | independent keepers still run rounds |

Note: with `KEEPER_PK` unset, the attester has no relayer and roots are not posted either.

---

## 2. Attester key rotation

Rotation is an on-chain, two-step change with a fixed **2-day delay** (`ATTESTER_DELAY`). The old
attester keeps working until the new one is accepted.

1. **Generate** the new key on a clean machine. Record only its address outside that machine.
   ```bash
   cast wallet new
   ```
2. **Propose** from the guardian wallet:
   ```bash
   cast send $FACTORY "proposeAttester(address)" 0xNewAttester --rpc-url $RPC --ledger   # or your signer
   cast call $FACTORY "pendingAttesterAt()(uint64)" --rpc-url $RPC                       # effective timestamp
   ```
   This emits `AttesterProposed(0xNewAttester, effectiveAt)`. Announce it publicly with the reason.
3. **Wait** 2 days. Keep the warden running on the old key; roots keep flowing.
4. **Accept** (anyone may call it once the delay has passed):
   ```bash
   cast send $FACTORY "acceptAttester()" --rpc-url $RPC --private-key $KEEPER_PK
   cast call $FACTORY "attester()(address)" --rpc-url $RPC                                # must be the new address
   ```
5. **Swap the key** on the warden host in the same minute: set `ATTESTER_PK` to the new key in `.env`,
   then `docker compose up -d warden`.
   - Roots already pending stay valid: the signature is checked only when `postRoot` runs.
   - A root the old key signed but that was not yet relayed will fail with `BadSignature`; the
     warden re-signs with the new key on the next tick. Nothing to do by hand.
6. **Destroy** the old key material and confirm `docker compose exec warden env | grep -c ATTESTER_PK`
   shows exactly one entry.

To abort a rotation before step 4: `cast send $FACTORY "cancelAttester()"` from the guardian.

### If the attester key is suspected compromised

1. Guardian: `proposeAttester(new)` immediately (the 2-day clock starts now).
2. For the next 2 days, treat every `RootPosted` as hostile until `pnpm verify` says it matches.
   Veto any root that does not (section 3). Only one root can be pending at a time.
3. Accept the new attester the moment the delay ends, then rotate the warden's key.

### If an unexpected `AttesterProposed` appears

The guardian key itself may be compromised. The legitimate guardian holder calls `cancelAttester()`
and `proposeGuardian(newGuardian)` at once, then the new guardian calls `acceptGuardian()`. Holders
have 2 days plus `ROOT_DELAY` to claim under roots that are already correct.

---

## 3. Guardian veto during the 2-hour ROOT_DELAY

Every root is claimable only 2 hours after `postRoot`. That window exists for this procedure.

### 3.1 Detect

Run the verifier on every vault after every `RootPosted`. Today this is a scheduled job (cron or a
systemd timer on a machine other than the warden host); an event-driven version is a Phase 2 item.

```bash
# every 10 minutes, per vault; exit code 1 = at least one posted root does not match the chain
RPC_URLS=$RPC VAULT=$VAULT FROM_BLOCK=<launch block> pnpm verify || notify "ROOT MISMATCH on $VAULT"
```

The verifier checks every `RootPosted` event, including roots that were later vetoed. After a veto,
that round's old line stays `✗`; alert on new `✗` lines, not on the exit code alone.

Check what is pending:

```bash
cast call $VAULT "pendingRoot()((bytes32,uint256,uint64,uint64,bytes32))" --rpc-url $RPC
#          root, total, roundId, activeAt, seed          (all zero = nothing pending)
```

### 3.2 Decide

Veto only when the verifier disagrees, or the leaf file is missing or does not hash to the stored
`leaf_hash`. Do not veto for any other reason: a veto only delays claims.

### 3.3 Act (in this order)

1. **Stop the attester first**, or the warden will re-post the same root within one tick:
   ```bash
   # in .env: ATTESTER_ENABLED=0
   docker compose up -d warden
   ```
2. **Veto** from the guardian wallet, before `activeAt`:
   ```bash
   cast send $VAULT "veto()" --rpc-url $RPC --ledger
   ```
   Expect `RootVetoed(roundId, root)`. After `activeAt` the call reverts with `NothingToVeto`.
3. **Recompute** the snapshot (section 4), confirm with `pnpm verify` logic, then set
   `ATTESTER_ENABLED=1`. The corrected root is posted and starts its own 2-hour window.
4. **Publish** a short note: round, vault, what was wrong, the corrected root.

---

## 4. Re-computing a root

Snapshots are incremental: round N starts from round N-1's cumulative leaves and carry. To rebuild
from round N for one vault:

```sql
begin;
delete from leaves    where vault = '0xvault' and round_id >= N;
delete from snapshots where vault = '0xvault' and round_id >= N;
commit;
```

Then run one tick that computes snapshots but cannot relay them (no keeper key means no relayer):

```bash
docker compose run --rm -e ATTESTER_ENABLED=1 -e KEEPER_ENABLED=0 -e KEEPER_PK= -e ONCE=1 warden
# bare process: ATTESTER_ENABLED=1 KEEPER_ENABLED=0 KEEPER_PK= ONCE=1 pnpm start
```

```bash
docker compose exec -T db psql -U stealthpad -d stealthpad -c \
  "select round_id, root, total, holders, distributed, carry, leaf_hash
   from snapshots where vault = '0xvault' order by round_id desc limit 3"
```

Compare `root` with a second, independent computation: the same one-tick run from a different machine,
against a different RPC and a fresh database. Addresses are stored lowercase. Once the root is posted,
`pnpm verify` checks it again from chain data alone, and the 2-hour window still applies.

If they match, restore `KEEPER_PK` and `ATTESTER_ENABLED=1`; the root is signed and relayed on the next
tick. If they do not match, stop: the bug is in the data (re-index, section 7) or in `snapshot.ts`
(run `pnpm check`, fix, add a regression check).

---

## 5. The attester (or the whole warden) goes silent

**Impact:** no new roots, so new claims wait. Rounds still run: any wallet can call `runRound()`, and
independent keepers do. USDG stays in the vaults. Nothing expires.

1. Heartbeat and cursor (section 1). Stale heartbeat, moving cursor: the attest stage is failing.
   Stale both: the process is down or the RPC is.
2. Logs: `docker compose logs --tail=300 warden | grep ' !'`.

| Symptom | Likely cause | Fix |
|---|---|---|
| `[index] ! getLogs failed` repeatedly | RPC down or rate-limited | add a second URL to `RPC_URLS`; restart |
| `[attest] ! ... round N not indexed yet` | indexer behind | wait, or check the cursor is advancing |
| `[attest] ! ... EIP-712 digest mismatch, not signing` | wrong `CHAIN_ID` or ABI out of date | fix `CHAIN_ID`; `pnpm abi` from a fresh `forge build` |
| `[attest] ! ... postRoot failed: ... BadSignature` | the factory's attester is not this key | check `attester()` on the factory; finish or undo a rotation |
| `[attest] ! ... postRoot failed: ... PendingRoot` | a root is already pending | normal; the next one waits |
| `[keeper] ! ... runRound skipped` | round not profitable yet, cooldown, or oracle too young | normal unless constant |
| container restarting in a loop | missing required env (`missing env X`) or database unreachable | fix `.env`; `docker compose ps db` |

3. If the host is lost: provision a new VPS, restore the database (section 7), deploy with the same
   `.env` (keys from your secret store), start. The attester resumes from the last snapshot.
4. Communicate: "Roots are delayed, funds are in the vaults, rounds continue." Phase 2 adds a backup
   attester set so this becomes a non-event.

---

## 6. Keeper wallet

- Keep a small float only: enough gas for a day of rounds and relays. The 3% tips refill it.
- Check it: `cast balance $(cast wallet address --private-key $KEEPER_PK) --rpc-url $RPC --ether`.
- A compromised keeper key loses only its own float. Rotate by changing `KEEPER_PK`; there is nothing
  to change on-chain.

---

## 7. Database backup, restore and rebuild

Everything in the warden schema is derived from Robinhood Chain **except the `images` table** (logos
the app stored). Back up both; only `images` is irreplaceable.

### Backup (nightly, kept off the host)

```bash
docker compose exec -T db pg_dump -U stealthpad -d stealthpad -Fc > warden-$(date +%F).dump
# managed PostgreSQL: pg_dump "$DATABASE_URL" -Fc > warden-$(date +%F).dump
```

Encrypt the file before it leaves the host. It contains no keys, but it is the published record.

### Restore

```bash
docker compose stop warden
docker compose exec -T db psql -U stealthpad -d postgres -c "drop database if exists stealthpad" \
                                                        -c "create database stealthpad"
docker compose exec -T db pg_restore -U stealthpad -d stealthpad --no-owner < warden-YYYY-MM-DD.dump
docker compose start warden        # the indexer continues from meta.cursor
```

### Rebuild without a backup

Drop and recreate the database, keep `START_BLOCK` at the factory's deploy block, and start. The
schema is created on start and the indexer replays history.

- Re-indexing reads some state at historical blocks. The public RPC keeps only about 15 minutes of
  state, so put an **archive endpoint** first in `RPC_URLS` for the rebuild.
- Snapshots are deterministic (seed = round block hash), so rebuilt roots equal the posted ones.
  Confirm with `pnpm verify` per vault before re-enabling the attester.
- Restore `images` from the last backup if you have one; otherwise logos must be re-uploaded.

---

## 8. Pons fee-recipient override check

The Pons V2 owner can queue a change of any coin's creator fee recipient behind a 3-day timelock.
Money already in a vault is out of reach, but future inflow would be redirected. The automated public
watcher is **planned**; until it ships, check daily:

```bash
cast call $VAULT "feeRouteIntact()(bool)" --rpc-url $RPC                        # must be true
cast call $VAULT "pendingOverride()(address,uint256,uint256)" --rpc-url $RPC    # all zero = none queued
# or, with stealthpad-foundry:
VAULT=$VAULT forge script script/Deploy.s.sol:Inspect --rpc-url robinhood
```

If an override is queued: announce it publicly the same day with the vault, the new recipient and
`effectiveAt`, and tell holders that everything assigned so far stays claimable.

---

## 9. Closing new launches

If a factory-level problem is found, the guardian can stop **new** launches. Existing vaults, rounds
and claims are unaffected.

```bash
cast send $FACTORY "setLaunchesOpen(bool)" false --rpc-url $RPC --ledger
cast call $FACTORY "launchesOpen()(bool)" --rpc-url $RPC
```

---

## 10. Upgrading the warden

1. `pnpm check` and `pnpm typecheck` green; if the contracts changed, `pnpm abi` from a fresh build.
2. `docker compose build warden && docker compose up -d warden`.
3. Verify `id`, heartbeat, and one `pnpm verify` per active vault.

A warden upgrade never changes a vault. If a change would alter snapshot results, it is a protocol
change: publish it before deploying, because the verifier must apply the same rules.
