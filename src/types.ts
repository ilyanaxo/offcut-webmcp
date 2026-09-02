export type Actor = 'human' | 'webmcp' | 'system';
export type Objective = 'least_stock' | 'fewest_boards' | 'least_waste';

export const OBJECTIVES: Readonly<Record<Objective, { label: string; description: string }>> = {
  least_stock: {
    label: 'Use less stock',
    description: 'Minimize the total length of stock opened for this job.',
  },
  fewest_boards: {
    label: 'Handle fewer boards',
    description: 'Minimize boards handled, then total stock length.',
  },
  least_waste: {
    label: 'Keep useful offcuts',
    description: 'Minimize sawdust and short remnants, then total stock length.',
  },
};

export const LIMITS = {
  stockBoards: 24,
  requirements: 16,
  totalParts: 40,
  lengthMm: 100_000,
  kerfMm: 20,
  searchNodes: 100_000,
  savedPlans: 12,
  activityEvents: 80,
} as const;

export interface StockBoard {
  id: string;
  label: string;
  lengthMm: number;
  kind: 'board' | 'offcut';
  locked: boolean;
}

export interface CutRequirement {
  id: string;
  label: string;
  lengthMm: number;
  quantity: number;
}

export interface PlannerSettings {
  kerfMm: number;
  minReusableMm: number;
}

export interface Workspace {
  revision: number;
  title: string;
  material: string;
  stock: StockBoard[];
  requirements: CutRequirement[];
  settings: PlannerSettings;
}

export interface PlannedCut {
  requirementId: string;
  label: string;
  instance: number;
  lengthMm: number;
  offsetMm: number;
}

export interface BoardLayout {
  stockId: string;
  stockLabel: string;
  stockKind: StockBoard['kind'];
  stockLengthMm: number;
  cuts: PlannedCut[];
  kerfMm: number;
  remnantMm: number;
  remnantKind: 'reusable' | 'scrap' | 'none';
}

export interface PlanMetrics {
  stockUsedMm: number;
  partsMm: number;
  kerfMm: number;
  reusableMm: number;
  scrapMm: number;
  boardCount: number;
  utilization: number;
}

export interface PlanSolution {
  objective: Objective;
  layouts: BoardLayout[];
  metrics: PlanMetrics;
  complete: boolean;
  unfulfilled: { requirementId: string; label: string; quantity: number; reason: string }[];
  excludedStockIds: string[];
  search: {
    method: 'branch-and-bound';
    provenOptimal: boolean;
    nodes: number;
    limit: number;
  };
}

export interface PlanRecord {
  id: string;
  basedOnRevision: number;
  createdAt: string;
  actor: Actor;
  solution: PlanSolution;
}

export interface PlanRequest {
  expectedRevision: number;
  objective: Objective;
  excludedStockIds?: string[];
}

export interface ActivityEvent {
  id: string;
  at: string;
  actor: Actor;
  action: string;
  detail: string;
}

export interface BridgeState {
  state: 'checking' | 'ready' | 'unsupported' | 'error';
  provider: 'document' | 'navigator' | null;
  registeredTools: number;
  message: string;
}

export interface WorkshopSnapshot {
  workspace: Workspace;
  plans: PlanRecord[];
  selectedPlanId: string | null;
  reviewPlanId: string | null;
  approvedPlanId: string | null;
  events: ActivityEvent[];
  bridge: BridgeState;
  notice: string | null;
}

/** Snapshots are immutable; all changes go through these operations. */
export interface WorkshopStore {
  getSnapshot(): WorkshopSnapshot;
  subscribe(listener: () => void): () => void;
  updateProject(patch: Partial<Pick<Workspace, 'title' | 'material'>>): void;
  addStock(input: Omit<StockBoard, 'id'>): void;
  updateStock(id: string, patch: Partial<Omit<StockBoard, 'id'>>): void;
  removeStock(id: string): void;
  addRequirement(input: Omit<CutRequirement, 'id'>): void;
  updateRequirement(id: string, patch: Partial<Omit<CutRequirement, 'id'>>): void;
  removeRequirement(id: string): void;
  setSettings(patch: Partial<PlannerSettings>): void;
  resetSample(): void;
  clearWorkspace(): void;
  proposePlan(input: PlanRequest, actor?: Actor): PlanRecord;
  selectPlan(id: string): void;
  stagePlan(id: string, expectedRevision: number, actor?: Actor): PlanRecord;
  approvePlan(id: string): PlanRecord;
  rejectReview(): void;
  revokeApproval(): void;
  setBridge(state: BridgeState): void;
  recordActivity(actor: Actor, action: string, detail: string): void;
  recordExport(id: string, actor?: Actor): void;
  dismissNotice(): void;
}
