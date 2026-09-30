import { hashTypedData, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cfg } from "./config.ts";
import { pub, walletFor } from "./chain.ts";
import { big, sql } from "./db.ts";
import { vaultAbi } from "./abi.ts";
import { buildTree, distribute, excludedFor, sampleBlocks, sampledBalanceSums, type Transfer } from "./snapshot.ts";
import { log, warn } from "./log.ts";

// The attester signs facts and holds no funds: it never sends a transaction. The keeper wallet relays
// its signature (postRoot accepts a valid signature from any sender).
const attester = cfg.attesterPk ? privateKeyToAccount(cfg.attesterPk) : null;

export const postRootTypes = {
  PostRoot: [
    { name: "roundId", type: "uint64" },
    { name: "root", type: "bytes32" },
    { name: "total", type: "uint256" },
    { name: "seed", type: "bytes32" },
  ],
} as const;

export const domainFor = (vault: Address) => ({ name: "Stealthpad", version: "1", chainId: cfg.chainId, verifyingContract: vault });

/** The published leaf file, byte-for-byte what `leaf_hash` commits to. */
export function leafFile(s: {
  vault: string; roundId: number; windowFrom: bigint; windowTo: bigint; seed: string; samples: bigint[]; floor: bigint;
  distributable: bigint; distributed: bigint; carry: bigint; root: string; total: bigint;
  leaves: [string, bigint, bigint, bigint][];
}) {
  return JSON.stringify({
    vault: s.vault,
    roundId: s.roundId,
    windowFrom: s.windowFrom.toString(),
    windowTo: s.windowTo.toString(),
    seed: s.seed,
    samples: s.samples.map(String),
    eligibilityFloor: s.floor.toString(),
    distributable: s.distributable.toString(),
    distributed: s.distributed.toString(),
    carry: s.carry.toString(),
    root: s.root,
    total: s.total.toString(),
    leaves: s.leaves.map(([h, c, sh, avg]) => [h, c.toString(), sh.toString(), avg.toString()]),
  });
}

/** Computes the snapshot of every round that does not have one yet, in order, per vault. */
export async function snapshotPending(): Promise<number> {
  const coins = await sql`select token, vault, curve, launched_block from coins`;
  let made = 0;
  for (const c of coins) {
    const last = await sql`select round_id, carry, window_to from snapshots where vault = ${c.vault} order by round_id desc limit 1`;
    let lastRound = last.length ? Number(last[0].round_id) : 0;
    let carry = last.length ? big(last[0].carry) : 0n;
    let prevBlock = last.length ? BigInt(last[0].window_to) : BigInt(c.launched_block) - 1n;
    const todo = await sql`select round_id, block, block_hash, usdg from rounds where vault = ${c.vault} and round_id > ${lastRound} order by round_id`;
    if (!todo.length) continue;
    if (Number(todo[0].round_id) !== lastRound + 1) {
      warn("attest", `${c.vault}: round ${lastRound + 1} not indexed yet`);
      continue;
    }

    const cum = new Map<string, bigint>();
    if (lastRound > 0) {
      for (const r of await sql`select holder, cumulative from leaves where vault = ${c.vault} and round_id = ${lastRound}`) cum.set(r.holder, big(r.cumulative));
    }
    const lastBlock = BigInt(todo[todo.length - 1].block);
    const rows = await sql`select block, from_addr, to_addr, value from transfers
                           where token = ${c.token} and block <= ${lastBlock.toString()} order by block, log_index`;
    const transfers: Transfer[] = rows.map((x) => ({ block: BigInt(x.block), from: x.from_addr, to: x.to_addr, value: big(x.value) }));
    const excluded = excludedFor(c as never, cfg.factory, cfg.extraExcluded, [cfg.poolManager, cfg.hook, cfg.pons]);

    for (const r of todo) {
      const roundId = Number(r.round_id);
      const windowTo = BigInt(r.block);
      const samples = sampleBlocks(r.block_hash as Hex, prevBlock, windowTo, cfg.samples);
      const sums = sampledBalanceSums(transfers, samples);
      const distributable = big(r.usdg) + carry;
      const d = distribute(sums, samples.length, excluded, cfg.eligibilityFloor, distributable);
      for (const [h, s] of d.shares) cum.set(h, (cum.get(h) ?? 0n) + s);
      const tree = buildTree(cum);
      const total = [...cum.values()].reduce((a, b) => a + b, 0n);
      const root = tree ? (tree.root as Hex) : (toHex(0, { size: 32 }) as Hex);
      const n = BigInt(Math.max(1, samples.length));
      const leaves: [string, bigint, bigint, bigint][] = [...cum.entries()]
        .filter(([, v]) => v > 0n)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([h, v]) => [h, v, d.shares.get(h) ?? 0n, (sums.get(h) ?? 0n) / n]);
      const file = leafFile({
        vault: c.vault, roundId, windowFrom: prevBlock, windowTo, seed: r.block_hash, samples, floor: cfg.eligibilityFloor,
        distributable, distributed: d.distributed, carry: d.carry, root, total, leaves,
      });
      await sql.begin(async (tx) => {
        await tx`
          insert into snapshots (vault, round_id, window_from, window_to, seed, sampled_blocks, distributable, distributed, carry,
                                 holders, root, total, leaf_hash, tree, file)
          values (${c.vault}, ${roundId}, ${prevBlock.toString()}, ${windowTo.toString()}, ${r.block_hash}, ${samples.map(String)},
                  ${distributable.toString()}, ${d.distributed.toString()}, ${d.carry.toString()}, ${leaves.length}, ${root},
                  ${total.toString()}, ${keccak256(new TextEncoder().encode(file))}, ${tx.json(tree ? (tree.dump() as never) : ({} as never))}, ${file})
          on conflict do nothing`;
        for (const [h, v, sh, avg] of leaves) {
          await tx`insert into leaves (vault, round_id, holder, cumulative, share, avg_balance)
                   values (${c.vault}, ${roundId}, ${h}, ${v.toString()}, ${sh.toString()}, ${avg.toString()}) on conflict do nothing`;
        }
      });
      log("attest", `${c.vault} round ${roundId}: ${d.eligible.size} eligible of ${sums.size}, distributed ${d.distributed} carry ${d.carry}`);
      carry = d.carry;
      prevBlock = windowTo;
      lastRound = roundId;
      made++;
    }
  }
  return made;
}

