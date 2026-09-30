// The public verifier. Recomputes a vault's roots from Robinhood Chain alone (no Stealthpad server, no
// database) and compares them with the roots the vault accepted. Anyone can run it:
//
//   RPC_URLS=https://rpc.mainnet.chain.robinhood.com VAULT=0x... pnpm verify
//
// It replays every Transfer of the coin, every RoundRun of the vault, and the attester's published
// rules (12 samples seeded by the round's block hash, a 100,000-token floor, the exclusions below).
import { createPublicClient, decodeEventLog, fallback, http, keccak256, type Address, type Hex, type Log } from "viem";
import { vaultAbi } from "./abi.ts";
import { buildTree, distribute, excludedFor, sampleBlocks, sampledBalanceSums, type Transfer } from "./snapshot.ts";

const VAULT = (process.env.VAULT ?? "").toLowerCase() as Address;
if (!VAULT) throw new Error("set VAULT=0x...");
const urls = (process.env.RPC_URLS ?? "https://rpc.mainnet.chain.robinhood.com").split(",");
const FLOOR = BigInt(process.env.ELIGIBILITY_FLOOR_WEI ?? (100_000n * 10n ** 18n).toString());
const SAMPLES = Number(process.env.SAMPLES ?? 12);
const INFRA = [
  process.env.POOL_MANAGER ?? "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  process.env.HOOK ?? "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
  process.env.PONS ?? "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
];
const client = createPublicClient({
  transport: fallback(urls.map((u) => http(u.trim(), { fetchOptions: { headers: { "user-agent": "Mozilla/5.0 (stealthpad-verify)" } } }))),
});

async function logs(address: Address, topics: (Hex | null)[] | undefined, from: bigint, to: bigint): Promise<Log[]> {
  try {
    return (await client.request({ method: "eth_getLogs", params: [{ address, topics, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] })) as unknown as Log[];
  } catch (e) {
    if (to > from && /limit|too many/i.test(String((e as Error).message))) {
      const mid = from + (to - from) / 2n;
      return [...(await logs(address, topics, from, mid)), ...(await logs(address, topics, mid + 1n, to))];
    }
    throw e;
  }
}

const token = (await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "token" })) as Address;
const curve = (await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "curve" })) as Address;
const factory = (await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "factory" })) as Address;
const head = await client.getBlockNumber();

// the vault's whole history: its Launched event marks the start
const all = await logs(VAULT, undefined, BigInt(process.env.FROM_BLOCK ?? 0), head);
const events = all.map((l) => ({ l, d: decodeEventLog({ abi: vaultAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as { eventName: string; args: Record<string, unknown> } }));
const launched = events.find((e) => e.d.eventName === "Launched");
if (!launched) throw new Error("no Launched event found: set FROM_BLOCK to the vault's launch block or earlier");
const launchBlock = BigInt(launched.l.blockNumber as unknown as string);
const rounds = events.filter((e) => e.d.eventName === "RoundRun");
const posted = events.filter((e) => e.d.eventName === "RootPosted");

const TRANSFER = keccak256(new TextEncoder().encode("Transfer(address,address,uint256)"));
const tlogs = await logs(token, [TRANSFER], launchBlock, head);
const transfers: Transfer[] = tlogs
  .map((l) => ({
    block: BigInt(l.blockNumber as unknown as string),
    idx: Number(BigInt(l.logIndex as unknown as string)),
    from: `0x${(l.topics[1] as string).slice(26)}`.toLowerCase(),
    to: `0x${(l.topics[2] as string).slice(26)}`.toLowerCase(),
    value: BigInt(l.data),
  }))
  .sort((a, b) => (a.block === b.block ? a.idx - b.idx : a.block < b.block ? -1 : 1));

const excluded = excludedFor({ token, vault: VAULT, curve }, factory, [], INFRA);
const cum = new Map<string, bigint>();
let carry = 0n;
let prev = launchBlock - 1n;
const rootsByRound = new Map<number, string>();
console.log(`vault ${VAULT} · coin ${token} · ${rounds.length} rounds · ${transfers.length} transfers\n`);
for (const r of rounds) {
  const id = Number(r.d.args.roundId);
  const block = BigInt(r.l.blockNumber as unknown as string);
  const samples = sampleBlocks(r.l.blockHash as Hex, prev, block, SAMPLES);
  const d = distribute(sampledBalanceSums(transfers, samples), samples.length, excluded, FLOOR, BigInt(r.d.args.usdgToHolders as bigint) + carry);
  for (const [h, s] of d.shares) cum.set(h, (cum.get(h) ?? 0n) + s);
  const tree = buildTree(cum);
  rootsByRound.set(id, tree ? tree.root : "0x" + "0".repeat(64));
  carry = d.carry;
  prev = block;
}
let bad = 0;
for (const p of posted) {
  const id = Number(p.d.args.roundId);
  const mine = rootsByRound.get(id);
  const same = mine?.toLowerCase() === String(p.d.args.root).toLowerCase();
  if (!same) bad++;
  console.log(`${same ? "✓" : "✗"} round ${id}: posted ${String(p.d.args.root).slice(0, 18)}…  recomputed ${String(mine).slice(0, 18)}…`);
}
console.log(posted.length ? (bad ? `\n${bad} root(s) DO NOT MATCH: report it` : "\nevery posted root matches the chain") : "\nno roots posted yet");
process.exit(bad ? 1 : 0);
