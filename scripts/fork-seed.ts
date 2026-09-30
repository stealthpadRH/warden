// Seeds a LOCAL fork of Robinhood Chain for rehearsal: deploys the factory from the compiled bytecode,
// launches $STEALTH and three coins through the real launchpad, sets the $STEALTH sink, and trades.
//   RPC=http://127.0.0.1:8547 pnpm exec tsx scripts/fork-seed.ts
// Never point this at mainnet: it refuses chain 4663.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { curveAbi, erc20Abi, factoryAbi, ponsAbi } from "../src/abi.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const RPC = process.env.RPC ?? "http://127.0.0.1:8547";
const keys = JSON.parse(fs.readFileSync(path.join(root, ".localdev/keys.json"), "utf8")) as Record<string, { address: Address; pk: Hex }>;

const RH = {
  PONS: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address,
  ESCROW: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e" as Address,
  HOOK: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as Address,
  WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address,
  POOL: "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca" as Address,
};

const pub = createPublicClient({ transport: http(RPC) });
const chainId = await pub.getChainId();
if (chainId === 4663) throw new Error("refusing to seed mainnet");
const chain = defineChain({ id: chainId, name: `Robinhood fork ${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const w = (role: string) => createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(keys[role].pk) });

async function send(p: Promise<Hex>) {
  const hash = await p;
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`tx failed ${hash}`);
  return rc;
}

// Logos go through the same pipeline as an upload (512 px WebP, stored by hash), so the board shows them
// exactly as it would show a launcher's: the app only renders images it stored itself.
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://stealthpad@127.0.0.1:5544/stealthpad";
const APP_URL = process.env.APP_URL ?? "http://localhost:3150";
type Sharp = (input: Buffer) => { resize(w: number, h: number, o: object): { webp(o: object): { toBuffer(): Promise<Buffer> } } };
const sharp = createRequire(path.join(root, "app/package.json"))("sharp") as Sharp;
const db = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
await db.unsafe(fs.readFileSync(path.join(root, "worker/src/schema.sql"), "utf8"));

const ART: Record<string, string> = {
  GLASS: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0c3b36"/><stop offset="1" stop-color="#04110f"/></linearGradient><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b8fff0"/><stop offset=".5" stop-color="#3fd3b4"/><stop offset="1" stop-color="#0d6b5b"/></linearGradient></defs><rect width="512" height="512" fill="url(#b)"/><polygon points="256,86 392,206 256,426 120,206" fill="url(#g)" opacity=".95"/><polygon points="256,86 392,206 256,236" fill="#e9fffa" opacity=".55"/><polygon points="120,206 256,236 256,426" fill="#0a4f45" opacity=".6"/><polygon points="256,236 392,206 256,426" fill="#1f9c85" opacity=".5"/></svg>`,
  VEIL: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#251a4a"/><stop offset="1" stop-color="#0b0818"/></linearGradient><linearGradient id="v" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e2d8ff"/><stop offset="1" stop-color="#7b5cff"/></linearGradient></defs><rect width="512" height="512" fill="url(#b)"/><path d="M96 150 C 190 110, 322 110, 416 150 L 400 400 C 350 360, 300 430, 256 380 C 212 430, 162 360, 112 400 Z" fill="url(#v)" opacity=".9"/><path d="M150 190 C 220 170, 292 170, 362 190 L 350 340 C 318 312, 288 352, 256 322 C 224 352, 194 312, 162 340 Z" fill="#251a4a" opacity=".45"/></svg>`,
  NOCTA: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><radialGradient id="b" cx=".3" cy=".25" r="1"><stop offset="0" stop-color="#16325a"/><stop offset="1" stop-color="#050a16"/></radialGradient></defs><rect width="512" height="512" fill="url(#b)"/><path d="M322 108 A 160 160 0 1 0 404 350 A 128 128 0 1 1 322 108 Z" fill="#f4d98a"/><circle cx="150" cy="140" r="5" fill="#fff"/><circle cx="410" cy="120" r="4" fill="#fff" opacity=".8"/><circle cx="380" cy="430" r="3" fill="#fff" opacity=".7"/><circle cx="96" cy="330" r="3.5" fill="#fff" opacity=".7"/></svg>`,
};

async function storeLogo(symbol: string): Promise<string> {
  const input = symbol === "STEALTH" ? fs.readFileSync(path.join(root, "app/public/brand/logo-1024.webp")) : Buffer.from(ART[symbol] ?? ART.GLASS);
  const out = await sharp(input).resize(512, 512, { fit: "cover" }).webp({ quality: 86 }).toBuffer();
  const hash = createHash("sha256").update(out).digest("hex").slice(0, 32);
  await db`insert into images (hash, mime, bytes) values (${hash}, 'image/webp', ${out}) on conflict (hash) do nothing`;
  return `${APP_URL}/img/${hash}.webp`;
}

const artifact = JSON.parse(fs.readFileSync(path.join(root, "contracts/out/StealthFactory.sol/StealthFactory.json"), "utf8"));
const deployer = w("deployer");
const deployHash = await deployer.deployContract({
  abi: factoryAbi,
  bytecode: artifact.bytecode.object as Hex,
  args: [
    { pons: RH.PONS, escrow: RH.ESCROW, hook: RH.HOOK, weth: RH.WETH, usdg: RH.USDG, pool: RH.POOL, treasury: keys.treasury.address },
    keys.guardian.address,
    keys.attester.address,
  ],
});
const deployRc = await pub.waitForTransactionReceipt({ hash: deployHash });
const factory = deployRc.contractAddress as Address;
console.log("factory", factory, "block", deployRc.blockNumber);

const launchFee = await pub.readContract({ address: RH.PONS, abi: ponsAbi, functionName: "launchFee" });
const coins: { symbol: string; token: Address; vault: Address; curve: Address; tax: number }[] = [];

async function launch(role: string, name: string, symbol: string, tax: number, firstBuy: string, description: string) {
  const wc = w(role);
  const input = {
    name,
    symbol,
    logo: await storeLogo(symbol),
    description,
    socials: { twitter: "", telegram: "", discord: "", website: "https://stealthpad.online", farcaster: "" },
    // deterministic per symbol: a re-seeded fork gets the same addresses every time
    salt: `0x${Buffer.from(`stealthpad-rehearsal-${symbol}`).toString("hex").padEnd(64, "0").slice(0, 64)}` as Hex,
  };
  const { result, request } = await pub.simulateContract({
    account: wc.account,
    address: factory,
    abi: factoryAbi,
    functionName: "launch",
    args: [input, tax, 0n],
    value: launchFee + parseEther(firstBuy),
  });
  await send(wc.writeContract(request));
  const [vault, token] = result as [Address, Address];
  const curve = (await pub.readContract({ address: vault, abi: (await import("../src/abi.ts")).vaultAbi, functionName: "curve" })) as Address;
  coins.push({ symbol, token, vault, curve, tax });
  console.log(`launched ${symbol} token ${token} vault ${vault} tax ${tax / 100}%`);
  return { vault, token, curve };
}

const stealth = await launch("deployer", "Stealthpad", "STEALTH", 300, "0.05", "The pad's own coin, under the pad's own rule.");
await send(w("guardian").writeContract({ address: factory, abi: factoryAbi, functionName: "setStealthVault", args: [stealth.vault], chain }));
console.log("stealth sink set");
await launch("launcher", "Glass", "GLASS", 300, "0.2", "A test coin on the fork.");
await launch("launcher", "Veil", "VEIL", 500, "0.1", "A test coin on the fork.");
await launch("launcher", "Nocta", "NOCTA", 100, "0", "A test coin on the fork.");

// let the launch-second snipe tax pass, then trade on the real curves
await pub.request({ method: "evm_increaseTime" as never, params: [30] as never });
await pub.request({ method: "evm_mine" as never, params: [] as never });
const traders = ["trader1", "trader2", "trader3"];
for (const c of coins) {
  for (const [i, t] of traders.entries()) {
    const eth = parseEther(["1.2", "0.6", "0.35"][i]);
    await send(w(t).writeContract({ address: c.curve, abi: curveAbi, functionName: "buy", args: [eth, 0n, keys[t].address], value: eth, chain }));
  }
  // one partial sell so the tax on both legs is exercised
  const bal = (await pub.readContract({ address: c.token, abi: erc20Abi, functionName: "balanceOf", args: [keys.trader2.address] })) as bigint;
  const sell = bal / 3n;
  await send(w("trader2").writeContract({ address: c.token, abi: erc20Abi, functionName: "approve", args: [c.curve, sell], chain }));
  await send(w("trader2").writeContract({ address: c.curve, abi: curveAbi, functionName: "sell", args: [sell, 0n, keys.trader2.address], chain }));
  console.log(`traded ${c.symbol}`);
}

const out = { chainId, rpc: RPC, factory, startBlock: deployRc.blockNumber.toString(), coins };
fs.writeFileSync(path.join(root, ".localdev/deploy.json"), JSON.stringify(out, null, 1));
console.log("wrote .localdev/deploy.json");
await db.end();
