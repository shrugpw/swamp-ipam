/**
 * IPv6 address planner for a region-rooted /40 allocation scheme.
 *
 * Pure-compute model — no external API calls. Takes a root prefix and
 * hierarchical definitions (regions, sites, subnets, tunnels, loopbacks,
 * anycast VIPs) as global arguments, computes fully-qualified prefixes,
 * validates invariants (no overlaps, proper nesting), and writes structured
 * resource data that other models can consume via CEL.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Schemas — global arguments (the plan input)
// ---------------------------------------------------------------------------

const StatusEnum = z.enum(["active", "planned", "reserved"]);

const RegionDefSchema = z.object({
  nibble: z
    .string()
    .regex(/^[0-9a-f]$/)
    .describe(
      "Hex nibble (0-f) after the /36 boundary — selects the /40 block",
    ),
  purpose: z.string().describe("Human label: NA, EU, Clients, Anycast, etc."),
  status: StatusEnum.default("reserved"),
});

const SiteDefSchema = z.object({
  region: z
    .string()
    .describe("Region key from the regions map (e.g. 'na', 'eu')"),
  slotNibble: z
    .string()
    .regex(/^[0-9a-f]$/)
    .describe("Hex nibble selecting the /44 slot within the region's /40"),
  offsetNibble: z
    .string()
    .regex(/^[0-9a-f]$/)
    .default("0")
    .describe(
      "Hex nibble selecting the /48 within the /44 slot (0 = first, d = 0bed-style)",
    ),
  name: z.string().describe("Human-readable site name"),
  location: z.string().describe("City, State/Country"),
  provider: z.string().describe("Hosting provider or ISP"),
  status: StatusEnum.default("planned"),
});

const SubnetDefSchema = z.object({
  site: z.string().describe("Site key from the sites map"),
  vlan: z.number().int().optional().describe("VLAN ID if applicable"),
  nibbles: z
    .string()
    .describe(
      "Hex nibbles after the site /48 to form the /64, e.g. '10' for VLAN 10",
    ),
  purpose: z.string(),
  status: StatusEnum.default("planned"),
});

const TunnelDefSchema = z.object({
  endpointA: z.string().describe("Node name for endpoint A"),
  endpointB: z.string().describe("Node name for endpoint B"),
  index: z
    .number()
    .int()
    .min(0)
    .describe(
      "Sequential index into the /126 pool (0 = ::0/126, 1 = ::4/126, …)",
    ),
  purpose: z.string(),
  status: StatusEnum.default("planned"),
});

const LoopbackDefSchema = z.object({
  node: z.string().describe("Node name"),
  index: z
    .number()
    .int()
    .min(1)
    .describe("Host part of the /128 within the loopback /64 (1-based)"),
  role: z.string().describe(
    "Babel router-id, RR client, route reflector, etc.",
  ),
  status: StatusEnum.default("planned"),
});

const AnycastDefSchema = z.object({
  prefix48: z.string().describe(
    "The /48 this VIP lives in (key from anycastPrefixes)",
  ),
  hostPart: z.string().describe("Host part as hex, e.g. '1', '22', '80'"),
  service: z.string().describe("DNS, Git SSH, HTTP VIP, etc."),
  status: StatusEnum.default("planned"),
});

const AnycastPrefixDefSchema = z.object({
  region: z.string().describe("Region key (use 'anycast' region)"),
  nibbles: z
    .string()
    .describe("Hex after the region /40 to form the /48, e.g. 'ce' for 0ace"),
  purpose: z.string(),
  status: StatusEnum.default("planned"),
});

// --- IPv4 dual-stack input (optional, additive) ---

const V4AllocationDefSchema = z.object({
  size: z
    .number()
    .int()
    .min(1)
    .describe(
      "Minimum number of addresses needed (rounded up to a power of 2)",
    ),
  purpose: z.string(),
  status: StatusEnum.default("planned"),
});

const V4ConfigSchema = z.object({
  root: z
    .string()
    .describe("IPv4 dotted-quad network address, e.g. '192.0.2.0'"),
  rootLength: z
    .number()
    .int()
    .default(24)
    .describe("IPv4 root prefix length"),
  nat64Prefix: z
    .string()
    .describe("IPv6 /96 base literal for NAT64, e.g. '3fff:0db8:64::'"),
  allocations: z
    .record(z.string(), V4AllocationDefSchema)
    .describe("IPv4 public allocations keyed by slug"),
});

const GlobalArgsSchema = z.object({
  root: z
    .string()
    .describe("Allocation root prefix, e.g. '2602:f4fb'"),
  rootLength: z
    .number()
    .int()
    .default(36)
    .describe("Root prefix length"),
  infraRegion: z
    .string()
    .default("infra")
    .describe("Region key for infrastructure (tunnels + loopbacks live here)"),
  infraSlot: z
    .string()
    .regex(/^[0-9a-f]{2}$/)
    .default("0e")
    .describe(
      "Two hex nibbles selecting the /48 within the infra region's /40 (e.g. '0e' for 000e)",
    ),
  loopbackSuffix: z
    .string()
    .default("ffff")
    .describe("The /64 suffix within the infra /48 used for loopback /128s"),
  regions: z.record(z.string(), RegionDefSchema).describe(
    "Region definitions keyed by slug",
  ),
  sites: z.record(z.string(), SiteDefSchema).describe(
    "Site definitions keyed by slug",
  ),
  subnets: z.record(z.string(), SubnetDefSchema).describe(
    "Subnet (/64) assignments keyed by slug",
  ),
  tunnels: z.record(z.string(), TunnelDefSchema).describe(
    "P2P tunnel /126 links keyed by slug",
  ),
  loopbacks: z.record(z.string(), LoopbackDefSchema).describe(
    "Loopback /128s keyed by node slug",
  ),
  anycastPrefixes: z.record(z.string(), AnycastPrefixDefSchema).describe(
    "Anycast /48 blocks",
  ),
  anycastVips: z.record(z.string(), AnycastDefSchema).describe(
    "Anycast service VIPs keyed by slug",
  ),
  v4: V4ConfigSchema.optional().describe(
    "Optional IPv4 public block to plan (dual-stack). Purely additive.",
  ),
});

export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Schemas — resource outputs
// ---------------------------------------------------------------------------

const BlockOutputSchema = z.object({
  key: z.string(),
  nibble: z.string(),
  prefix: z.string(),
  prefixLength: z.number().int(),
  purpose: z.string(),
  status: z.string(),
  siteCount: z.number().int(),
});

const SiteOutputSchema = z.object({
  key: z.string(),
  region: z.string(),
  slotNibble: z.string(),
  name: z.string(),
  location: z.string(),
  provider: z.string(),
  envelope: z.string().describe("The /44 envelope prefix"),
  envelopeLength: z.number().int(),
  prefix: z.string().describe("The initial /48 allocation"),
  prefixLength: z.number().int(),
  status: z.string(),
  subnetCount: z.number().int(),
});

const SubnetOutputSchema = z.object({
  key: z.string(),
  site: z.string(),
  vlan: z.number().int().nullable(),
  prefix: z.string(),
  prefixLength: z.number().int(),
  purpose: z.string(),
  status: z.string(),
});

const TunnelOutputSchema = z.object({
  key: z.string(),
  endpointA: z.string(),
  endpointB: z.string(),
  prefix: z.string().describe("The /126 P2P prefix"),
  prefixLength: z.number().int(),
  addrA: z.string().describe("First usable address (endpoint A)"),
  addrB: z.string().describe("Second usable address (endpoint B)"),
  purpose: z.string(),
  status: z.string(),
});

const LoopbackOutputSchema = z.object({
  key: z.string(),
  node: z.string(),
  address: z.string().describe("Full /128 address"),
  prefixLength: z.number().int(),
  role: z.string(),
  status: z.string(),
});

const AnycastVipOutputSchema = z.object({
  key: z.string(),
  prefix48: z.string(),
  address: z.string().describe("Full /128 VIP address"),
  service: z.string(),
  status: z.string(),
});

// --- IPv4 dual-stack output (optional, additive) ---

const V4AllocationOutputSchema = z.object({
  key: z.string(),
  cidr: z.string(),
  prefixLength: z.number().int(),
  firstAddr: z.string(),
  lastAddr: z.string(),
  usableCount: z.number().int(),
  purpose: z.string(),
  status: z.string(),
});

const V4FreeRangeSchema = z.object({
  firstAddr: z.string(),
  lastAddr: z.string(),
  count: z.number().int(),
});

const V4OutputSchema = z.object({
  root: z.string(),
  rootLength: z.number().int(),
  nat64Prefix: z.string(),
  allocations: z.array(V4AllocationOutputSchema),
  freeRanges: z.array(V4FreeRangeSchema),
  counts: z.object({
    allocations: z.number().int(),
    usedAddresses: z.number().int(),
    freeAddresses: z.number().int(),
  }),
});

const PlanSummarySchema = z.object({
  root: z.string(),
  rootLength: z.number().int(),
  generatedAt: z.iso.datetime(),
  counts: z.object({
    regions: z.number().int(),
    sites: z.number().int(),
    subnets: z.number().int(),
    tunnels: z.number().int(),
    loopbacks: z.number().int(),
    anycastPrefixes: z.number().int(),
    anycastVips: z.number().int(),
  }),
  validationErrors: z.array(z.string()),
  blocks: z.array(BlockOutputSchema),
  sites: z.array(SiteOutputSchema),
  subnets: z.array(SubnetOutputSchema),
  tunnels: z.array(TunnelOutputSchema),
  loopbacks: z.array(LoopbackOutputSchema),
  anycastVips: z.array(AnycastVipOutputSchema),
  v4: V4OutputSchema.optional(),
});

// ---------------------------------------------------------------------------
// Address computation helpers
// ---------------------------------------------------------------------------

/**
 * Build a fully-qualified IPv6 prefix from parts.
 *
 * The root is zero-padded to ceil(rootLength/4) hex nibbles so that
 * `nibbles` starts exactly at the root boundary. For a /36 root like
 * "2602:f4fb", the root hex becomes "2602f4fb0" (9 nibbles), and the
 * region nibble "b" appended gives "2602f4fb0b..." → "2602:f4fb:0b...".
 *
 * @param root Allocation root, e.g. "2602:f4fb"
 * @param rootLength Root prefix length in bits (e.g. 36)
 * @param nibbles Hex nibbles appended after the root boundary
 * @param prefixLen The output prefix length for display
 * @returns Formatted prefix string like "2602:f4fb:0bed::/48"
 */
