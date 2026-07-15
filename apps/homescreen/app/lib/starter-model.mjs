const ACTIVE_SLOT_STATES = new Set(["loading", "running"]);

export function defaultStarterModel(models) {
  return models.find((model) => model.default_rung) ?? null;
}

export function hasActiveLocalModel(slots) {
  return slots.some((slot) => ACTIVE_SLOT_STATES.has(slot.state));
}

export function shouldPrepareStarter({ starter, slots, attempted, dismissed }) {
  return Boolean(
    starter?.cached &&
      !attempted &&
      !dismissed &&
      !hasActiveLocalModel(slots),
  );
}

export function shouldOfferStarterDownload({ starter, slots, dismissed }) {
  return Boolean(
    starter &&
      !starter.cached &&
      !dismissed &&
      !hasActiveLocalModel(slots),
  );
}
