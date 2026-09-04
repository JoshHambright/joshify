/**
 * A success-or-failure value that must be inspected before use.
 *
 * Joshify talks to a network service that fails in mundane, expected ways —
 * an expired token, a rate limit, no active device. Those are not exceptional,
 * so they are returned rather than thrown, and the type system makes the caller
 * acknowledge them. Genuinely exceptional cases (a bug, a broken invariant)
 * still throw.
 *
 * The error channel is deliberately unconstrained here; P1-09 defines the
 * concrete error taxonomy that fills it.
 *
 * ---
 *
 * Deliberately minimal: no `map` / `mapErr` / `andThen` combinators yet.
 *
 * A first pass included them and they were unsound in ordinary use. Because
 * TypeScript narrows a variable by its assignment, `const r: Result<number,
 * string> = err('boom')` has the *flow* type `Err<string>` at every use site,
 * even though it is declared as the full union. A combinator inferring both
 * `T` and `E` from that argument only ever sees one branch, so the other
 * parameter silently resolves to `unknown` and the callback argument follows
 * — caught here by `noImplicitAny`/TS18046 rather than at runtime.
 *
 * Fixing it properly means threading both parameters through both branches
 * (phantom typing), which is real library design and wants real requirements.
 * P1-09 has those. Until then the type guards below are enough, and they do
 * not have the problem: they take the union and narrow it, inferring nothing
 * from a callback.
 */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(result: Result<T, E>): result is Ok<T> => result.ok;

export const isErr = <T, E>(result: Result<T, E>): result is Err<E> => !result.ok;
