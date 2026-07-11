/**
 * Status breakdown report for `@shrug/ipam`.
 *
 * Groups all resources by status (active / planned / reserved) to show
 * what's live vs on paper.
 *
 * @module
 */
import {
  type PlanSummary,
  readLatestPlan,
  type ReportContext,
} from "../models/ipam.ts";

interface StatusEntry {
  resource: string;
  key: string;
  label: string;
  prefix?: string;
  status: string;
}

interface StatusBreakdown {
  generatedAt: string;
  totals: Record<string, number>;
  active: StatusEntry[];
  planned: StatusEntry[];
  reserved: StatusEntry[];
}

function computeStatus(plan: PlanSummary): StatusBreakdown {
  const entries: StatusEntry[] = [];

  for (const b of plan.blocks) {
    entries.push({
      resource: "region",
      key: b.key,
      label: b.purpose,
      prefix: b.prefix,
      status: b.status,
    });
  }
  for (const s of plan.sites) {
    entries.push({
      resource: "site",
      key: s.key,
      label: s.name,
      prefix: s.prefix,
      status: s.status,
    });
  }
  for (const s of plan.subnets) {
    entries.push({
      resource: "subnet",
      key: s.key,
      label: s.purpose,
      prefix: s.prefix,
      status: s.status,
    });
  }
  for (const t of plan.tunnels) {
    entries.push({
      resource: "tunnel",
      key: t.key,
      label: `${t.endpointA} ↔ ${t.endpointB}`,
      prefix: t.prefix,
      status: t.status,
    });
  }
  for (const lb of plan.loopbacks) {
    entries.push({
      resource: "loopback",
      key: lb.key,
      label: lb.node,
      prefix: lb.address,
      status: lb.status,
    });
  }
  for (const v of plan.anycastVips) {
    entries.push({
      resource: "anycast-vip",
      key: v.key,
      label: v.service,
      prefix: v.address,
      status: v.status,
    });
  }

  const totals: Record<string, number> = {};
  for (const e of entries) {
    totals[e.status] = (totals[e.status] ?? 0) + 1;
  }

  return {
    generatedAt: plan.generatedAt,
    totals,
    active: entries.filter((e) => e.status === "active"),
    planned: entries.filter((e) => e.status === "planned"),
    reserved: entries.filter((e) => e.status === "reserved"),
  };
}

function renderTable(label: string, entries: StatusEntry[]): string[] {
  if (entries.length === 0) return [];
  const lines: string[] = [];
  lines.push(`### ${label} (${entries.length})`, "");
  lines.push("| Type | Key | Label | Prefix |");
  lines.push("| --- | --- | --- | --- |");
  for (const e of entries) {
    lines.push(
      `| ${e.resource} | ${e.key} | ${e.label} | ${e.prefix ?? "—"} |`,
    );
  }
  lines.push("");
  return lines;
}

function renderStatusMarkdown(bd: StatusBreakdown): string {
  const lines: string[] = [];
  lines.push("# Address Plan Status Breakdown", "");
  lines.push(`Plan generated: ${bd.generatedAt}`, "");

  lines.push("## Totals", "");
  lines.push("| Status | Count |");
  lines.push("| --- | --- |");
  for (const [status, count] of Object.entries(bd.totals).sort()) {
    lines.push(`| ${status} | ${count} |`);
  }
  lines.push("");

  lines.push(...renderTable("Active", bd.active));
  lines.push(...renderTable("Planned", bd.planned));
  lines.push(...renderTable("Reserved", bd.reserved));

  return lines.join("\n");
}

/** Status breakdown report definition. */
export const report = {
  name: "@shrug/ipam-status",
  description:
    "Address plan status breakdown: active vs planned vs reserved resources.",
  scope: "model" as const,
  labels: ["ipv6", "ipam", "status"],
  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const plan = await readLatestPlan(context);
    if (!plan) {
      return {
        markdown:
          "# Status\n\n_No plan data yet — run the `plan` method first._\n",
        json: { error: "no plan data" },
      };
    }

    const bd = computeStatus(plan);
    return {
      markdown: renderStatusMarkdown(bd),
      json: bd as unknown as Record<string, unknown>,
    };
  },
};
