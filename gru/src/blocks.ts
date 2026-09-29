// The default block set -- GRU's Lego baseplate.
//
// Every surface (terminal, MCP server, host hooks) receives a Blocks object
// and never imports a block implementation itself. Replacing a block means
// replacing one line here: a DeepSeek Harness executor, a sandboxed
// executor that finally satisfies P1/P2/P8, or another model route.

import type { Blocks } from "./types.ts";
import { parseContract } from "./contract.ts";
import { NodePermissionIsolation, type IsolationBackend } from "./executors/isolation.ts";
import { OpenSandboxIsolation } from "./executors/opensandbox.ts";
import { WorkspaceExecutor } from "./executors/workspace.ts";
import { FixtureRoute, loadFixture } from "./routes/fixture.ts";
import { ProviderRegistry } from "./routes/providers.ts";
import { openSession } from "./session.ts";

/**
 * GRU_ISOLATION picks the backend: "node" (default), "opensandbox" (with
 * OPEN_SANDBOX_URL, GRU_SANDBOX_IMAGE, key in OPEN_SANDBOX_API_KEY; quarantined,
 * provides nothing until admitted) or "none". Anything else is an error, never
 * a silent downgrade.
 */
export function isolationFrom(env: Record<string, string | undefined>): IsolationBackend | undefined {
  switch (env.GRU_ISOLATION ?? "node") {
    case "node":
      return new NodePermissionIsolation();
    case "opensandbox":
      return new OpenSandboxIsolation({ url: env.OPEN_SANDBOX_URL ?? "http://localhost:8080/v1", image: env.GRU_SANDBOX_IMAGE ?? "node:22" });
    case "none":
      return undefined;
    default:
      throw new Error(`GRU_ISOLATION=${env.GRU_ISOLATION} is not node, opensandbox or none`);
  }
}

const blocks: Blocks = {
  openSession,
  // Declared commands and checks that run node are confined by Node's
  // permission model; anything else runs unconfined and the safety label says so.
  executor: (root, commands) => {
    const isolation = isolationFrom(process.env);
    return new WorkspaceExecutor(root, commands, isolation === undefined ? {} : { isolation });
  },
  catalog: (configs) => new ProviderRegistry(configs),
  fixtureRoute: (script) => new FixtureRoute(loadFixture(script)),
  parseContract,
};

export const defaultBlocks: Blocks = Object.freeze(blocks);