export function buildPrefix(
  root: string,
  rootLength: number,
  nibbles: string,
  prefixLen: number,
): string {
  const rootHex = root.replace(/:/g, "");
  const rootNibbles = Math.ceil(rootLength / 4);
  const paddedRoot = rootHex.padEnd(rootNibbles, "0");
  const combined = paddedRoot + nibbles;
  const padded = combined.padEnd(32, "0");
  const groups: string[] = [];
  for (let i = 0; i < 32; i += 4) {
    groups.push(padded.slice(i, i + 4));
  }
  const full = groups.join(":");
  const compressed = compressIPv6(full);
  return `${compressed}/${prefixLen}`;
}

/**
 * Build a fully-qualified IPv6 address (no prefix length).
 *
 * @param root Allocation root
 * @param rootLength Root prefix length in bits
 * @param nibbles Hex nibbles appended after the root boundary
 * @returns Compressed IPv6 address
 */
export function buildAddress(
  root: string,
  rootLength: number,
  nibbles: string,
): string {
  const rootHex = root.replace(/:/g, "");
  const rootNibbles = Math.ceil(rootLength / 4);
  const paddedRoot = rootHex.padEnd(rootNibbles, "0");
  const combined = paddedRoot + nibbles;
  const padded = combined.padEnd(32, "0");
  const groups: string[] = [];
  for (let i = 0; i < 32; i += 4) {
    groups.push(padded.slice(i, i + 4));
  }
  return compressIPv6(groups.join(":"));
}

