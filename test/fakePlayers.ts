import type { Collection } from "mongodb";

import type { PlayerDoc } from "../src/db.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Just what WorldRoom calls: findOne() and updateOne() (upsert, $set, $max, $setOnInsert), plus the
// leaderboard's find({ f: { $gt } }).sort({ f: -1 }).limit(n).toArray() and countDocuments({ f: { $gt } }).
// Reads wait for release(), so a test registers its message handlers before the load answers.
export function fakePlayers(seed: PlayerDoc[] = []) {
  const docs = new Map<string, PlayerDoc>(seed.map((d) => [d._id, d]));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fake = {
    docs,
    gate,
    release,
    async findOne(filter: { _id: string }) {
      await gate;
      return docs.get(filter._id) ?? null;
    },
    find(filter: Record<string, { $gt: number }>) {
      const [field, { $gt }] = Object.entries(filter)[0];
      let rows = [...docs.values()].filter((d: any) => d[field] > $gt);
      const cursor = {
        sort(by: Record<string, number>) {
          const [f, dir] = Object.entries(by)[0];
          rows = rows.sort((a: any, b: any) => dir * ((a[f] ?? 0) - (b[f] ?? 0)));
          return cursor;
        },
        limit(n: number) {
          rows = rows.slice(0, n);
          return cursor;
        },
        toArray: async () => rows,
      };
      return cursor;
    },
    // The Top Countries pipeline: $match ({ f: { $gt } } / { f: { $regex } }), $group by one field
    // with { $sum: "$f" }, $sort ({ f: -1, _id: 1 }).
    aggregate(pipeline: any[]) {
      let rows: any[] = [...docs.values()];
      for (const stage of pipeline) {
        if (stage.$match) {
          rows = rows.filter((d) =>
            Object.entries(stage.$match).every(([f, cond]: [string, any]) =>
              "$gt" in cond ? d[f] > cond.$gt : typeof d[f] === "string" && new RegExp(cond.$regex).test(d[f]),
            ),
          );
        } else if (stage.$group) {
          const { _id, ...sums } = stage.$group;
          const groups = new Map<string, any>();
          for (const d of rows) {
            const key = d[String(_id).slice(1)];
            const g = groups.get(key) ?? { _id: key };
            for (const [out, op] of Object.entries(sums) as [string, any][]) g[out] = (g[out] ?? 0) + (d[String(op.$sum).slice(1)] ?? 0);
            groups.set(key, g);
          }
          rows = [...groups.values()];
        } else if (stage.$sort) {
          const keys = Object.entries(stage.$sort) as [string, number][];
          rows.sort((a, b) => {
            for (const [f, dir] of keys) if (a[f] !== b[f]) return dir * (a[f] < b[f] ? -1 : 1);
            return 0;
          });
        }
      }
      return { toArray: async () => rows };
    },
    async countDocuments(filter: Record<string, { $gt: number }>) {
      const [field, { $gt }] = Object.entries(filter)[0];
      return [...docs.values()].filter((d: any) => d[field] > $gt).length;
    },
    async updateOne(filter: { _id: string }, update: any, options: any) {
      const existing = docs.get(filter._id);
      if (!existing && !options?.upsert) return { modifiedCount: 0 };
      const next: any = { ...(existing ?? { _id: filter._id, ...(update.$setOnInsert ?? {}) }), ...(update.$set ?? {}) };
      for (const [k, v] of Object.entries(update.$max ?? {})) next[k] = Math.max(next[k] ?? -Infinity, v as number);
      docs.set(filter._id, next);
      return { modifiedCount: 1 };
    },
  };
  return fake as unknown as Collection<PlayerDoc> & { docs: Map<string, PlayerDoc>; gate: Promise<void>; release: () => void };
}
