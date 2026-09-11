/** Browser polyfill: several Solana libraries expect a global Buffer. Import before them. */
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;

export { Buffer };