/**
 * Compress an expanded IPv6 address by removing leading zeros per group
 * and collapsing the longest run of all-zero groups to "::".
 */
export function compressIPv6(expanded: string): string {
  const groups = expanded.split(":").map((g) => g.replace(/^0+/, "") || "0");

  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === "0") {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  if (bestLen < 2) return groups.join(":");

  const before = groups.slice(0, bestStart);
  const after = groups.slice(bestStart + bestLen);
  if (before.length === 0 && after.length === 0) return "::";
  if (before.length === 0) return "::" + after.join(":");
  if (after.length === 0) return before.join(":") + "::";
  return before.join(":") + "::" + after.join(":");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Check for overlapping prefixes within a list. */
export function findOverlaps(
  prefixes: Array<{ key: string; prefix: string; length: number }>,
): string[] {
  const errors: string[] = [];
  const sorted = [...prefixes].sort((a, b) => a.prefix.localeCompare(b.prefix));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (
        prefixContains(
          sorted[i].prefix,
          sorted[i].length,
          sorted[j].prefix,
          sorted[j].length,
        )
      ) {
        if (sorted[i].length === sorted[j].length) {
          errors.push(
            `Overlap: ${sorted[i].key} (${sorted[i].prefix}/${
              sorted[i].length
            }) ` +
              `and ${sorted[j].key} (${sorted[j].prefix}/${sorted[j].length})`,
          );
        }
      }
    }
  }
  return errors;
}

/** Check if prefix A contains prefix B (A is same or shorter). */
export function prefixContains(
  aAddr: string,
  aLen: number,
  bAddr: string,
  bLen: number,
): boolean {
  if (aLen > bLen) return false;
  const aBits = addrToBits(aAddr);
  const bBits = addrToBits(bAddr);
  return aBits.slice(0, aLen) === bBits.slice(0, aLen);
}

/** Convert a compressed IPv6 address to a 128-char binary string. */
function addrToBits(addr: string): string {
  const clean = addr.replace(/\/\d+$/, "");
  const expanded = expandIPv6(clean);
  const hex = expanded.replace(/:/g, "");
  return hex
    .split("")
    .map((h) => parseInt(h, 16).toString(2).padStart(4, "0"))
    .join("");
}

/** Expand a compressed IPv6 address to 8 full groups. */
export function expandIPv6(addr: string): string {
  if (addr.includes("::")) {
    const [left, right] = addr.split("::");
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    const midGroups = Array(missing).fill("0000");
    const all = [
      ...leftGroups.map((g) => g.padStart(4, "0")),
      ...midGroups,
      ...rightGroups.map((g) => g.padStart(4, "0")),
    ];
    return all.join(":");
  }
  return addr
    .split(":")
    .map((g) => g.padStart(4, "0"))
    .join(":");
}

// ---------------------------------------------------------------------------
// IPv4 dual-stack helpers + allocator (additive — independent of the v6 paths)
// ---------------------------------------------------------------------------

/** Convert a dotted-quad IPv4 string to a 32-bit unsigned integer. */
export function ipv4ToInt(dotted: string): number {
  const parts = dotted.trim().split(".").map((p) => parseInt(p, 10));
  return (
    ((parts[0] << 24) |
      (parts[1] << 16) |
      (parts[2] << 8) |
      parts[3]) >>> 0
  );
}

