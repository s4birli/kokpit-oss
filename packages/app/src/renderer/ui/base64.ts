// Performans: frames arrive as base64 JPEG. `Uint8Array.from(atob(s), cb)` calls a function per byte — ~15 ms for
// a 300 KB frame on the renderer's main thread, i.e. ~20 % of a core at 15 frames/s. The native decoder takes
// well under a millisecond; the plain loop is the fallback for runtimes without it.
type WithFromBase64 = { fromBase64?: (s: string) => Uint8Array };

/** Bytes of a base64 string; throws on invalid input. */
export function base64ToBytes(data: string): Uint8Array {
  const native = (Uint8Array as unknown as WithFromBase64).fromBase64;
  if (typeof native === "function") return native.call(Uint8Array, data);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
