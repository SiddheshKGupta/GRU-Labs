// The default block set -- GRU's Lego baseplate.
//
// Every surface (terminal, MCP server, host hooks) receives a Blocks object
// and never imports a block implementation itself. Replacing a block means
// replacing one line here: a DeepSeek Harness executor, a sandboxed
// executor that finally satisfies P1/P2/P8, or another model route.

import type { Blocks } from "./types.ts";
import { parseContract } from "./contract.ts";
import { NodePermissionIsolation } from "./executors/isolation.ts";
import { WorkspaceExecutor } from "./executors/workspace.ts";
import { FixtureRoute, loadFixture } from "./routes/fixture.ts";
import { ProviderRegistry } from "./routes/providers.ts";
import { openSession } from "./session.ts";

const blocks: Blocks = {
  openSession,
  // Declared commands and checks that run node are confined by Node's
  // permission model; anything else runs unconfined and the safety label says so.
  executor: (root, commands) => new WorkspaceExecutor(root, commands, { isolation: new NodePermissionIsolation() }),
  catalog: (configs) => new ProviderRegistry(configs),
  fixtureRoute: (script) => new FixtureRoute(loadFixture(script)),
  parseContract,
};

export const defaultBlocks: Blocks = Object.freeze(blocks);
