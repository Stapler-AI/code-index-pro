/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "src-isolated",
      comment: "src must not import benchmarks/test/integrations (server core is standalone).",
      severity: "error",
      from: { path: "^src" },
      to: { path: "^(benchmarks|test|integrations)" },
    },
    {
      name: "adapters-innermost",
      comment: "CLI adapters may not import the run/report/instructions application layer.",
      severity: "error",
      from: { path: "^benchmarks/harness/adapters" },
      to: { path: "^benchmarks/harness/(run|report|instructions)\\.ts" },
    },
    {
      name: "bench-src-seam",
      comment:
        "benchmarks may reach into src only via the grandfathered src/storage/meta exact path (ratchet: no new exceptions).",
      severity: "error",
      from: { path: "^benchmarks" },
      to: { path: "^src", pathNot: "^src/storage/meta" },
    },
    {
      name: "no-circular",
      comment: "No circular dependencies.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
  },
};
