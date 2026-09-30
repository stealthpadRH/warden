import { encodePacked, keccak256, type Address, type Hex } from "viem";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

// The attester's arithmetic, kept pure so the public verifier runs exactly this code on data it reads
// from the chain itself. Nothing here touches the database or the network.

/**
 * `k` distinct blocks from the window (from, to], picked by the seed. The seed is the hash of the
 * round's own block, so the picks are fixed by history nobody could know when they traded.
 * A window of k blocks or fewer is sampled whole.
 */
export function sampleBlocks(seed: Hex, from: bigint, to: bigint, k: number): bigint[] {
  const size = to - from;
  if (size <= 0n) return [];
  if (size <= BigInt(k)) return Array.from({ length: Number(size) }, (_, i) => from + 1n + BigInt(i));
  const picked = new Set<bigint>();
  for (let i = 0n; picked.size < k; i++) {
    const r = BigInt(keccak256(encodePacked(["bytes32", "uint256"], [seed, i])));
    picked.add(from + 1n + (r % size));
  }
  return [...picked].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export type Transfer = { block: bigint; from: string; to: string; value: bigint };

/**
 * Each holder's balance summed over the sampled blocks (a balance is the one at the END of a block).
 * `transfers` must be every transfer of the coin up to the last sampled block, in chain order.
 */
export function sampledBalanceSums(transfers: Transfer[], samples: bigint[]): Map<string, bigint> {
  const bal = new Map<string, bigint>();
  const sums = new Map<string, bigint>();
  let i = 0;
  for (const b of samples) {
    for (; i < transfers.length && transfers[i].block <= b; i++) {
      const t = transfers[i];
      bal.set(t.from, (bal.get(t.from) ?? 0n) - t.value);
      bal.set(t.to, (bal.get(t.to) ?? 0n) + t.value);
    }
    for (const [h, v] of bal) if (v > 0n) sums.set(h, (sums.get(h) ?? 0n) + v);
  }
  return sums;
}

export type Distribution = { shares: Map<string, bigint>; distributed: bigint; carry: bigint; eligible: Map<string, bigint> };

/**
 * Pro-rata by average balance across the samples. Excluded addresses and holders whose average is
 * under `floor` get nothing this round; what they would have had, and every rounding remainder,
 * carries into the next round.
 */
export function distribute(sums: Map<string, bigint>, sampleCount: number, excluded: Set<string>, floor: bigint, distributable: bigint): Distribution {
  const eligible = new Map<string, bigint>();
  const need = floor * BigInt(Math.max(1, sampleCount));
  let total = 0n;
  for (const [h, s] of sums) {
    if (excluded.has(h) || s < need) continue;
    eligible.set(h, s);
    total += s;
  }
  const shares = new Map<string, bigint>();
  let distributed = 0n;
  if (total > 0n && distributable > 0n) {
    for (const [h, s] of eligible) {
      const share = (distributable * s) / total;
      if (share > 0n) {
        shares.set(h, share);
        distributed += share;
      }
    }
  }
  return { shares, distributed, carry: distributable - distributed, eligible };
}

/** The cumulative Merkle tree: one leaf (holder, total to date) per holder ever paid by this vault. */
export function buildTree(cumulative: Map<string, bigint>) {
  const values = [...cumulative.entries()]
    .filter(([, v]) => v > 0n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([h, v]) => [h as Address, v.toString()] as [string, string]);
  if (values.length === 0) return null;
  return StandardMerkleTree.of(values, ["address", "uint256"]);
}

export function excludedFor(coin: { token: string; vault: string; curve: string }, factory: string, extra: string[], infra: string[]): Set<string> {
  return new Set(
    [
      "0x0000000000000000000000000000000000000000",
      "0x000000000000000000000000000000000000dead",
      coin.token,
      coin.vault,
      coin.curve,
      factory,
      ...infra,
      ...extra,
    ].map((a) => a.toLowerCase()),
  );
}
