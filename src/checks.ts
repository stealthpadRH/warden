// Regression checks for the attester's arithmetic. Red = do not deploy.   pnpm check
import { encodeAbiParameters, encodePacked, keccak256, type Hex } from "viem";
import { buildTree, distribute, sampleBlocks, sampledBalanceSums, type Transfer } from "./snapshot.ts";

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!cond) failed++;
};

const seed = keccak256(encodePacked(["string"], ["a round block hash"]));

// sampling
const s1 = sampleBlocks(seed, 1000n, 1048n, 12);
ok("12 distinct blocks from a 48-block window", s1.length === 12 && new Set(s1.map(String)).size === 12);
ok("every sample inside (from, to]", s1.every((b) => b > 1000n && b <= 1048n));
ok("sorted ascending", s1.every((b, i) => i === 0 || b > s1[i - 1]));
ok("deterministic for a seed", JSON.stringify(sampleBlocks(seed, 1000n, 1048n, 12).map(String)) === JSON.stringify(s1.map(String)));
ok("a different seed picks differently", JSON.stringify(sampleBlocks(keccak256("0x01"), 1000n, 1048n, 12).map(String)) !== JSON.stringify(s1.map(String)));
ok("a small window is sampled whole", sampleBlocks(seed, 10n, 15n, 12).map(Number).join() === "11,12,13,14,15");
ok("an empty window has no samples", sampleBlocks(seed, 10n, 10n, 12).length === 0);
const big = sampleBlocks(seed, 0n, 10_000_000n, 12);
ok("a long window still gives 12", big.length === 12);

// balances at the end of each sampled block
const E = 10n ** 18n;
const Z = "0x0000000000000000000000000000000000000000";
const H = "0x00000000000000000000000000000000000000a1";
const S = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3"; // the curve
const tr: Transfer[] = [
  { block: 1n, from: Z, to: C, value: 1_000_000_000n * E },
  { block: 2n, from: C, to: H, value: 1_000_000n * E },
  { block: 45n, from: C, to: S, value: 5_000_000n * E },
];
const samples = Array.from({ length: 12 }, (_, i) => BigInt(3 + i * 4)); // 3,7,...,47
const sums = sampledBalanceSums(tr, samples);
ok("holder counted in all 12 samples", sums.get(H) === 12n * 1_000_000n * E);
const inWin = samples.filter((b) => b >= 45n).length;
ok("sniper counted only in samples after its buy", sums.get(S) === BigInt(inWin) * 5_000_000n * E, `${inWin} of 12`);

// distribution
const excluded = new Set([C, Z]);
const d = distribute(sums, 12, excluded, 100_000n * E, 1_000_000_000n);
ok("excluded addresses get nothing", !d.shares.has(C));
ok("shares + carry == distributable", d.distributed + d.carry === 1_000_000_000n);
ok("holder beats a 3-block sniper holding 5x more", (d.shares.get(H) ?? 0n) > (d.shares.get(S) ?? 0n));
const dust = distribute(new Map([[H, 12n * 99_999n * E]]), 12, excluded, 100_000n * E, 5_000n);
ok("below the floor: nothing paid, all carried", dust.distributed === 0n && dust.carry === 5_000n);
const none = distribute(new Map(), 12, excluded, 100_000n * E, 777n);
ok("no eligible holder: whole amount carried", none.carry === 777n);

// Merkle leaves match the vault: keccak(bytes.concat(keccak(abi.encode(holder, cumulative))))
const tree = buildTree(new Map([[H, 123n], [S, 456n], ["0x00000000000000000000000000000000000000d4", 789n]]))!;
const leaf = (h: string, v: bigint) =>
  keccak256(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [h as Hex, v])));
const pair = (a: Hex, b: Hex) => (a < b ? keccak256(encodePacked(["bytes32", "bytes32"], [a, b])) : keccak256(encodePacked(["bytes32", "bytes32"], [b, a])));
let allOk = true;
for (const [i, v] of tree.entries()) {
  const proof = tree.getProof(i) as Hex[];
  let h = leaf(v[0] as string, BigInt(v[1] as string));
  for (const p of proof) h = pair(h, p);
  if (h !== tree.root) allOk = false;
}
ok("every proof verifies with the vault's own rule", allOk);
ok("zero balances leave no leaf", buildTree(new Map([[H, 0n]])) === null);

console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
