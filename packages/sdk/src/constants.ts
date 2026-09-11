import { PublicKey } from "@solana/web3.js";

export const BLACKBOX_PROGRAM_ID = new PublicKey("BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27");
export const ORACLE_PROGRAM_ID = new PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");

export const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
export const LOCAL_VALIDATOR = new PublicKey("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");

export const VRF_EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
export const VRF_EPHEMERAL_TEST_QUEUE = new PublicKey("Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT");

/** Devnet Pyth Lazer feeds pushed into every MagicBlock ER (verified on devnet-tee). */
export const DEVNET_FEEDS = {
  "SOL/USD": { address: new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu"), decimals: 8, lazerId: 6 },
  "BTC/USD": { address: new PublicKey("71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr"), decimals: 8, lazerId: 1 },
  "ETH/USD": { address: new PublicKey("5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG"), decimals: 8, lazerId: 2 },
} as const;
export type FeedName = keyof typeof DEVNET_FEEDS;

export const ENDPOINTS = {
  devnet: {
    base: "https://api.devnet.solana.com",
    baseWs: "wss://api.devnet.solana.com",
    tee: "https://devnet-tee.magicblock.app",
    teeWs: "wss://devnet-tee.magicblock.app",
    router: "https://devnet-router.magicblock.app",
    validator: TEE_VALIDATOR,
    vrfQueue: VRF_EPHEMERAL_QUEUE,
  },
  local: {
    base: "http://127.0.0.1:8899",
    baseWs: "ws://127.0.0.1:8900",
    tee: "http://127.0.0.1:6699",
    teeWs: "ws://127.0.0.1:6700",
    router: "http://127.0.0.1:7799",
    validator: LOCAL_VALIDATOR,
    vrfQueue: VRF_EPHEMERAL_TEST_QUEUE,
  },
} as const;
export type Cluster = keyof typeof ENDPOINTS;

export const USDC_DECIMALS = 6;
export const USDC_SCALE = 1_000_000;
