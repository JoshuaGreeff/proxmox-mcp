import { describe, expect, it } from "vitest";
import { normalizeBoolean } from "../src/utils.js";

describe("normalizeBoolean", () => {
  it("treats Proxmox enabled=1 strings as true", () => {
    expect(normalizeBoolean("enabled=1")).toBe(true);
    expect(normalizeBoolean("freeze-fs-on-backup=0,enabled=1")).toBe(true);
  });

  it("treats Proxmox enabled=0 strings as false", () => {
    expect(normalizeBoolean("enabled=0")).toBe(false);
  });
});
