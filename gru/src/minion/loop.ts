// The Minion loop: model turn -> governed tool calls -> results -> next turn.
//
// The loop is deliberately dumb. It never decides whether a call is
// allowed (the session's gate does), never closes the session (the caller
// does, so closure is always an explicit act with the loop's outcome), and
// never reads the model's text as a sign of success: COMPLETED only means
// the model stopped asking for tools. Whether the work is done is for the
// verification contract to say.
//
// Calls from a turn that stopped on refusal, max_tokens or an unknown stop
// reason are never run. A truncated turn can carry a tool call whose input
// was cut off mid-stream, and a refusal is not a request to act.
//
// Limits: errors thrown by the session itself (handle, recordTurn) are not
// route errors and are not caught here; they propagate to the caller,
// because no LoopOutcome describes a kernel failure truthfully. A running
// loop cannot be interrupted except by its budgets.

import { RouteError } from "../types.ts";
import type { GovernedSession, LoopOutcome, ModelRoute, ModelTurn, RouteSession, ToolCall, ToolResult } from "../types.ts";
import { minionSystemPrompt } from "./prompt.ts";

export type MinionEvent =
  | { type: "turn"; turn: ModelTurn; index: number }
  | { type: "call"; call: ToolCall; result: ToolResult }
  | { type: "error"; message: string; retryable: boolean | null; status: number | null }
  | { type: "end"; outcome: LoopOutcome; reason: string };

export interface MinionBudget {
  max_turns: number;
  max_tool_calls: number;
}

export interface RunMinionOptions {
  session: Pick<GovernedSession, "contract" | "tools" | "handle" | "recordTurn">;
  route: ModelRoute;
  budget?: MinionBudget;
  onEvent?: (event: MinionEvent) => void;
}

export interface MinionRun {
  outcome: LoopOutcome;
  turns: number;
  tool_calls: number;
}

function routeFailure(error: unknown): MinionEvent {
  if (error instanceof RouteError) {
    return { type: "error", message: error.message, retryable: error.retryable, status: error.status };
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { type: "error", message, retryable: null, status: null };
}

export async function runMinion(options: RunMinionOptions): Promise<MinionRun> {
  const { session, route, onEvent } = options;
  const budget = options.budget ?? session.contract.budget;
  let turns = 0;
  let toolCalls = 0;

  const end = (outcome: LoopOutcome, reason: string): MinionRun => {
    onEvent?.({ type: "end", outcome, reason });
    return { outcome, turns, tool_calls: toolCalls };
  };

  let conversation: RouteSession;
  let turn: ModelTurn;
  try {
    conversation = route.open({ system: minionSystemPrompt(session), task: session.contract.task, tools: session.tools });
    turn = await conversation.next({ results: [] });
  } catch (error) {
    onEvent?.(routeFailure(error));
    return end("ROUTE_ERROR", "the route failed before the first turn");
  }

  for (;;) {
    turns++;
    session.recordTurn(turn);
    onEvent?.({ type: "turn", turn, index: turns });

    if (turn.stop === "refusal") return end("REFUSED", "the model refused; its tool calls were not run");
    if (turn.stop === "max_tokens") return end("TRUNCATED", "the turn hit the output limit; its tool calls were not run");
    if (turn.stop === "other") return end("TRUNCATED", "the turn stopped for an unrecognised reason; its tool calls were not run");
    if (turn.calls.length === 0) return end("COMPLETED", "the model stopped calling tools");
    if (turns >= budget.max_turns) {
      return end("BUDGET_EXHAUSTED", `turn budget of ${budget.max_turns} reached; this turn's calls were not run`);
    }

    const results: ToolResult[] = [];
    for (const call of turn.calls) {
      if (toolCalls >= budget.max_tool_calls) {
        return end("BUDGET_EXHAUSTED", `tool-call budget of ${budget.max_tool_calls} reached; remaining calls were not run`);
      }
      toolCalls++;
      const result = await session.handle(call);
      results.push(result);
      onEvent?.({ type: "call", call, result });
    }

    try {
      turn = await conversation.next({ results });
    } catch (error) {
      onEvent?.(routeFailure(error));
      return end("ROUTE_ERROR", "the route failed mid-episode");
    }
  }
}
