import { describe, expect, it } from "vitest";
import { textResult } from "../src/mcp-common.js";

describe("textResult", () => {
  it("keeps object payloads as structured content", () => {
    const result = textResult("Object result", { ok: true, count: 2 });

    expect(result.structuredContent).toEqual({ ok: true, count: 2 });
  });

  it("wraps array payloads for structured content", () => {
    const result = textResult("Array result", [{ id: 1 }, { id: 2 }]);

    expect(result.structuredContent).toEqual({ data: [{ id: 1 }, { id: 2 }] });
  });

  it("wraps scalar payloads for structured content", () => {
    const result = textResult("Scalar result", "ok");

    expect(result.structuredContent).toEqual({ data: "ok" });
  });
});
