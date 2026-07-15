export type StarterModel = {
  id: string;
  short_name?: string | null;
  name: string;
  approx_gb: number;
  default_rung: boolean;
  cached: boolean;
  incomplete: boolean;
};

export type StarterResidencySlot = {
  model_id?: string | null;
  state: string;
};

export function defaultStarterModel(models: StarterModel[]): StarterModel | null;

export function hasActiveLocalModel(slots: StarterResidencySlot[]): boolean;

export function shouldPrepareStarter(options: {
  starter: StarterModel | null;
  slots: StarterResidencySlot[];
  attempted: boolean;
  dismissed: boolean;
}): boolean;

export function shouldOfferStarterDownload(options: {
  starter: StarterModel | null;
  slots: StarterResidencySlot[];
  dismissed: boolean;
}): boolean;