/** Signs the newest snapshot of each vault and hands it to the keeper wallet to relay. */
export async function postRoots(): Promise<number> {
  const relayer = walletFor(cfg.keeperPk);
  if (!attester || !relayer) return 0;
  const latest = await sql`select distinct on (vault) vault, round_id, root, total, seed from snapshots order by vault, round_id desc`;
  let posted = 0;
  for (const s of latest) {
    const vault = s.vault as Address;
    const [active, pending] = await Promise.all([
      pub.readContract({ address: vault, abi: vaultAbi, functionName: "activeRoot" }),
      pub.readContract({ address: vault, abi: vaultAbi, functionName: "pendingRoot" }),
    ]);
    if (pending.activeAt !== 0n) continue; // one pending root at a time
    if (BigInt(s.round_id) <= active.roundId) continue; // already covered
    if (s.total === "0" && active.total === 0n) continue; // nothing assigned yet: nothing to claim
    const message = { roundId: BigInt(s.round_id), root: s.root as Hex, total: big(s.total), seed: s.seed as Hex };
    // Parity: what we sign must be exactly what the vault will recover.
    const local = hashTypedData({ domain: domainFor(vault), types: postRootTypes, primaryType: "PostRoot", message });
    const onchain = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "hashPostRoot", args: [message.roundId, message.root, message.total, message.seed] });
    if (local !== onchain) {
      warn("attest", `${vault}: EIP-712 digest mismatch, not signing`);
      continue;
    }
    const signature = await attester.signTypedData({ domain: domainFor(vault), types: postRootTypes, primaryType: "PostRoot", message });
    try {
      const { request } = await pub.simulateContract({
        account: relayer.account,
        address: vault,
        abi: vaultAbi,
        functionName: "postRoot",
        args: [message.roundId, message.root, message.total, message.seed, signature],
      });
      const hash = await relayer.writeContract(request);
      await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      log("attest", `${vault}: root for round ${s.round_id} posted (${hash})`);
      posted++;
    } catch (e) {
      warn("attest", `${vault}: postRoot failed: ${String((e as Error).message).slice(0, 200)}`);
    }
  }
  return posted;
}
