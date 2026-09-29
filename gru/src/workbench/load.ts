// Reads every episode ledger in a state directory into Workbench input.
// A ledger that fails to parse or verify is shown as broken, never skipped.

import { parseLedger, type LedgerEvent } from "../ledger/ledger.ts";
import { FileStore, listEpisodes } from "../ledger/store.ts";
import { verifyChain, verifyStructure } from "../ledger/validate.ts";
import { buildView, type EpisodeInput, type WorkbenchView } from "./model.ts";

export function loadEpisodes(stateDir: string): EpisodeInput[] {
  return listEpisodes(stateDir).map((episode_id) => {
    let events: LedgerEvent[] = [];
    const problems: string[] = [];
    let blob: ((digest: string) => string | undefined) | undefined;
    try {
      const store = FileStore.open(stateDir, episode_id);
      blob = (digest) => {
        const bytes = store.getBlob(digest);
        return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
      };
      events = parseLedger(store.lines());
      problems.push(...verifyChain(events), ...verifyStructure(events));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    return blob === undefined ? { episode_id, events, problems } : { episode_id, events, problems, blob };
  });
}

export function loadView(stateDir: string, now: Date = new Date()): WorkbenchView {
  return buildView(loadEpisodes(stateDir), now);
}
