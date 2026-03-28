import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const repoRoot = process.cwd();
const sourcePath = path.join(repoRoot, "vendor", "pve-docs", "api-viewer", "apidata.js");
const outPath = path.join(repoRoot, "docs", "proxmox", "api-summary.json");

const raw = fs.readFileSync(sourcePath, "utf8");
const sandbox = {};
vm.runInNewContext(`${raw}\nthis.apiSchema = apiSchema;`, sandbox);

const apiSchema = sandbox.apiSchema;

function countNode(node) {
  let pathCount = node.path ? 1 : 0;
  let methodCount = node.info ? Object.keys(node.info).length : 0;
  const methodBreakdown = {};

  if (node.info) {
    for (const method of Object.keys(node.info)) {
      methodBreakdown[method] = (methodBreakdown[method] || 0) + 1;
    }
  }

  for (const child of node.children || []) {
    const childCount = countNode(child);
    pathCount += childCount.pathCount;
    methodCount += childCount.methodCount;
    for (const [method, value] of Object.entries(childCount.methodBreakdown)) {
      methodBreakdown[method] = (methodBreakdown[method] || 0) + value;
    }
  }

  return { pathCount, methodCount, methodBreakdown };
}

function findPath(targetPath, nodes) {
  for (const node of nodes) {
    if (node.path === targetPath) {
      return node;
    }
    const found = findPath(targetPath, node.children || []);
    if (found) {
      return found;
    }
  }
  return null;
}

const totals = countNode({ children: apiSchema });
const topLevel = apiSchema.map((node) => {
  const counts = countNode(node);
  return {
    path: node.path,
    childCount: (node.children || []).length,
    pathCount: counts.pathCount,
    methodCount: counts.methodCount,
    methodBreakdown: counts.methodBreakdown,
  };
});

const notablePaths = [
  "/nodes/{node}/execute",
  "/nodes/{node}/termproxy",
  "/nodes/{node}/vncshell",
  "/nodes/{node}/qemu/{vmid}/agent/exec",
  "/nodes/{node}/qemu/{vmid}/agent/exec-status",
  "/nodes/{node}/qemu/{vmid}/agent/file-read",
  "/nodes/{node}/qemu/{vmid}/agent/file-write",
  "/nodes/{node}/qemu/{vmid}/monitor",
  "/nodes/{node}/lxc/{vmid}/termproxy",
  "/nodes/{node}/lxc/{vmid}/vncproxy",
];

const notable = notablePaths
  .map((targetPath) => {
    const node = findPath(targetPath, apiSchema);
    if (!node) {
      return null;
    }

    return {
      path: targetPath,
      methods: Object.fromEntries(
        Object.entries(node.info || {}).map(([method, info]) => [
          method,
          {
            name: info.name,
            description: info.description,
            allowtoken: info.allowtoken,
            protected: info.protected || 0,
            permissions: info.permissions?.description || info.permissions?.check || null,
          },
        ]),
      ),
    };
  })
  .filter(Boolean);

const summary = {
  generatedAt: new Date().toISOString(),
  source: "vendor/pve-docs/api-viewer/apidata.js",
  totals: {
    paths: totals.pathCount,
    methods: totals.methodCount,
    methodBreakdown: totals.methodBreakdown,
  },
  topLevel,
  notable,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n");
console.log(`Wrote ${outPath}`);