/** Convert a 32-bit unsigned integer to a dotted-quad IPv4 string. */
export function intToIpv4(n: number): string {
  const u = n >>> 0;
  return [
    (u >>> 24) & 0xff,
    (u >>> 16) & 0xff,
    (u >>> 8) & 0xff,
    u & 0xff,
  ].join(".");
}

/** Smallest power of 2 that is >= max(n, 1). */
export function nextPow2(n: number): number {
  const m = Math.max(n, 1);
  let p = 1;
  while (p < m) p <<= 1;
  return p;
}

/**
 * Deterministically allocate IPv4 blocks out of a /24 root.
 *
 * Reserves the network (.0) and broadcast (.255) addresses, places each
 * allocation at the lowest aligned offset that fits and does not overlap,
 * and reports the remaining contiguous free ranges. NAT64 /96 containment
 * within the v6 root is validated using the existing IPv6 helpers.
 */
export function computeV4Plan(
  v4: z.infer<typeof V4ConfigSchema>,
  v6Root: string,
  v6RootLength: number,
): { output: z.infer<typeof V4OutputSchema>; errors: string[] } {
  const errors: string[] = [];

  const SIZE = 256; // /24
  const rootInt = ipv4ToInt(v4.root);
  const networkOffset = 0;
  const broadcastOffset = SIZE - 1; // .255

  // Build the placement list, sorted by blockSize desc, name asc.
  const toPlace = Object.entries(v4.allocations).map(([key, def]) => {
    const blockSize = nextPow2(def.size);
    const prefixLength = 32 - Math.round(Math.log2(blockSize));
    return { key, def, blockSize, prefixLength };
  });
  toPlace.sort((a, b) =>
    b.blockSize - a.blockSize || a.key.localeCompare(b.key)
  );

  const placed: Array<{ start: number; end: number }> = [];
  const allocations: z.infer<typeof V4AllocationOutputSchema>[] = [];

  for (const item of toPlace) {
    let chosen = -1;
    for (
      let offset = 0;
      offset + item.blockSize <= SIZE;
      offset += item.blockSize
    ) {
      const start = offset;
      const end = offset + item.blockSize - 1;
      // Must not cover the network or broadcast address.
      if (start <= networkOffset && networkOffset <= end) continue;
      if (start <= broadcastOffset && broadcastOffset <= end) continue;
      // Must not overlap an already-placed block.
      const overlaps = placed.some((b) => start <= b.end && b.start <= end);
      if (overlaps) continue;
      chosen = offset;
      break;
    }

    if (chosen === -1) {
      errors.push(`IPv4: cannot place ${item.key} (/${item.prefixLength})`);
      continue;
    }

    const start = chosen;
    const end = chosen + item.blockSize - 1;
    placed.push({ start, end });
    const firstInt = rootInt + start;
    const lastInt = rootInt + end;
    allocations.push({
      key: item.key,
      cidr: `${intToIpv4(firstInt)}/${item.prefixLength}`,
      prefixLength: item.prefixLength,
      firstAddr: intToIpv4(firstInt),
      lastAddr: intToIpv4(lastInt),
      usableCount: item.blockSize,
      purpose: item.def.purpose,
      status: item.def.status,
    });
  }

  // Compute free ranges within [.1 .. .254] (exclude .0 and .255).
  const used = new Array<boolean>(SIZE).fill(false);
  used[networkOffset] = true;
  used[broadcastOffset] = true;
  for (const b of placed) {
    for (let i = b.start; i <= b.end; i++) used[i] = true;
  }
  const freeRanges: z.infer<typeof V4FreeRangeSchema>[] = [];
  let runStart = -1;
  for (let i = 1; i <= SIZE - 2; i++) {
    if (!used[i]) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      freeRanges.push({
        firstAddr: intToIpv4(rootInt + runStart),
        lastAddr: intToIpv4(rootInt + i - 1),
        count: i - runStart,
      });
      runStart = -1;
    }
  }
  if (runStart !== -1) {
    const endIdx = SIZE - 2;
    freeRanges.push({
      firstAddr: intToIpv4(rootInt + runStart),
      lastAddr: intToIpv4(rootInt + endIdx),
      count: endIdx - runStart + 1,
    });
  }

  const usedAddresses = placed.reduce(
    (sum, b) => sum + (b.end - b.start + 1),
    0,
  );

  // Validate NAT64 /96 containment within the v6 root (existing helpers).
  const v6RootAddr = buildAddress(v6Root, v6RootLength, "");
  const nat64Base = v4.nat64Prefix.replace(/\/\d+$/, "");
  if (!prefixContains(v6RootAddr, v6RootLength, nat64Base, 96)) {
    errors.push(
      `IPv4: nat64Prefix ${v4.nat64Prefix} is not within ${v6Root}/${v6RootLength}`,
    );
  }
  const nat64Compressed = compressIPv6(expandIPv6(nat64Base)) + "/96";

  return {
    output: {
      root: v4.root,
      rootLength: v4.rootLength,
      nat64Prefix: nat64Compressed,
      allocations,
      freeRanges,
      counts: {
        allocations: placed.length,
        usedAddresses,
        freeAddresses: SIZE - 2 - usedAddresses,
      },
    },
    errors,
  };
}

// ---------------------------------------------------------------------------
// Plan computation
// ---------------------------------------------------------------------------

