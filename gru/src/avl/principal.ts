// Trust classes (Core threat model v0.1 §1, GRU/Core relationship §1.3).
//
// A principal's trust class is derived from its kind and cannot be passed
// in. GRU, DRU and Nefario are model-driven roles and therefore T3 like any
// Minion; seniority in the organisation chart confers no constitutional
// authority. T4 is information, not an actor, so it has no principal.

export type TrustClass = "T0" | "T1" | "T2" | "T3";
export type PrincipalKind = "director" | "avl" | "provider" | "gru" | "dru" | "nefario" | "minion";

const TRUST: Readonly<Record<PrincipalKind, TrustClass>> = Object.freeze({
  director: "T0",
  avl: "T1",
  provider: "T2",
  gru: "T3",
  dru: "T3",
  nefario: "T3",
  minion: "T3",
});

export interface Principal {
  readonly kind: PrincipalKind;
  readonly id: string;
  readonly trust: TrustClass;
}

export function principal(kind: PrincipalKind, name: string): Principal {
  if (!(kind in TRUST)) throw new Error(`unknown principal kind: ${String(kind)}`);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Error(`invalid principal name: ${name}`);
  return Object.freeze({ kind, id: `${kind}:${name}`, trust: TRUST[kind] });
}

export const AVL = principal("avl", "v0");
