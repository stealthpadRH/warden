import { decodeEventLog, decodeFunctionData, encodeAbiParameters, keccak256, type Address, type Hex, type Log } from "viem";
import { cfg } from "./config.ts";
import { blockTime, getLogsAdaptive, lower, pub } from "./chain.ts";
import { big, getMeta, setMeta, sql } from "./db.ts";
import { curveAbi, erc20Abi, factoryAbi, poolManagerAbi, vaultAbi } from "./abi.ts";
import { log, warn } from "./log.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const TRANSFER = keccak256(new TextEncoder().encode("Transfer(address,address,uint256)"));
const SWAP = keccak256(new TextEncoder().encode("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));

type Decoded = { eventName: string; args: Record<string, unknown> };
function decode(abi: readonly unknown[], l: Log): Decoded | null {
  try {
    return decodeEventLog({ abi: abi as never, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as Decoded;
  } catch {
    return null;
  }
}
const bn = (h: Hex | string | null | undefined) => BigInt(h ?? 0);

/** Uniswap v4 pool id of a graduated coin: keccak(abi.encode(PoolKey)). */
export function poolIdOf(token: Address, fee: number, spacing: number, hook: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [ZERO, token, fee, spacing, hook],
    ),
  );
}

/** Metadata comes from the launch transaction's own calldata, so it is exactly what went on chain. */
async function launchMetadata(tx: Hex) {
  try {
    const t = await pub.getTransaction({ hash: tx });
    const d = decodeFunctionData({ abi: factoryAbi, data: t.input });
    if (d.functionName !== "launch") return null;
    const input = d.args[0] as { name: string; symbol: string; logo: string; description: string; socials: { twitter: string; website: string } };
    return { name: input.name, symbol: input.symbol, logo: input.logo, description: input.description, website: input.socials.website, social: input.socials.twitter };
  } catch {
    return null;
  }
}

async function onLaunched(l: Log, args: Record<string, unknown>) {
  const token = lower(args.token as string);
  const vault = lower(args.vault as string);
  const block = bn(l.blockNumber as unknown as string);
  const [meta, at, fee, spacing] = await Promise.all([
    launchMetadata(l.transactionHash as Hex),
    blockTime(block),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "poolFee", blockNumber: block }).catch(() => 0),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "tickSpacing", blockNumber: block }).catch(() => 200),
  ]);
  let name = meta?.name ?? "";
  let symbol = meta?.symbol ?? "";
  if (!name) name = String(await pub.readContract({ address: token, abi: erc20Abi, functionName: "name" }).catch(() => ""));
  if (!symbol) symbol = String(await pub.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => ""));
  const poolId = poolIdOf(token, Number(fee), Number(spacing), cfg.hook);
  await sql`
    insert into coins (token, vault, curve, launcher, tax_bps, name, symbol, logo, description, website, social,
                       launched_block, launched_at, tx, pool_id)
    values (${token}, ${vault}, ${lower(args.curve as string)}, ${lower(args.launcher as string)}, ${Number(args.taxBps)},
            ${name}, ${symbol}, ${meta?.logo ?? ""}, ${meta?.description ?? ""}, ${meta?.website ?? ""}, ${meta?.social ?? ""},
            ${block.toString()}, ${new Date(at * 1000)}, ${l.transactionHash as string}, ${poolId})
    on conflict (token) do nothing`;
  log("index", `coin ${symbol} ${token} vault ${vault} tax ${Number(args.taxBps) / 100}%`);
}

