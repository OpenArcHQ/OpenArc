/**
 * Pure render-boundary predicate for tenant mutation state.
 *
 * A committed receipt or in-flight mutation belongs to the signed-in account
 * that produced it. React effects run AFTER render, so an account A->B
 * transition would otherwise paint one frame of account A's receipt/form to
 * account B. This predicate lets the render path synchronously suppress the
 * prior account's mutation state and write controller before any child reads
 * `controller.state` directly.
 *
 * `lastAccountId` is the account the current render-held mutation state belongs
 * to (`null` before any account has been adopted). `accountId` is the account
 * signed in for the render being computed.
 *
 * - same account: keep the state.
 * - initial adoption (`lastAccountId === null`): keep (nothing to leak yet).
 * - signed-out/expired (`accountId === null`): keep. A self-demotion revokes
 *   the session while the same account's committed receipt must stay visible.
 * - A->B (both non-null and different): suppress synchronously.
 */
export function suppressPriorAccountMutation(
  lastAccountId: string | null,
  accountId: string | null,
): boolean {
  if (accountId === null) return false;
  if (lastAccountId === null) return false;
  return lastAccountId !== accountId;
}

/**
 * The mutation state a render is allowed to expose. When the predicate says
 * suppress, the state is forced to idle so no prior account's receipt, draft,
 * pending or unknown outcome is ever painted for the new account.
 */
export function renderMutationState<T extends { readonly kind: string }>(
  lastAccountId: string | null,
  accountId: string | null,
  state: T,
  idle: () => T,
): T {
  return suppressPriorAccountMutation(lastAccountId, accountId) ? idle() : state;
}
