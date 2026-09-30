import type { Address } from "viem";
import { cfg } from "./config.ts";
import { pub, walletFor } from "./chain.ts";
import { sql } from "./db.ts";
import { vaultAbi } from "./abi.ts";
import { log, warn } from "./log.ts";

// A fallback keeper: anyone may run a ready round and take the 3% tip. This one makes sure rounds stay
// regular even before independent keepers show up.
export async function runReadyRounds(): Promise<number> {
  const wallet = walletFor(cfg.keeperPk);
  if (!wallet || !cfg.keeperEnabled) return 0;
  const vaults = (await sql`select vault from coins`).map((r) => r.vault as Address);
  if (!vaults.length) return 0;
  const ready = await pub.multicall({
    contracts: vaults.map((v) => ({ address: v, abi: vaultAbi, functionName: "roundReady" as const })),
    allowFailure: true,
  });
  let ran = 0;
  for (let i = 0; i < vaults.length; i++) {
    if (ready[i].status !== "success" || ready[i].result !== true) continue;
    try {
      const { request } = await pub.simulateContract({ account: wallet.account, address: vaults[i], abi: vaultAbi, functionName: "runRound" });
      const hash = await wallet.writeContract(request);
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      log("keeper", `${vaults[i]}: round run in block ${rc.blockNumber} (${hash})`);
      ran++;
    } catch (e) {
      warn("keeper", `${vaults[i]}: runRound skipped: ${String((e as Error).message).split("\n")[0].slice(0, 160)}`);
    }
  }
  return ran;
}
