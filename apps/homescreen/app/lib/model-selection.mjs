/**
 * Resolve Chat's selected model while residency catches up after launch.
 * Automatic cloud fallback is temporary; an explicit human choice is sticky.
 */
export function resolveChatModelSelection({
  currentId,
  choiceIds,
  preferredLocalId,
  userSelected,
}) {
  const currentExists = Boolean(currentId && choiceIds.includes(currentId));
  if (userSelected && currentExists) {
    return { selectedId: currentId, userSelected: true };
  }
  if (preferredLocalId && choiceIds.includes(preferredLocalId)) {
    return { selectedId: preferredLocalId, userSelected: false };
  }
  if (currentExists) {
    return { selectedId: currentId, userSelected: false };
  }
  return { selectedId: choiceIds[0] ?? null, userSelected: false };
}
