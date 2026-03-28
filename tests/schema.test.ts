import { describe, expect, it } from "vitest";
import { ApiCatalog } from "../src/schema.js";

describe("ApiCatalog", () => {
  const catalog = new ApiCatalog();

  it("matches and coerces known endpoints from the vendored Proxmox schema", () => {
    const result = catalog.validate("POST", "/nodes/pve1/qemu/100/agent/file-write", {
      file: "/tmp/test.txt",
      content: "hello",
      encode: "1",
    });

    expect(result.descriptor.templatePath).toBe("/nodes/{node}/qemu/{vmid}/agent/file-write");
    expect(result.pathParams).toEqual({ node: "pve1", vmid: "100" });
    expect(result.args).toMatchObject({
      file: "/tmp/test.txt",
      content: "hello",
      encode: true,
    });
  });

  it("rejects unknown parameters when the schema disallows additional properties", () => {
    expect(() =>
      catalog.validate("POST", "/nodes/pve1/qemu/100/agent/file-write", {
        file: "/tmp/test.txt",
        content: "hello",
        unexpected: true,
      }),
    ).toThrow(/Unknown parameter/);
  });

  it("accepts indexed QEMU config parameters that Proxmox documents as [n] keys", () => {
    const result = catalog.validate("PUT", "/nodes/pve1/qemu/100/config", {
      hostpci0: "0000:21:00,pcie=1",
      scsi0: "local-lvm:vm-100-disk-0,size=200G",
      balloon: 0,
    });

    expect(result.descriptor.templatePath).toBe("/nodes/{node}/qemu/{vmid}/config");
    expect(result.args).toMatchObject({
      hostpci0: "0000:21:00,pcie=1",
      scsi0: "local-lvm:vm-100-disk-0,size=200G",
      balloon: 0,
    });
  });
});
