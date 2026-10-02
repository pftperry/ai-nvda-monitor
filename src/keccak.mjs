/* Keccak-256, the Ethereum variant (original Keccak padding, not FIPS SHA3).

   The project has no dependencies and Node's crypto offers only SHA3-256, which pads
   differently and gives different hashes. Reading Uniswap v4 state needs storage
   slots, and those are keccak hashes, so this is the small exact implementation.
   BigInt lanes: slower than a 32-bit version, but a run hashes a few hundred values
   at most, and the smoke test pins it to known Ethereum hashes. */

const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// rotation offsets, lane index x + 5y
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rot = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

function keccakF(A) {
  const C = new Array(5), B = new Array(25);
  for (let r = 0; r < 24; r++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rot(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) A[x + y] ^= D;
    }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rot(A[x + 5 * y], ROT[x + 5 * y]);
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) A[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & MASK & B[((x + 2) % 5) + y]);
    A[0] ^= RC[r];
  }
}

/** keccak256 of bytes (Uint8Array), a 0x-hex string, or a UTF-8 string; returns 0x-hex. */
export function keccak256(input) {
  let bytes;
  if (input instanceof Uint8Array) bytes = input;
  else if (typeof input === "string" && /^0x[0-9a-fA-F]*$/.test(input)) bytes = Buffer.from(input.slice(2), "hex");
  else bytes = Buffer.from(String(input), "utf8");
  const RATE = 136;
  const padLen = RATE - (bytes.length % RATE);
  const msg = new Uint8Array(bytes.length + padLen);
  msg.set(bytes);
  msg[bytes.length] ^= 0x01;
  msg[msg.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < msg.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(msg[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }
  let out = "0x";
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out += Number((A[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, "0");
  return out;
}

/** The 4-byte selector of a function signature, e.g. "transfer(address,uint256)". */
export const selector = (sig) => keccak256(sig).slice(0, 10);