/** Compute the full address plan from global arguments. */
export function computePlan(
  args: GlobalArgs,
): z.infer<typeof PlanSummarySchema> {
  const errors: string[] = [];
  const rl = args.rootLength;

  // --- Blocks (regions -> /40) ---
  const blocks: z.infer<typeof BlockOutputSchema>[] = [];
  for (const [key, region] of Object.entries(args.regions)) {
    const nibbles = region.nibble + "00";
    const siteCount = Object.values(args.sites).filter((s) =>
      s.region === key
    ).length;
    blocks.push({
      key,
      nibble: region.nibble,
      prefix: buildPrefix(args.root, rl, nibbles, 40),
      prefixLength: 40,
      purpose: region.purpose,
      status: region.status,
      siteCount,
    });
  }

  // Validate: no duplicate region nibbles
  const nibbles = Object.values(args.regions).map((r) => r.nibble);
  const nibbleSet = new Set(nibbles);
  if (nibbleSet.size !== nibbles.length) {
    errors.push("Duplicate region nibble detected");
  }

  // --- Sites -> /44 envelope + /48 initial ---
  const sites: z.infer<typeof SiteOutputSchema>[] = [];
  for (const [key, site] of Object.entries(args.sites)) {
    const region = args.regions[site.region];
    if (!region) {
      errors.push(`Site '${key}' references unknown region '${site.region}'`);
      continue;
    }
    const envelopeNibbles = region.nibble + site.slotNibble + "0";
    const offset = site.offsetNibble ?? "0";
    const prefixNibbles = region.nibble + site.slotNibble + offset;
    const subnetCount = Object.values(args.subnets).filter((s) =>
      s.site === key
    ).length;
    sites.push({
      key,
      region: site.region,
      slotNibble: site.slotNibble,
      name: site.name,
      location: site.location,
      provider: site.provider,
      envelope: buildPrefix(args.root, rl, envelopeNibbles, 44),
      envelopeLength: 44,
      prefix: buildPrefix(args.root, rl, prefixNibbles, 48),
      prefixLength: 48,
      status: site.status,
      subnetCount,
    });
  }

  // Validate: no duplicate /48 prefixes within a region (slot + offset)
  const prefixKeys = Object.entries(args.sites).map(([_k, s]) =>
    `${s.region}:${s.slotNibble}:${s.offsetNibble ?? "0"}`
  );
  const prefixKeySet = new Set(prefixKeys);
  if (prefixKeySet.size !== prefixKeys.length) {
    errors.push("Duplicate /48 prefix within a region detected");
  }

  // --- Subnets -> /64 ---
  const subnets: z.infer<typeof SubnetOutputSchema>[] = [];
  for (const [key, subnet] of Object.entries(args.subnets)) {
    const site = args.sites[subnet.site];
    if (!site) {
      errors.push(`Subnet '${key}' references unknown site '${subnet.site}'`);
      continue;
    }
    const region = args.regions[site.region];
    if (!region) continue;
    const siteOffset = site.offsetNibble ?? "0";
    const siteHex = region.nibble + site.slotNibble + siteOffset;
    const subnetNibbles = siteHex + subnet.nibbles.padStart(4, "0");
    subnets.push({
      key,
      site: subnet.site,
      vlan: subnet.vlan ?? null,
      prefix: buildPrefix(args.root, rl, subnetNibbles, 64),
      prefixLength: 64,
      purpose: subnet.purpose,
      status: subnet.status,
    });
  }

  // --- Tunnels -> /126 from first /64 of infra /48 ---
  // infra /48 after root boundary: infraRegion.nibble + infraSlot (3 nibbles)
  // Tunnel addresses: root + infra48 + 0000 (first /64) + ::offset
  const afterRootLen = 32 - Math.ceil(rl / 4);
  const infraRegion = args.regions[args.infraRegion];
  const infra48 = infraRegion ? infraRegion.nibble + args.infraSlot : "00e";
  const tunnelList: z.infer<typeof TunnelOutputSchema>[] = [];
  for (const [key, tunnel] of Object.entries(args.tunnels)) {
    const offset = tunnel.index * 4;
    // infra48 (3 nibbles for /48) + zeros + host offset at the end
    const baseSuffix = offset.toString(16).padStart(4, "0");
    const baseNibbles = infra48 +
      "0".repeat(afterRootLen - infra48.length - 4) + baseSuffix;
    const addrASuffix = offset.toString(16).padStart(4, "0");
    const addrANibbles = infra48 +
      "0".repeat(afterRootLen - infra48.length - 4) + addrASuffix;
    const addrBSuffix = (offset + 1).toString(16).padStart(4, "0");
    const addrBNibbles = infra48 +
      "0".repeat(afterRootLen - infra48.length - 4) + addrBSuffix;

    tunnelList.push({
      key,
      endpointA: tunnel.endpointA,
      endpointB: tunnel.endpointB,
      prefix: buildPrefix(args.root, rl, baseNibbles, 126),
      prefixLength: 126,
      addrA: buildAddress(args.root, rl, addrANibbles),
      addrB: buildAddress(args.root, rl, addrBNibbles),
      purpose: tunnel.purpose,
      status: tunnel.status,
    });
  }

  // Validate: no duplicate tunnel indices
  const tunnelIndices = Object.values(args.tunnels).map((t) => t.index);
  const tunnelIndexSet = new Set(tunnelIndices);
  if (tunnelIndexSet.size !== tunnelIndices.length) {
    errors.push("Duplicate tunnel index detected — /126 collision");
  }

  // --- Loopbacks -> /128 from infra /48 + loopback /64 ---
  // Address: root + infra48 + loopbackSuffix (fills /64) + ::index
  const loopbackList: z.infer<typeof LoopbackOutputSchema>[] = [];
  for (const [key, lb] of Object.entries(args.loopbacks)) {
    const prefix64 = infra48 + args.loopbackSuffix;
    const hostSuffix = lb.index.toString(16).padStart(4, "0");
    const lbNibbles = prefix64 +
      "0".repeat(afterRootLen - prefix64.length - 4) + hostSuffix;
    loopbackList.push({
      key,
      node: lb.node,
      address: buildAddress(args.root, rl, lbNibbles),
      prefixLength: 128,
      role: lb.role,
      status: lb.status,
    });
  }

  // Validate: no duplicate loopback indices
  const lbIndices = Object.values(args.loopbacks).map((l) => l.index);
  const lbSet = new Set(lbIndices);
  if (lbSet.size !== lbIndices.length) {
    errors.push("Duplicate loopback index detected — /128 collision");
  }

  // --- Anycast VIPs ---
  const vipList: z.infer<typeof AnycastVipOutputSchema>[] = [];
  for (const [key, vip] of Object.entries(args.anycastVips)) {
    const acPrefix = args.anycastPrefixes[vip.prefix48];
    if (!acPrefix) {
      errors.push(
        `Anycast VIP '${key}' references unknown prefix '${vip.prefix48}'`,
      );
      continue;
    }
    const region = args.regions[acPrefix.region];
    if (!region) {
      errors.push(
        `Anycast prefix '${vip.prefix48}' references unknown region '${acPrefix.region}'`,
      );
      continue;
    }
    const prefix48Hex = region.nibble + acPrefix.nibbles.padStart(2, "0");
    const hostSuffix = vip.hostPart.padStart(4, "0");
    const vipNibbles = prefix48Hex +
      "0".repeat(afterRootLen - prefix48Hex.length - 4) + hostSuffix;
    vipList.push({
      key,
      prefix48: vip.prefix48,
      address: buildAddress(args.root, rl, vipNibbles),
      service: vip.service,
      status: vip.status,
    });
  }

  // --- Cross-layer overlap checks (same-length prefixes within each tier) ---
  const blockPrefixes = blocks.map((b) => ({
    key: `block:${b.key}`,
    prefix: b.prefix.split("/")[0],
    length: b.prefixLength,
  }));
  errors.push(...findOverlaps(blockPrefixes));

  const sitePrefixes = sites.map((s) => ({
    key: `site:${s.key}`,
    prefix: s.prefix.split("/")[0],
    length: s.prefixLength,
  }));
  errors.push(...findOverlaps(sitePrefixes));

  const subnetPrefixes = subnets.map((s) => ({
    key: `subnet:${s.key}`,
    prefix: s.prefix.split("/")[0],
    length: s.prefixLength,
  }));
  errors.push(...findOverlaps(subnetPrefixes));

  const tunnelPrefixes = tunnelList.map((t) => ({
    key: `tunnel:${t.key}`,
    prefix: t.prefix.split("/")[0],
    length: t.prefixLength,
  }));
  errors.push(...findOverlaps(tunnelPrefixes));

  // --- IPv4 dual-stack plan (optional, additive) ---
  let v4Output: z.infer<typeof V4OutputSchema> | undefined;
  if (args.v4) {
    const v4 = computeV4Plan(args.v4, args.root, args.rootLength);
    errors.push(...v4.errors);
    v4Output = v4.output;
  }

  const result: z.infer<typeof PlanSummarySchema> = {
    root: args.root,
    rootLength: args.rootLength,
    generatedAt: new Date().toISOString(),
    counts: {
      regions: blocks.length,
      sites: sites.length,
      subnets: subnets.length,
      tunnels: tunnelList.length,
      loopbacks: loopbackList.length,
      anycastPrefixes: Object.keys(args.anycastPrefixes).length,
      anycastVips: vipList.length,
    },
    validationErrors: errors,
    blocks,
    sites,
    subnets,
    tunnels: tunnelList,
    loopbacks: loopbackList,
    anycastVips: vipList,
  };
  if (v4Output) result.v4 = v4Output;
  return result;
}

