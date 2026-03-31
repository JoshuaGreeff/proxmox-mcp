import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import type { RuntimeConfig } from "../src/config.js";
import { createClusterSchema, createCommandStringSchema, createVmidSchema } from "../src/tool-inputs.js";

function runtimeConfig(clusterNames: string[]): RuntimeConfig {
  const parsed = configSchema.parse({
    clusters: clusterNames.map((name) => ({
      name,
      apiUrl: `https://${name}.example:8006`,
      auth: { type: "api_token", user: "root", realm: "pam", tokenId: "mcp", secret: "secret" },
    })),
  });

  return {
    ...parsed,
    configPath: "[test]",
    clusterMap: new Map(parsed.clusters.map((cluster) => [cluster.name, cluster])),
    sshProfileMap: new Map(),
    winrmProfileMap: new Map(),
  };
}

describe("tool input schemas", () => {
  it("defaults cluster to the only configured cluster", () => {
    const schema = createClusterSchema(runtimeConfig(["default"]));
    expect(schema.parse(undefined)).toBe("default");
  });

  it("requires cluster selection when multiple clusters are configured", () => {
    const schema = createClusterSchema(runtimeConfig(["lab-a", "lab-b"]));
    expect(() => schema.parse(undefined)).toThrow(/configured cluster aliases/);
  });

  it("accepts digit-only vmid strings", () => {
    const schema = createVmidSchema();
    expect(schema.parse("100")).toBe(100);
  });

  it("keeps vmid validation action-oriented", () => {
    const schema = createVmidSchema();
    expect(() => schema.parse("vm-100")).toThrow(/digit-only string/);
  });

  it("explains that command must be a single string", () => {
    const schema = createCommandStringSchema("Single command string.");
    expect(() => schema.parse(["bash", "-lc", "uname -a"])).toThrow(/single command string/);
  });
});
