/**
 * Builds the one-click Claude Desktop extension (.dxt): a zip containing a
 * manifest plus the MCP server bundled to a single self-contained .mjs.
 * The user downloads it from the dashboard and double-clicks — Claude
 * Desktop shows an Install dialog. No JSON files, no terminal.
 *
 * The repo path and engine URL are baked in as env at build time, so the
 * bundled server can still start the engine (`start_engine`) and find the
 * dashboard regardless of where Claude Desktop unpacks the extension.
 *
 * The zip is written with a dependency-free STORE-method writer (no
 * compression) — .dxt only requires a valid zip container.
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export async function buildExtension(engineUrl: string): Promise<Buffer> {
  const bundled = await build({
    entryPoints: [`${REPO_ROOT}/src/tools/mcp-server.ts`],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    write: false,
    banner: {
      // Some CJS deps probe require(); give the ESM bundle a real one.
      js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    },
    logLevel: "silent",
  });
  const serverJs = bundled.outputFiles[0]!.text;

  const manifest = {
    dxt_version: "0.1",
    name: "shadow-cortex",
    display_name: "Shadow Cortex",
    version: "0.1.0",
    description:
      "Monitor and drive your local Shadow Cortex trading engine: account status, strategy edits (fail-closed validated), proposal confirm/reject, engine start/restart.",
    author: { name: "Shadow Cortex (self-hosted)" },
    server: {
      type: "node",
      entry_point: "server/index.mjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/index.mjs"],
        env: {
          SHADOW_CORTEX_REPO: REPO_ROOT.replace(/\/$/, ""),
          SHADOW_CORTEX_URL: engineUrl,
        },
      },
    },
  };

  return zipStore([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { name: "server/index.mjs", data: Buffer.from(serverJs) },
  ]);
}

// --- minimal STORE-method zip writer (no dependencies) ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: STORE
    local.writeUInt32LE(0, 10); // mod time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); // method: STORE
    central.writeUInt32LE(0, 12); // mod time/date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 30); // extra + comment lengths
    central.writeUInt32LE(0, 34); // disk start + internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // disk numbers
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16); // central directory offset
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, ...centralParts, end]);
}