// ---------------------------------------------------------------------------
// Execute context + result types
// ---------------------------------------------------------------------------

interface ExecuteContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

interface ExecuteResult {
  dataHandles: Array<{ name: string }>;
}

// ---------------------------------------------------------------------------
// Report helpers (exported for the companion report extension)
// ---------------------------------------------------------------------------

/** Complete address plan output. */
export type PlanSummary = z.infer<typeof PlanSummarySchema>;
/** Computed regional /40 block. */
export type BlockOutput = z.infer<typeof BlockOutputSchema>;
/** Computed site with /44 envelope and /48 prefix. */
export type SiteOutput = z.infer<typeof SiteOutputSchema>;
/** Computed /64 subnet assignment. */
export type SubnetOutput = z.infer<typeof SubnetOutputSchema>;
/** Computed /126 P2P tunnel link. */
export type TunnelOutput = z.infer<typeof TunnelOutputSchema>;
/** Computed /128 loopback address. */
export type LoopbackOutput = z.infer<typeof LoopbackOutputSchema>;
/** Computed anycast service VIP. */
export type AnycastVipOutput = z.infer<typeof AnycastVipOutputSchema>;

/** Context passed to companion report extensions. */
export interface ReportContext {
  modelType: string;
  modelId: string;
  dataRepository: {
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
}

/** Read the latest plan summary from the data repository. */
export async function readLatestPlan(
  ctx: ReportContext,
): Promise<PlanSummary | null> {
  const bytes = await ctx.dataRepository.getContent(
    ctx.modelType,
    ctx.modelId,
    "plan",
  );
  if (!bytes) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as PlanSummary;
}

/**
 * Render the address plan as a markdown document with tables matching the
 * format of the prose network plan doc.
 */
export function renderMarkdown(plan: PlanSummary): string {
  const lines: string[] = [];
  lines.push(`# IPv6 Address Plan — ${plan.root}::/${plan.rootLength}`, "");
  lines.push(`Generated: ${plan.generatedAt}`, "");

  if (plan.validationErrors.length > 0) {
    lines.push("## Validation Errors", "");
    for (const err of plan.validationErrors) {
      lines.push(`- ${err}`);
    }
    lines.push("");
  }

  lines.push("## Summary", "");
  lines.push(`| Resource | Count |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Regions (/40 blocks) | ${plan.counts.regions} |`);
  lines.push(`| Sites (/44 envelopes) | ${plan.counts.sites} |`);
  lines.push(`| Subnets (/64s) | ${plan.counts.subnets} |`);
  lines.push(`| Tunnels (/126 P2P) | ${plan.counts.tunnels} |`);
  lines.push(`| Loopbacks (/128) | ${plan.counts.loopbacks} |`);
  lines.push(`| Anycast VIPs | ${plan.counts.anycastVips} |`);
  lines.push("");

  // Blocks
  lines.push("## Regional Blocks (/40)", "");
  lines.push("| Nibble | Prefix | Purpose | Status | Sites |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (
    const b of plan.blocks.sort((a, c) => a.nibble.localeCompare(c.nibble))
  ) {
    lines.push(
      `| ${b.nibble} | ${b.prefix} | ${b.purpose} | ${b.status} | ${b.siteCount} |`,
    );
  }
  lines.push("");

  // Sites by region
  const regionGroups = new Map<string, typeof plan.sites>();
  for (const s of plan.sites) {
    const list = regionGroups.get(s.region) ?? [];
    list.push(s);
    regionGroups.set(s.region, list);
  }
  for (const [regionKey, regionSites] of regionGroups) {
    const block = plan.blocks.find((b) => b.key === regionKey);
    const label = block?.purpose ?? regionKey;
    lines.push(`### ${label} Sites`, "");
    lines.push(
      "| Slot | Site | Initial /48 | Location | Provider | Status | Subnets |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (
      const s of regionSites.sort((a, c) =>
        a.slotNibble.localeCompare(c.slotNibble)
      )
    ) {
      lines.push(
        `| ${s.slotNibble} | ${s.name} | ${s.prefix} | ${s.location} | ${s.provider} | ${s.status} | ${s.subnetCount} |`,
      );
    }
    lines.push("");
  }

  // Subnets by site
  const siteSubnets = new Map<string, typeof plan.subnets>();
  for (const s of plan.subnets) {
    const list = siteSubnets.get(s.site) ?? [];
    list.push(s);
    siteSubnets.set(s.site, list);
  }
  if (plan.subnets.length > 0) {
    lines.push("## Subnet Assignments (/64)", "");
    for (const [siteKey, snList] of siteSubnets) {
      const site = plan.sites.find((s) => s.key === siteKey);
      lines.push(`### ${site?.name ?? siteKey}`, "");
      lines.push("| Prefix | VLAN | Purpose | Status |");
      lines.push("| --- | --- | --- | --- |");
      for (const sn of snList) {
        lines.push(
          `| ${sn.prefix} | ${sn.vlan ?? "—"} | ${sn.purpose} | ${sn.status} |`,
        );
      }
      lines.push("");
    }
  }

  // Tunnels
  if (plan.tunnels.length > 0) {
    lines.push("## Tunnel P2P Links (/126)", "");
    lines.push(
      "| Tunnel | Endpoint A | Endpoint B | /126 | Addr A | Addr B | Status |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const t of plan.tunnels.sort((a, c) => a.key.localeCompare(c.key))) {
      lines.push(
        `| ${t.key} | ${t.endpointA} | ${t.endpointB} | ${t.prefix} | ${t.addrA} | ${t.addrB} | ${t.status} |`,
      );
    }
    lines.push("");
  }

  // Topology diagram
  if (plan.tunnels.length > 0 && plan.sites.length > 0) {
    lines.push("## Network Topology", "");
    lines.push("```mermaid");
    lines.push(renderTopologyMermaid(plan));
    lines.push("```", "");
  }

  // Loopbacks
  if (plan.loopbacks.length > 0) {
    lines.push("## Loopback Addresses (/128)", "");
    lines.push("| Node | Address | Role | Status |");
    lines.push("| --- | --- | --- | --- |");
    for (const lb of plan.loopbacks) {
      lines.push(`| ${lb.node} | ${lb.address} | ${lb.role} | ${lb.status} |`);
    }
    lines.push("");
  }

  // Anycast VIPs
  if (plan.anycastVips.length > 0) {
    lines.push("## Anycast Service VIPs", "");
    lines.push("| Service | Address | Status |");
    lines.push("| --- | --- | --- |");
    for (const v of plan.anycastVips) {
      lines.push(`| ${v.service} | ${v.address} | ${v.status} |`);
    }
    lines.push("");
  }

  // IPv4 public allocation (dual-stack, additive)
  if (plan.v4) {
    const v4 = plan.v4;
    lines.push(
      `## IPv4 Public Allocation (${v4.root}/${v4.rootLength})`,
      "",
    );
    lines.push(`NAT64 prefix: ${v4.nat64Prefix}`, "");
    lines.push("| Name | CIDR | Usable | Purpose | Status |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const a of v4.allocations) {
      lines.push(
        `| ${a.key} | ${a.cidr} | ${a.usableCount} | ${a.purpose} | ${a.status} |`,
      );
    }
    lines.push("");
    const freeSummary = v4.freeRanges
      .map((r) => `${r.firstAddr}-${r.lastAddr} (${r.count})`)
      .join(", ");
    lines.push(
      `Free space: ${v4.counts.freeAddresses} addresses` +
        (freeSummary ? ` — ${freeSummary}` : ""),
      "",
    );
  }

  return lines.join("\n");
}

/**
 * Render a Mermaid topology diagram showing regions, sites, and tunnel links.
 * Tunnel endpoints that don't match a site appear as standalone nodes.
 */
export function renderTopologyMermaid(plan: PlanSummary): string {
  const lines: string[] = ["graph LR"];

  const nid = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "_");

