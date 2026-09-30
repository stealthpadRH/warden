import { migrate, setMeta } from "./db.ts";
import { catchUp } from "./indexer.ts";
import { postRoots, snapshotPending } from "./attester.ts";
import { runReadyRounds } from "./keeper.ts";
import { cfg } from "./config.ts";
import { log, warn } from "./log.ts";

async function stage(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    warn(name, String((e as Error)?.message ?? e).slice(0, 300));
  }
}

async function tick() {
  await stage("index", () => catchUp(50));
  if (cfg.attesterEnabled) {
    await stage("attest", snapshotPending);
    await stage("attest", postRoots);
  }
  await stage("keeper", runReadyRounds);
  await stage("index", () => catchUp(5)); // pick up what this tick just sent
  await setMeta("heartbeat", new Date().toISOString());
}

async function main() {
  await migrate();
  log("main", `chain ${cfg.chainId} · factory ${cfg.factory} · from block ${cfg.startBlock} · keeper ${cfg.keeperEnabled ? "on" : "off"} · attester ${cfg.attesterEnabled ? "on" : "off"}`);
  if (process.env.ONCE === "1") {
    await tick();
    process.exit(0);
  }
  const loop = async () => {
    await tick();
    setTimeout(loop, cfg.tickMs);
  };
  await loop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
