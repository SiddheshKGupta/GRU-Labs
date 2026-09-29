// The default block set -- GRU's Lego baseplate.
//
// Every surface (terminal, MCP server, host hooks) receives a Blocks object
// and never imports a block implementation itself. Replacing a block means
// replacing one line here: a DeepSeek Harness executor, a sandboxed
// executor that finally satisfies P1/P2/P8, or another model route.

import type { Blocks } from "./types.ts";
import { parseContract } from "./contract.ts";
import { WorkspaceExecutor } from "./executors/workspace.ts";
import { FixtureRoute, loadFixture } from "./routes/fixture.ts";
import { ProviderRegistry } from "./routes/providers.ts";
import { openSession } from "./session.ts";

export const defaultBlocks: Blocks = Object.freeze({
  openSession,
  executor: (root, commands) => new WorkspaceExecutor(root, commands),
  catalog: (configs) => new ProviderRegistry(configs),
  fixtureRoute: (script) => new FixtureRoute(loadFixture(script)),
  parseContract,
});