export async function indexOnce(): Promise<{ from: bigint; to: bigint; logs: number } | null> {
  const head = await pub.getBlockNumber();
  const safe = head - cfg.confirmations;
  const stored = await getMeta("cursor");
  const cursor = stored ? BigInt(stored) : cfg.startBlock - 1n;
  if (safe <= cursor) return null;
  const from = cursor + 1n;
  const to = safe - cursor > cfg.logRange ? cursor + cfg.logRange : safe;

  // 1. new coins first, so this same range already indexes their transfers, trades and rounds
  const factoryLogs = await getLogsAdaptive({ address: cfg.factory, fromBlock: from, toBlock: to });
  for (const l of factoryLogs) {
    const d = decode(factoryAbi, l);
    if (!d) continue;
    if (d.eventName === "CoinLaunched") await onLaunched(l, d.args);
    if (d.eventName === "StealthVaultSet") await setMeta("stealth_vault", lower(d.args.vault as string));
  }

  const coins = await sql`select token, vault, curve, pool_id from coins`;
  if (coins.length === 0) {
    await setMeta("cursor", to.toString());
    return { from, to, logs: factoryLogs.length };
  }
  const tokens = coins.map((c) => c.token as Address);
  const vaults = coins.map((c) => c.vault as Address);
  const curves = coins.map((c) => c.curve as Address);
  const byCurve = new Map(coins.map((c) => [c.curve as string, c.token as string]));
  const byPool = new Map(coins.map((c) => [String(c.pool_id).toLowerCase(), c.token as string]));
  const poolIds = coins.map((c) => c.pool_id as Hex).filter(Boolean);

  const [transferLogs, vaultLogs, curveLogs, swapLogs] = await Promise.all([
    getLogsAdaptive({ address: tokens, topics: [TRANSFER], fromBlock: from, toBlock: to }),
    getLogsAdaptive({ address: vaults, fromBlock: from, toBlock: to }),
    getLogsAdaptive({ address: curves, fromBlock: from, toBlock: to }),
    poolIds.length ? getLogsAdaptive({ address: cfg.poolManager, topics: [SWAP, poolIds], fromBlock: from, toBlock: to }) : Promise.resolve([] as Log[]),
  ]);

  // Trades get interpolated timestamps (volume windows are hours long); everything else is exact.
  const [tFrom, tTo] = await Promise.all([blockTime(from), blockTime(to)]);
  const tsOf = (b: bigint) => (to === from ? tFrom : tFrom + Number(((b - from) * BigInt(tTo - tFrom)) / (to - from)));

  const vaultEvents: { l: Log; d: Decoded }[] = [];
  for (const l of vaultLogs) {
    const d = decode(vaultAbi, l);
    if (d) vaultEvents.push({ l, d });
  }
  const exactBlocks = new Set(vaultEvents.map((e) => bn(e.l.blockNumber as unknown as string)));
  const exactTs = new Map<bigint, number>();
  await Promise.all([...exactBlocks].map(async (b) => exactTs.set(b, await blockTime(b))));

  await sql.begin(async (tx) => {
    // transfers + running balances
    for (const l of transferLogs) {
      const token = lower(l.address);
      const fromA = lower(`0x${(l.topics[1] as string).slice(26)}`);
      const toA = lower(`0x${(l.topics[2] as string).slice(26)}`);
      const value = bn(l.data);
      const block = bn(l.blockNumber as unknown as string);
      const inserted = await tx`
        insert into transfers (token, block, log_index, tx, from_addr, to_addr, value)
        values (${token}, ${block.toString()}, ${Number(bn(l.logIndex as unknown as string))}, ${l.transactionHash as string}, ${fromA}, ${toA}, ${value.toString()})
        on conflict do nothing returning 1`;
      if (!inserted.length || value === 0n) continue;
      if (fromA !== ZERO) {
        await tx`insert into balances (token, holder, balance) values (${token}, ${fromA}, ${(-value).toString()})
                 on conflict (token, holder) do update set balance = balances.balance - ${value.toString()}`;
      }
      await tx`insert into balances (token, holder, balance) values (${token}, ${toA}, ${value.toString()})
               on conflict (token, holder) do update set balance = balances.balance + ${value.toString()}`;
    }

    // curve trades and graduation
    for (const l of curveLogs) {
      const d = decode(curveAbi, l);
      if (!d) continue;
      const token = byCurve.get(lower(l.address));
      if (!token) continue;
      const block = bn(l.blockNumber as unknown as string);
      if (d.eventName === "CurveCompleted") {
        await tx`update coins set graduated_block = ${block.toString()} where token = ${token} and graduated_block is null`;
        continue;
      }
      const buy = d.eventName === "CurveBuy";
      if (!buy && d.eventName !== "CurveSell") continue;
      await tx`
        insert into trades (token, block, log_index, tx, side, trader, eth, tokens, venue, at)
        values (${token}, ${block.toString()}, ${Number(bn(l.logIndex as unknown as string))}, ${l.transactionHash as string},
                ${buy ? "buy" : "sell"}, ${lower((buy ? d.args.recipient : d.args.seller) as string)},
                ${String(buy ? d.args.quoteIn : d.args.quoteOut)}, ${String(buy ? d.args.tokensOut : d.args.tokensIn)},
                'curve', ${new Date(tsOf(block) * 1000)})
        on conflict do nothing`;
    }

    // pool trades after graduation (amounts are the swapper's deltas: negative = paid into the pool)
    for (const l of swapLogs) {
      const d = decode(poolManagerAbi, l);
      if (!d) continue;
      const token = byPool.get(String(d.args.id).toLowerCase());
      if (!token) continue;
      const a0 = BigInt(d.args.amount0 as bigint);
      const a1 = BigInt(d.args.amount1 as bigint);
      const buy = a0 < 0n;
      const block = bn(l.blockNumber as unknown as string);
      await tx`
        insert into trades (token, block, log_index, tx, side, trader, eth, tokens, venue, at)
        values (${token}, ${block.toString()}, ${Number(bn(l.logIndex as unknown as string))}, ${l.transactionHash as string},
                ${buy ? "buy" : "sell"}, ${lower(d.args.sender as string)}, ${(a0 < 0n ? -a0 : a0).toString()},
                ${(a1 < 0n ? -a1 : a1).toString()}, 'pool', ${new Date(tsOf(block) * 1000)})
        on conflict do nothing`;
    }

    // vault events
    for (const { l, d } of vaultEvents) {
      const vault = lower(l.address);
      const block = bn(l.blockNumber as unknown as string);
      const at = new Date((exactTs.get(block) ?? tsOf(block)) * 1000);
      const a = d.args;
      if (d.eventName === "RoundRun") {
        await tx`
          insert into rounds (vault, round_id, block, block_hash, tx, at, caller, eth_budget, usdg, tip, to_stealth, to_treasury)
          values (${vault}, ${Number(a.roundId)}, ${block.toString()}, ${l.blockHash as string}, ${l.transactionHash as string}, ${at},
                  ${lower(a.caller as string)}, ${String(a.ethBudget)}, ${String(a.usdgToHolders)}, ${String(a.tip)},
                  ${String(a.toStealth)}, ${String(a.toTreasury)})
          on conflict do nothing`;
      } else if (d.eventName === "RootPosted") {
        await tx`
          insert into roots (vault, round_id, root, total, seed, active_at, status, posted_block, tx)
          values (${vault}, ${Number(a.roundId)}, ${String(a.root)}, ${String(a.total)}, ${String(a.seed)},
                  ${new Date(Number(a.activeAt) * 1000)}, 'pending', ${block.toString()}, ${l.transactionHash as string})
          on conflict do nothing`;
      } else if (d.eventName === "RootVetoed") {
        await tx`update roots set status = 'vetoed' where vault = ${vault} and round_id = ${Number(a.roundId)} and root = ${String(a.root)}`;
      } else if (d.eventName === "RootActivated") {
        await tx`update roots set status = 'active' where vault = ${vault} and round_id = ${Number(a.roundId)} and root = ${String(a.root)}`;
      } else if (d.eventName === "Claimed") {
        await tx`
          insert into claims (tx, log_index, vault, holder, to_addr, amount, fee, root_round, block, at)
          values (${l.transactionHash as string}, ${Number(bn(l.logIndex as unknown as string))}, ${vault}, ${lower(a.holder as string)},
                  ${lower(a.to as string)}, ${String(a.amount)}, ${String(a.fee)}, ${Number(a.rootRound)}, ${block.toString()}, ${at})
          on conflict do nothing`;
      }
    }

    await tx`insert into meta (key, value) values ('cursor', ${to.toString()})
             on conflict (key) do update set value = excluded.value`;
  });

  const n = factoryLogs.length + transferLogs.length + vaultLogs.length + curveLogs.length + swapLogs.length;
  if (n) log("index", `blocks ${from}..${to}: ${transferLogs.length} transfers, ${curveLogs.length + swapLogs.length} trade logs, ${vaultEvents.length} vault events`);
  return { from, to, logs: n };
}

/** A matured pending root is active on chain even before anyone calls promote(); mirror that, on
 *  chain time (a fork may run ahead of the wall clock). */
export async function refreshRootStatus() {
  const b = await pub.getBlock({ blockTag: "latest" });
  await sql`update roots set status = 'active' where status = 'pending' and active_at <= ${new Date(Number(b.timestamp) * 1000)}`;
}

export async function catchUp(maxTicks = 1000) {
  for (let i = 0; i < maxTicks; i++) {
    const r = await indexOnce().catch((e) => {
      warn("index", String(e?.message ?? e).slice(0, 300));
      return null;
    });
    if (!r) break;
  }
  await refreshRootStatus();
}

export { big };
