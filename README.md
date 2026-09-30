<div align="center">

# stealthpad-warden

**The off-chain worker that watches Stealthpad vaults, signs facts, and never holds funds.**

One TypeScript process that indexes every Stealthpad coin on Robinhood Chain, computes each round's
time-weighted snapshot, signs the Merkle root the vault will accept, runs ready rounds as a fallback
keeper, and ships the public verifier anyone can use to check its work.

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-299867?logo=typescript&logoColor=white)](./tsconfig.json)
[![Node](https://img.shields.io/badge/Node-22-34B27B?logo=node.js&logoColor=white)](./Dockerfile)
[![viem](https://img.shields.io/badge/viem-2.x-77D6A8)](https://viem.sh)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-176945?logo=postgresql&logoColor=white)](./docker-compose.yml)
[![Chain](https://img.shields.io/badge/Robinhood%20Chain-4663-05110F)](https://stealthpad.online/docs#architecture)
[![Status](https://img.shields.io/badge/status-pre--mainnet-020301)](#status)

[Website](https://stealthpad.online) · [Docs](https://stealthpad.online/docs) · [Runbook](./RUNBOOK.md) · [Contracts](https://github.com/stealthpadRH/stealthpad-foundry)

</div>

---

## Status

| Item | State |
|---|---|
| Indexer, attester, fallback keeper, public verifier | Built, rehearsed end to end on a fork of Robinhood Chain |
| Attester arithmetic regression checks (`pnpm check`) | 17 checks, all passing |
| Pons fee-recipient timelock watcher | **Planned.** Manual check documented in the [runbook](./RUNBOOK.md#8-pons-fee-recipient-override-check) |
| Mainnet | **Not yet.** No factory is deployed, so there is nothing to index on mainnet today |

---

## What the warden is

The Stealthpad vaults hold every wei of creator fees and pay holders directly. Nothing in this
repository can move that money. The warden exists because two facts cannot be computed cheaply
on-chain: **who held a coin, on average, across 12 random past blocks**, and **the Merkle root that
commits to everyone's cumulative share**. The warden computes both, publishes the inputs, and signs
the result. The vault then waits 2 hours before anyone can claim against it, and the guardian can
veto a wrong root in that window.

| Role | What it does | Key it uses | Moves funds? |
|---|---|---|---|
| **Indexer** | follows `CoinLaunched`, token `Transfer`s, curve trades, v4 swaps, `RoundRun`, `RootPosted`, `RootVetoed`, `RootActivated`, `Claimed` into PostgreSQL | none | no |
| **Attester** | samples 12 blocks per round, weights holders, builds cumulative leaves and the published leaf file, signs an EIP-712 `PostRoot` | `ATTESTER_PK` | no, it never sends a transaction |
| **Fallback keeper** | runs any vault whose `roundReady()` is true and takes the 3% tip; relays the attester's signature via `postRoot` | `KEEPER_PK` | only its own gas and tips |
| **Public verifier** | recomputes every posted root of a vault from chain data alone, no database, no Stealthpad server | none | no |
| **Timelock watcher** (planned) | alerts publicly when the Pons V2 owner queues a change of a coin's creator fee recipient (3-day timelock) | none | no |

Rounds never depend on this worker. Any wallet can call `runRound()`. If the warden stops, money
stays in the vaults and new claims wait for the next root.

---

## How it works

```
                           every TICK_MS (15 s)
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  1. index      catch up to head minus CONFIRMATIONS                      │
   │  2. attest     snapshot every round that has none yet, in order          │
   │  3. attest     sign newest snapshot per vault, relay postRoot            │
   │  4. keeper     runRound() on every vault with roundReady() == true       │
   │  5. index      pick up what this tick just sent; write heartbeat         │
   └──────────────────────────────────────────────────────────────────────────┘

 Robinhood Chain ──eth_getLogs──▶ indexer ──▶ PostgreSQL ──▶ attester (pure snapshot.ts)
       ▲                                           │                 │
       │                                           │   leaves + file │ EIP-712 signature
       │        postRoot(round, root, total,       ▼                 ▼
       └──────── seed, sig) relayed by keeper ◀─── keeper wallet ◀───┘
```

### The snapshot, exactly as coded (`src/snapshot.ts`)

| Step | Rule |
|---|---|
| Seed | the hash of the block the round ran in |
| Window | `(previous round block, this round block]` |
| Sample | 12 distinct blocks, `from + 1 + keccak256(seed, i) mod size`; a window of 12 blocks or fewer is sampled whole |
| Balance | a holder's balance at the **end** of each sampled block |
| Weight | the sum over the samples, i.e. the average balance |
| Floor | average >= 100,000 tokens (0.01% of supply); below it, the share carries into the next round |
| Exclusions | zero address, `0x...dEaD`, the token, its vault, its curve, the factory, the Pons V2 pool manager, hook and launch factory, plus `EXCLUDED` |
| Split | pro rata by weight; rounding remainders carry into the next round |
| Leaves | cumulative `(holder, total to date)`, `StandardMerkleTree` of `["address", "uint256"]` |
| Signature | EIP-712 domain `("Stealthpad", "1", chainId, vault)`, struct `PostRoot(uint64 roundId, bytes32 root, uint256 total, bytes32 seed)` |

Before signing, the attester recomputes the digest locally and compares it with the vault's own
`hashPostRoot`. A mismatch means it does not sign.

---

## Architecture

```
┌──────────────────────── a VPS ────────────────────────┐
│                                                        │
│  ┌──────────────────────────┐    internal network     │
│  │ warden (node, uid 1000)  │ ◀───────────────────┐   │
│  │ read-only rootfs, /tmp   │                     │   │
│  │ tmpfs, caps dropped      │   ┌─────────────────┴─┐ │
│  │                          │   │ PostgreSQL 17     │ │
│  │ main.ts                  │   │ not published     │ │
│  │  ├─ indexer.ts           │   │ (or managed       │ │
│  │  ├─ attester.ts          │   │  PostgreSQL)      │ │
│  │  ├─ keeper.ts            │   └───────────────────┘ │
│  │  └─ snapshot.ts (pure)   │                         │
│  └────────────┬─────────────┘                         │
│               │ egress network                        │
└───────────────┼────────────────────────────────────────┘
                ▼
     Robinhood Chain JSON-RPC (RPC_URLS, with fallbacks)

  read-only consumers of the same database:  stealthpad-conduit (API) · stealthpad-console (app)
```

### Source layout

```
stealthpad-warden/
├── src/
│   ├── main.ts        the tick loop (index, attest, keep, heartbeat)
│   ├── config.ts      every setting, from the environment
│   ├── chain.ts       viem clients, adaptive eth_getLogs, block time cache
│   ├── indexer.ts     coins, transfers, balances, trades, rounds, roots, claims
│   ├── snapshot.ts    sampling, weighting, distribution, Merkle tree (pure, shared with verify)
│   ├── attester.ts    snapshots, leaf file, EIP-712 signing, postRoot relay
│   ├── keeper.ts      fallback keeper
│   ├── verify.ts      public verifier (chain only)
│   ├── checks.ts      regression checks for the attester's arithmetic
│   ├── db.ts          postgres client and migration
│   ├── schema.sql     tables (all derived from chain data, except uploaded images)
│   ├── abi.ts         generated from stealthpad-foundry build output
│   └── log.ts
├── scripts/
│   ├── export-abi.mjs regenerates src/abi.ts from ../contracts/out
│   └── fork-seed.ts   seeds a local fork for a full rehearsal (needs the workspace layout below)
├── Dockerfile · docker-compose.yml · .env.example · RUNBOOK.md
└── package.json · pnpm-lock.yaml · pnpm-workspace.yaml · tsconfig.json
```

---

## Quick Start

Requirements: Node 22+, pnpm 10 (via `corepack enable`), PostgreSQL 15+.

```bash
git clone https://github.com/stealthpadRH/stealthpad-warden.git
cd stealthpad-warden
corepack enable
pnpm install

pnpm check        # attester arithmetic regression checks, offline
pnpm typecheck
```

### Verify a vault (no database, no keys)

```bash
RPC_URLS=https://rpc.mainnet.chain.robinhood.com VAULT=0xYourVault pnpm verify
# ✓ round 1: posted 0x3f9a1c0d5e7b2a48…  recomputed 0x3f9a1c0d5e7b2a48…
# every posted root matches the chain          (exit code 0; 1 on any mismatch)
```

Set `FROM_BLOCK` to the vault's launch block (or earlier) to shorten the scan.

### Run the worker

```bash
cp .env.example .env      # fill FACTORY, START_BLOCK, DATABASE_URL, and the keys you want active
set -a; . ./.env; set +a
pnpm start
```

`ATTESTER_PK` and `KEEPER_PK` are optional: without the attester key the process only indexes and
keeps; without the keeper key it neither runs rounds nor relays roots. `ONCE=1` runs a single tick.

### Run it in containers

```bash
cp .env.example .env
docker compose up -d --build
docker compose exec warden id          # uid=1000(node), never uid=0
```

### Full local rehearsal on a fork

No mainnet factory exists yet, so a meaningful run today is against a local fork:

```bash
# workspace layout expected by scripts/: <ws>/contracts (stealthpad-foundry), <ws>/worker (this repo),
# <ws>/app (stealthpad-console, only for fork-seed.ts logos)
export ROBINHOOD_ARCHIVE_RPC=https://your-archive-endpoint.example
anvil --fork-url "$ROBINHOOD_ARCHIVE_RPC" --chain-id 46632 --port 8547 --block-time 1

cd ../contracts && forge build && cd ../worker
pnpm abi                                   # refresh src/abi.ts from the build output
(cd ../contracts && GUARDIAN=0x.. ATTESTER=0x.. TREASURY=0x.. forge script script/Deploy.s.sol:DeployFactory \
  --rpc-url http://127.0.0.1:8547 --broadcast --private-key $DEPLOYER_PK)

CHAIN_ID=46632 RPC_URLS=http://127.0.0.1:8547 FACTORY=0x.. START_BLOCK=<deploy block> \
CONFIRMATIONS=1 TICK_MS=5000 DATABASE_URL=postgres://... ATTESTER_PK=0x.. KEEPER_PK=0x.. pnpm start
```

`scripts/fork-seed.ts` automates the middle part (factory, $STEALTH plus three test coins through the
real launchpad, trades on the real curves) and refuses to run against chain 4663. It reads fresh,
fork-only keys from `<ws>/.localdev/keys.json` (`{ "deployer": { "address", "pk" }, "guardian", "attester",
"keeper", "treasury", "launcher", "trader1", "trader2", "trader3" }`), writes `<ws>/.localdev/deploy.json`,
and uses the console's `sharp` install for logos. Never reuse those keys anywhere else: the well-known
dev accounts are EIP-7702 sweepers on this chain and its forks.

---

## Configuration

Every variable is read in [`src/config.ts`](./src/config.ts). See [`.env.example`](./.env.example)
for the full list with comments.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `CHAIN_ID` | no | `4663` | chain id used for the EIP-712 domain |
| `RPC_URLS` | no | Robinhood Chain public RPC | comma-separated, fallbacks in order |
| `FACTORY` | **yes** | none | the StealthFactory to index |
| `START_BLOCK` | **yes** | none | the factory's deploy block |
| `DATABASE_URL` | **yes** | none | PostgreSQL connection string |
| `ATTESTER_PK` | no | none | enables signing |
| `KEEPER_PK` | no | none | enables rounds and root relaying |
| `ATTESTER_ENABLED` / `KEEPER_ENABLED` | no | `1` | switch a role off without removing its key |
| `CONFIRMATIONS` | no | `20` | blocks behind head |
| `LOG_RANGE` | no | `200000` | blocks per `eth_getLogs`, halved on overflow |
| `TICK_MS` | no | `15000` | loop interval |
| `ELIGIBILITY_FLOOR_WEI` | no | `100000e18` | snapshot floor |
| `SAMPLES` | no | `12` | sampled blocks per round |
| `POOL_MANAGER`, `HOOK`, `PONS` | no | live Pons V2 addresses | excluded infrastructure |
| `EXCLUDED` | no | empty | extra excluded addresses |

---

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node 22 (alpine image), TypeScript strict, `tsx` |
| Chain client | viem 2.x, Multicall3, fallback transports |
| Merkle | `@openzeppelin/merkle-tree` `StandardMerkleTree` |
| Database | PostgreSQL via `postgres` (porsager), schema migrated on start |
| Container | non-root `node` user, read-only root filesystem, private network for the database |
| Hosting | a VPS, with PostgreSQL in a private-network container or a managed instance |

---

## Phased Roadmap

| Phase | Warden scope |
|---|---|
| 1, **now** | indexer, attester, fallback keeper, public verifier, fork rehearsal; mainnet with the factory |
| 2 | backup attester set, **Pons fee-recipient timelock watcher with public alerts**, automatic `verify` on every `RootPosted`, automated round receipts, keeper leaderboard data |
| 3 | claim relayer support (claims without ETH), Monero route data when listed |
| 4 | multi-chain indexing for vaults on other EVM chains |

---

## Reference Links

| Resource | Link |
|---|---|
| Operations | [RUNBOOK.md](./RUNBOOK.md) |
| Contracts and protocol spec | `stealthpad-foundry` |
| Read API | `stealthpad-conduit` |
| Frontend | `stealthpad-console` |
| Whitepaper and threat model | `stealthpad-dossier` |
| Docs | https://stealthpad.online/docs |
| viem | https://viem.sh |
| OpenZeppelin Merkle tree | https://github.com/OpenZeppelin/merkle-tree |

---

<div align="center">
<sub>
Pre-mainnet software, not audited. The attester signs facts and holds no funds; a wrong root can be
vetoed during the 2-hour window, and anyone can recompute every root with <code>pnpm verify</code>.
No Stealthpad contract address exists yet. Stealthpad is independent and not affiliated with Robinhood,
Pons, NEAR, or the Zcash and Aleo foundations. Nothing here is investment advice.
</sub>
</div>
