/**
 * Drift guard: docs/DATAPOINTS.md is generated from the engine's field
 * catalogs. If an adapter or enricher adds/changes a FieldDef without
 * regenerating the doc (`npm run docs:fields`), this fails.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { generateFieldDocs } from "../src/tools/generate-field-docs.js";

const DOC = new URL("../docs/DATAPOINTS.md", import.meta.url).pathname;

describe("docs/DATAPOINTS.md", () => {
  it("matches the engine's field catalogs (run `npm run docs:fields` after changing fields)", () => {
    expect(readFileSync(DOC, "utf8")).toBe(generateFieldDocs());
  });
});
