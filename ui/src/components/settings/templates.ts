/**
 * Re-export shim: rule templates are engine domain (strategy content) and
 * live in src/entry/templates.ts so the engine test suite validates them;
 * the module has zero runtime dependencies, so bundling it here is free.
 */

export * from "../../../../src/entry/templates.js";