  const regionGroups = new Map<string, typeof plan.sites>();
  for (const s of plan.sites) {
    const list = regionGroups.get(s.region) ?? [];
    list.push(s);
    regionGroups.set(s.region, list);
  }

  for (const [regionKey, regionSites] of regionGroups) {
    const block = plan.blocks.find((b) => b.key === regionKey);
    const label = block?.purpose ?? regionKey;
    lines.push(`  subgraph ${nid(regionKey)}["${label}"]`);
    for (const s of regionSites) {
      const icon = s.status === "active"
        ? "🟢"
        : s.status === "planned"
        ? "🟡"
        : "⚪";
      lines.push(
        `    ${nid(s.key)}["${icon} ${s.name}<br/>${s.prefix}"]`,
      );
    }
    lines.push("  end");
  }

  const endpointToSite = (ep: string): string | null => {
    const epLower = ep.toLowerCase();
    for (const s of plan.sites) {
      if (s.name === ep || s.key === ep) return s.key;
      if (
        s.name.toLowerCase().includes(epLower) ||
        epLower.includes(s.name.toLowerCase()) ||
        epLower.includes(s.key.toLowerCase())
      ) {
        return s.key;
      }
    }
    return null;
  };

  const standaloneNodes = new Set<string>();

  for (const t of plan.tunnels) {
    const aKey = endpointToSite(t.endpointA);
    const bKey = endpointToSite(t.endpointB);
    const aId = aKey ?? nid(t.endpointA);
    const bId = bKey ?? nid(t.endpointB);
    if (!aKey) standaloneNodes.add(t.endpointA);
    if (!bKey) standaloneNodes.add(t.endpointB);
    const style = t.status === "active" ? "---" : "-.-";
    lines.push(`  ${aId} ${style} ${bId}`);
  }

  for (const ep of standaloneNodes) {
    lines.push(`  ${nid(ep)}["${ep}"]`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** IPv6 address planner model definition. */
export const model = {
  type: "@shrug/ipam",
  version: "2026.10.16.1",
  description:
    "IPv6 address planner: computes fully-qualified prefixes from a region-rooted /40 allocation scheme and validates invariants. Also optionally plans an IPv4 public block and NAT64 prefix (dual-stack).",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.16.1",
      description:
        "Add optional IPv4 dual-stack planning (v4 field). No migration: v6-only instances are unaffected (v4 is a new optional field).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    "plan": {
      description:
        "Complete address plan with all computed prefixes and validation results",
      schema: PlanSummarySchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    plan: {
      description:
        "Compute the full address plan from the current definitions. " +
        "Produces blocks, sites, subnets, tunnels, loopbacks, and anycast VIPs " +
        "with fully-qualified IPv6 prefixes. Reports validation errors for overlaps " +
        "and referential integrity issues.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const plan = computePlan(context.globalArgs);
        const handle = await context.writeResource(
          "plan",
          "plan",
          plan as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },
  },
  reports: [
    "@shrug/ipam-report",
    "@shrug/ipam-utilization",
    "@shrug/ipam-status",
  ],
};
