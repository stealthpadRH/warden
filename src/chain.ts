import { createPublicClient, createWalletClient, defineChain, fallback, http, type Address, type Hex, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cfg } from "./config.ts";
import { warn } from "./log.ts";

export const chain = defineChain({
  id: cfg.chainId,
  name: cfg.chainId === 4663 ? "Robinhood Chain" : `Robinhood fork ${cfg.chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: cfg.rpcUrls } },
  // the canonical Multicall3 is deployed on Robinhood Chain (and therefore on forks of it)
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

// The chain's public RPC turns away requests without a browser-like user agent.
const transports = cfg.rpcUrls.map((url) =>
  http(url, { timeout: 25_000, retryCount: 2, fetchOptions: { headers: { "user-agent": "Mozilla/5.0 (stealthpad-worker)" } } }),
);
const transport = transports.length > 1 ? fallback(transports) : transports[0];

// cacheTime 0: viem otherwise reuses the head block number for 4 s.
export const pub = createPublicClient({ chain, transport, cacheTime: 0, batch: { multicall: { wait: 16 } } });

export function walletFor(pk: Hex | undefined) {
  if (!pk) return null;
  return createWalletClient({ chain, transport, account: privateKeyToAccount(pk) });
}

export const lower = (a: string) => a.toLowerCase() as Address;

const tsCache = new Map<bigint, number>();
export async function blockTime(block: bigint): Promise<number> {
  const hit = tsCache.get(block);
  if (hit !== undefined) return hit;
  const b = await pub.getBlock({ blockNumber: block });
  if (tsCache.size > 50_000) tsCache.clear();
  tsCache.set(block, Number(b.timestamp));
  return Number(b.timestamp);
}

/**
 * eth_getLogs over [from, to]. The public RPC caps a response at 10,000 logs (not a block range), so
 * a range that hits the cap is split in half until it fits.
 */
export async function getLogsAdaptive(params: { address: Address | Address[]; topics?: (Hex | Hex[] | null)[]; fromBlock: bigint; toBlock: bigint }): Promise<Log[]> {
  const { fromBlock, toBlock } = params;
  if (Array.isArray(params.address) && params.address.length === 0) return [];
  try {
    return await pub.request({
      method: "eth_getLogs",
      params: [{ address: params.address, topics: params.topics, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` }],
    }) as unknown as Log[];
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (/exceeds limit|too many|query returned more than|limit exceeded|response size/i.test(msg) && toBlock > fromBlock) {
      const mid = fromBlock + (toBlock - fromBlock) / 2n;
      const a = await getLogsAdaptive({ ...params, toBlock: mid });
      const b = await getLogsAdaptive({ ...params, fromBlock: mid + 1n });
      return [...a, ...b];
    }
    warn("chain", "getLogs failed", fromBlock, toBlock, msg.slice(0, 200));
    throw e;
  }
}
