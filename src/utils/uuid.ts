// crypto.randomUUID() is only defined in a SECURE context (HTTPS or http://localhost). When this
// app is served over a plain-http LAN IP (the common home-network setup), it's `undefined`, which
// broke EVERY client action that mints an id (events, chores, shopping, sources, visit log, …).
// Fall back to a v4 UUID built from crypto.getRandomValues (available in insecure contexts too),
// then a non-crypto last resort. Collision-safe enough for local ids.
export function uuid(): string {
  const c: any = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const b: Uint8Array = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
    const h: string[] = [];
    for (let i = 0; i < 16; i++) h.push(b[i].toString(16).padStart(2, '0'));
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
}
