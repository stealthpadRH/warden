# Changelog

All notable changes to `stealthpad-warden` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- Pons V2 creator-fee-recipient timelock watcher with public alerts (today: manual check, see RUNBOOK section 8).
- Automatic `verify` on every `RootPosted`, with alerting.
- Backup attester set (Phase 2).
- Automated round receipts and keeper leaderboard data.

## [0.1.0] - 2026-09-29

First public cut of the off-chain worker, as rehearsed end to end on a fork of Robinhood Chain.
Pre-mainnet: no factory is deployed on mainnet yet.

### Added
- Indexer: follows `CoinLaunched` and `StealthVaultSet` on the factory, token `Transfer`s, Pons V2
  curve buys, sells and graduation, Uniswap v4 swaps after graduation, and every vault event
  (`RoundRun`, `RootPosted`, `RootVetoed`, `RootActivated`, `Claimed`) into PostgreSQL. Adaptive
  `eth_getLogs` that halves a range when the RPC caps the response. Coin metadata decoded from the
  launch transaction's own calldata.
- Attester: 12 blocks sampled per round from the window since the last round, seeded by the round's
  block hash; weight by average balance; 100,000-token eligibility floor; exclusions for curve, vault,
  token, factory, Pons V2 pool manager, hook and launch factory, and burn addresses; cumulative
  `(holder, total)` leaves; published leaf file with its hash; EIP-712 `PostRoot` signature checked
  against the vault's own `hashPostRoot` before signing. The attester never sends a transaction.
- Fallback keeper: runs every vault whose `roundReady()` is true and relays the attester's signature.
- Public verifier (`pnpm verify`): recomputes every posted root of a vault from chain data alone.
- Regression checks for the snapshot arithmetic (`pnpm check`, 17 checks).
- `scripts/export-abi.mjs` (ABIs generated from the contracts build, so worker and contracts cannot
  drift) and `scripts/fork-seed.ts` (one-command local fork seeding; refuses chain 4663).
- Dockerfile running as the non-root `node` user; `docker-compose.yml` with a read-only root
  filesystem, dropped capabilities, no published ports and PostgreSQL on an internal network.
- `.env.example`, `RUNBOOK.md`, and CI (typecheck, checks, non-root image assertion).

### Changed
- Dependency override `uuid >= 11.1.1` for a patched transitive dependency.
- Events in the generated ABI keep only `type`, `name` and `inputs`.

[Unreleased]: https://github.com/stealthpadRH/stealthpad-warden/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/stealthpadRH/stealthpad-warden/releases/tag/v0.1.0
