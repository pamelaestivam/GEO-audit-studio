/**
 * Ports for the end-to-end suites. Node's built-in `fetch` (undici) refuses to connect to a fixed list of "bad ports"
 * (the WHATWG Fetch list of ports reserved for other protocols: 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665-6669,
 * 6679, 6697 among others) and fails at once with `TypeError: fetch failed`, cause `bad port`, without ever connecting.
 * A suite whose random port range contained one of them failed on that draw about 1 run in 100: a server that was
 * running fine looked dead to the test's own health check, or a fake Gemini that was listening looked unreachable to the
 * server (the audit then took about 15 s, the server's 5 s + 10 s retry waits, and the fake saw no request).
 * Found 2026-10-10 (TECH_DEBT 2.14). Every suite draws its ports through this file; test/ports.test.ts checks the list
 * against the running Node and fails if a suite goes back to raw random arithmetic.
 */
export const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** A random port in [base, base + span) that fetch will connect to. */
export function randomPort(base: number, span: number): number {
  for (let tries = 0; tries < 1000; tries++) {
    const p = base + Math.floor(Math.random() * span);
    if (!FETCH_BAD_PORTS.has(p)) return p;
  }
  throw new Error(`no usable port in ${base}..${base + span - 1}`);
}

/** Successive ports from a random start, skipping the ones fetch refuses: `const ports = new PortRange(4300, 300); ports.take()`. */
export class PortRange {
  private next: number;
  constructor(base: number, span: number) {
    this.next = randomPort(base, span);
  }
  take(): number {
    const port = this.next;
    do {
      this.next++;
    } while (FETCH_BAD_PORTS.has(this.next));
    return port;
  }
}
