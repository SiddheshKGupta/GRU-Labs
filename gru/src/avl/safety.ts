// Labelled safety mode (SLICE_1 §4.3, ADR-003 §6): proceeding quietly on a
// weaker boundary is forbidden, so every episode states which threat-model
// properties no admitted isolation backend satisfies.
//
// P1 (T3 cannot read T1 secrets), P2 (T3 cannot mutate T1 policy or state)
// and P8 (no ambient filesystem, network or credential authority) are the
// ones only confinement can give. A backend's `provides` list is the
// Director's admission decision (D5); this function records it and does not
// test the backend.

import type { SafetyMode } from "../types.ts";

export const CONFINEMENT_PROPERTIES = ["P1", "P2", "P8"] as const;

export function computeSafety(backends: readonly { id: string; provides: readonly string[] }[]): SafetyMode {
  const provided = new Set(backends.flatMap((backend) => backend.provides));
  const unmet = CONFINEMENT_PROPERTIES.filter((property) => !provided.has(property)).sort();
  return {
    mode: unmet.length === 0 ? "GOVERNED" : "UNSAFE_DEVELOPMENT",
    unmet,
    backends: backends.map((backend) => backend.id),
  };
}
