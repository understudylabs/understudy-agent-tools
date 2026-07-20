/**
 * Resolve Chat's selected model while the active route catalog catches up.
 * The client supplies its strongest usable route; an explicit human choice is
 * sticky for as long as that route remains active.
 */
export function resolveChatModelSelection({
  currentId,
  choiceIds,
  preferredActiveId,
  userSelected,
}) {
  const currentExists = Boolean(currentId && choiceIds.includes(currentId));
  if (userSelected && currentExists) {
    return { selectedId: currentId, userSelected: true };
  }
  if (preferredActiveId && choiceIds.includes(preferredActiveId)) {
    return { selectedId: preferredActiveId, userSelected: false };
  }
  if (currentExists) {
    return { selectedId: currentId, userSelected: false };
  }
  return { selectedId: choiceIds[0] ?? null, userSelected: false };
}
