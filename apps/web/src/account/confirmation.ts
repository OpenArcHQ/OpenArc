/**
 * A one-shot user-confirmation gate used by the wallet flow so the exact
 * server SIWE bytes are shown and explicitly confirmed before `personal_sign`.
 * Keeping this as a tiny pure helper makes the "no signing on connect alone"
 * rule unit-testable without a browser.
 */

export interface PendingConfirmation<T> {
  readonly value: T;
  confirm(): void;
  cancel(): void;
  readonly promise: Promise<boolean>;
}

export function createConfirmation<T>(value: T): PendingConfirmation<T> {
  let settled = false;
  let resolve!: (confirmed: boolean) => void;
  const promise = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  const finish = (confirmed: boolean): void => {
    if (settled) return;
    settled = true;
    resolve(confirmed);
  };
  return {
    value,
    confirm: () => finish(true),
    cancel: () => finish(false),
    promise,
  };
}
