import type { Address, Hex } from "viem";

// Every value comes from the environment. Secrets (keys, the database password) never have defaults.
const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`missing env ${k}`);
  return v;
};
const opt = (k: string) => (process.env[k] ? (process.env[k] as string) : undefined);

export const cfg = {
  chainId: Number(env("CHAIN_ID", "4663")),
  /** comma-separated; the first healthy one is used, the rest are fallbacks */
  rpcUrls: env("RPC_URLS", "https://rpc.mainnet.chain.robinhood.com").split(",").map((s) => s.trim()).filter(Boolean),
  factory: env("FACTORY") as Address,
  /** the block the factory was deployed in: indexing starts here */
  startBlock: BigInt(env("START_BLOCK")),
  databaseUrl: env("DATABASE_URL"),
  attesterPk: opt("ATTESTER_PK") as Hex | undefined,
  keeperPk: opt("KEEPER_PK") as Hex | undefined,
  /** stay this many blocks behind the head (~2 s at 10 blocks/s) */
  confirmations: BigInt(env("CONFIRMATIONS", "20")),
  /** blocks per getLogs request when the range is sparse; halved automatically on "too many logs" */
  logRange: BigInt(env("LOG_RANGE", "200000")),
  tickMs: Number(env("TICK_MS", "15000")),
  /** holders below this average balance over the sampled blocks roll into the next round */
  eligibilityFloor: BigInt(env("ELIGIBILITY_FLOOR_WEI", (100_000n * 10n ** 18n).toString())),
  samples: Number(env("SAMPLES", "12")),
  /** addresses that never hold a share, on top of the per-coin ones (curve, vault, factory, burn) */
  poolManager: env("POOL_MANAGER", "0x8366a39CC670B4001A1121B8F6A443A643e40951") as Address,
  hook: env("HOOK", "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044") as Address,
  pons: env("PONS", "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e") as Address,
  extraExcluded: (opt("EXCLUDED") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) as Address[],
  keeperEnabled: env("KEEPER_ENABLED", "1") === "1",
  attesterEnabled: env("ATTESTER_ENABLED", "1") === "1",
};
