import { WorkshopError, errorMessage } from './errors';
import { exportApprovedPlan } from './export';
import { LIMITS, OBJECTIVES } from './types';
import type { Objective, PlanRecord, WorkshopSnapshot, WorkshopStore } from './types';

interface NativeExecutionOptions {
  signal?: AbortSignal;
}

export interface OffcutTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean };
  execute(input: unknown, options?: NativeExecutionOptions): unknown;
}

interface NativeModelContext {
  registerTool(tool: OffcutTool, options?: { signal?: AbortSignal }): Promise<void>;
}

const PHYSICAL_MODEL = [
  'Integer millimetres; all stock has the same material and cross-section.',
  'Entered stock lengths are usable lengths, after the human has deducted end trim and defects.',
  'Each produced part consumes one kerf. No free final factory-end cut is assumed.',
  'Sawdust and short scrap are waste; reusable remnants and unopened stock are not.',
  'A plan is a planning estimate, not a machine instruction or a safe-cutting guarantee.',
];

function objectInput(input: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkshopError('INVALID_INPUT', 'Tool input must be a JSON object.');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key))
      throw new WorkshopError(
        'INVALID_INPUT',
        'Unknown input field. Use only fields from this tool’s registered input schema.',
      );
  }
  return input as Record<string, unknown>;
}

function revisionInput(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkshopError(
      'INVALID_INPUT',
      'expectedRevision must be the nonnegative integer returned by get_workshop.',
    );
  }
  return value;
}

function planIdInput(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 64) {
    throw new WorkshopError(
      'INVALID_INPUT',
      'planId must be an existing plan identifier returned by plan_cuts.',
    );
  }
  return value;
}

function describePlan(snapshot: WorkshopSnapshot, plan: PlanRecord) {
  const fresh = plan.basedOnRevision === snapshot.workspace.revision;
  return {
    ...plan,
    currentRevision: snapshot.workspace.revision,
    fresh,
    approved: fresh && snapshot.approvedPlanId === plan.id,
    awaitingHumanApproval: fresh && snapshot.reviewPlanId === plan.id,
    canRequestReview: fresh && plan.solution.complete,
    wasteMm: plan.solution.metrics.kerfMm + plan.solution.metrics.scrapMm,
  };
}

/** Shared, validated domain operations. Native registration is the only agent entrypoint. */
export function createToolDefinitions(
  store: WorkshopStore,
  registrationSignal?: AbortSignal,
): OffcutTool[] {
  const planIdSchema = {
    type: 'string',
    minLength: 1,
    maxLength: 64,
    description: 'Exact plan ID returned by plan_cuts.',
  };
  const revisionSchema = {
    type: 'integer',
    minimum: 0,
    description:
      'Current workspace revision returned by get_workshop. Re-read after any human edit.',
  };
  const definitions: (Omit<OffcutTool, 'execute'> & { run(input: unknown): unknown })[] = [
    {
      name: 'get_workshop',
      title: 'Inspect the shared workshop',
      description:
        'Read the human-recorded stock, protected boards, complete cut requirements, physical settings, revision and existing proposals. Read this before planning. All lengths are integer mm. The human owns measurements and approval; this tool cannot change them.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      run(input) {
        objectInput(input, []);
        const snapshot = store.getSnapshot();
        const { workspace } = snapshot;
        store.recordActivity(
          'webmcp',
          'get_workshop',
          `Read the shared measurements at revision ${workspace.revision}.`,
        );
        return {
          ok: true,
          workspace,
          units: 'mm',
          totalRequiredParts: workspace.requirements.reduce(
            (total, item) => total + item.quantity,
            0,
          ),
          requiredPartsMm: workspace.requirements.reduce(
            (total, item) => total + item.lengthMm * item.quantity,
            0,
          ),
          availableStockMm: workspace.stock.reduce(
            (total, board) => total + (board.locked ? 0 : board.lengthMm),
            0,
          ),
          protectedStockIds: workspace.stock
            .filter((board) => board.locked)
            .map((board) => board.id),
          plans: snapshot.plans.map((plan) => ({
            id: plan.id,
            objective: plan.solution.objective,
            basedOnRevision: plan.basedOnRevision,
            fresh: plan.basedOnRevision === workspace.revision,
            complete: plan.solution.complete,
            approved:
              snapshot.approvedPlanId === plan.id && plan.basedOnRevision === workspace.revision,
            metrics: plan.solution.metrics,
            search: plan.solution.search,
          })),
          physicalModel: PHYSICAL_MODEL,
          workflow:
            'plan_cuts -> inspect_plan/compare_plans -> stage_plan_for_review -> HUMAN approval in the site -> export_cut_list. No tool can approve, unlock stock or consume physical material.',
          limits: {
            stockBoards: LIMITS.stockBoards,
            requirements: LIMITS.requirements,
            totalParts: LIMITS.totalParts,
          },
        };
      },
    },
    {
      name: 'plan_cuts',
      title: 'Propose a checked cutting plan',
      description:
        'Compute and display a proposal for ALL current human-recorded parts. Always respects protected stock, kerf and reusable-remnant settings. Choose least_stock (least stock length opened), fewest_boards (least boards handled), or least_waste (least sawdust plus short scrap). Additional excludedStockIds can only protect MORE boards, never unlock them. Check complete and search.provenOptimal: a bounded search is not a global-optimum guarantee. Creates a proposal, never human approval or stock consumption.',
      inputSchema: {
        type: 'object',
        properties: {
          expectedRevision: revisionSchema,
          objective: { type: 'string', enum: Object.keys(OBJECTIVES) },
          excludedStockIds: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 64 },
            uniqueItems: true,
            maxItems: LIMITS.stockBoards,
            description:
              'Optional additional board IDs to keep untouched, on top of human-protected boards.',
          },
        },
        required: ['expectedRevision', 'objective'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      run(input) {
        const args = objectInput(input, ['expectedRevision', 'objective', 'excludedStockIds']);
        const expectedRevision = revisionInput(args.expectedRevision);
        if (typeof args.objective !== 'string' || !Object.hasOwn(OBJECTIVES, args.objective)) {
          throw new WorkshopError(
            'INVALID_INPUT',
            'objective must be least_stock, fewest_boards or least_waste.',
          );
        }
        let excludedStockIds: string[] | undefined;
        if (args.excludedStockIds !== undefined) {
          const exclusions = args.excludedStockIds;
          if (
            !Array.isArray(exclusions) ||
            exclusions.length > LIMITS.stockBoards ||
            exclusions.some(
              (id, index) =>
                typeof id !== 'string' ||
                !id.trim() ||
                id !== id.trim() ||
                id.length > 64 ||
                exclusions.indexOf(id) !== index,
            )
          ) {
            throw new WorkshopError(
              'INVALID_INPUT',
              'excludedStockIds must be a unique array of existing board IDs.',
            );
          }
          excludedStockIds = exclusions as string[];
        }
        const plan = store.proposePlan(
          { expectedRevision, objective: args.objective as Objective, excludedStockIds },
          'webmcp',
        );
        return {
          ok: true,
          plan: describePlan(store.getSnapshot(), plan),
          nextStep: plan.solution.complete
            ? 'Compare or stage this proposal for human review. It is not approved.'
            : 'No complete plan was found. Read the unfulfilled quantities; the human may need to correct or add stock.',
        };
      },
    },
    {
      name: 'inspect_plan',
      title: 'Inspect a proposal and its material balance',
      description:
        'Read the exact cutting layout, required-part instances, offsets, per-board kerf, reusable remnants, scrap, search proof and freshness of a specific plan. A stale or incomplete plan must not be staged or exported. Does not approve or change a plan.',
      inputSchema: {
        type: 'object',
        properties: { planId: planIdSchema },
        required: ['planId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      run(input) {
        const args = objectInput(input, ['planId']);
        const planId = planIdInput(args.planId);
        const snapshot = store.getSnapshot();
        const plan = snapshot.plans.find((candidate) => candidate.id === planId);
        if (!plan)
          throw new WorkshopError(
            'PLAN_NOT_FOUND',
            'No such plan. Use a current ID from get_workshop or plan_cuts.',
          );
        store.recordActivity(
          'webmcp',
          'inspect_plan',
          `Inspected ${OBJECTIVES[plan.solution.objective].label.toLowerCase()} at basis revision ${plan.basedOnRevision}.`,
        );
        return { ok: true, plan: describePlan(snapshot, plan), physicalModel: PHYSICAL_MODEL };
      },
    },
    {
      name: 'compare_plans',
      title: 'Compare real planning tradeoffs',
      description:
        'Compare two or three complete, fresh plans for the SAME current job. Returns actual material balance and deltas from the first plan, not invented savings or carbon estimates. Negative stock/waste/board deltas mean less used than the first plan. Protected boards and human physical constraints remain unchanged.',
      inputSchema: {
        type: 'object',
        properties: {
          planIds: {
            type: 'array',
            items: planIdSchema,
            minItems: 2,
            maxItems: 3,
            uniqueItems: true,
          },
        },
        required: ['planIds'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      run(input) {
        const args = objectInput(input, ['planIds']);
        if (!Array.isArray(args.planIds) || args.planIds.length < 2 || args.planIds.length > 3) {
          throw new WorkshopError(
            'INVALID_INPUT',
            'planIds must contain two or three different plan IDs.',
          );
        }
        const ids = args.planIds.map(planIdInput);
        if (ids.some((id, index) => ids.indexOf(id) !== index))
          throw new WorkshopError('INVALID_INPUT', 'Choose distinct plan IDs.');
        const snapshot = store.getSnapshot();
        const plans = ids.map((id) => {
          const plan = snapshot.plans.find((candidate) => candidate.id === id);
          if (!plan) throw new WorkshopError('PLAN_NOT_FOUND', `No such plan: ${id}.`);
          if (plan.basedOnRevision !== snapshot.workspace.revision)
            throw new WorkshopError(
              'STALE_PLAN',
              'Comparison requires fresh plans for the current measurements.',
            );
          if (!plan.solution.complete)
            throw new WorkshopError(
              'INCOMPLETE_PLAN',
              'Compare complete plans only; a partial plan has different produced quantities.',
            );
          return plan;
        });
        const first = plans[0].solution.metrics;
        store.recordActivity(
          'webmcp',
          'compare_plans',
          `Compared ${plans.length} complete alternatives for revision ${snapshot.workspace.revision}.`,
        );
        return {
          ok: true,
          revision: snapshot.workspace.revision,
          baselinePlanId: plans[0].id,
          plans: plans.map((plan) => {
            const metrics = plan.solution.metrics;
            return {
              id: plan.id,
              objective: plan.solution.objective,
              metrics,
              wasteMm: metrics.kerfMm + metrics.scrapMm,
              provenOptimal: plan.solution.search.provenOptimal,
              deltaFromFirst: {
                stockUsedMm: metrics.stockUsedMm - first.stockUsedMm,
                boardCount: metrics.boardCount - first.boardCount,
                wasteMm: metrics.kerfMm + metrics.scrapMm - first.kerfMm - first.scrapMm,
                reusableMm: metrics.reusableMm - first.reusableMm,
                utilizationPercentagePoints: (metrics.utilization - first.utilization) * 100,
              },
            };
          }),
        };
      },
    },
    {
      name: 'stage_plan_for_review',
      title: 'Ask the human to review this exact plan',
      description:
        'Display a COMPLETE FRESH proposal in the human review dialog, bound to expectedRevision. Returns awaiting_human_approval immediately. This does NOT approve a cut sheet. The human must use the site approval button; no tool can bypass that decision. A human measurement change invalidates the review.',
      inputSchema: {
        type: 'object',
        properties: { planId: planIdSchema, expectedRevision: revisionSchema },
        required: ['planId', 'expectedRevision'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      run(input) {
        const args = objectInput(input, ['planId', 'expectedRevision']);
        const plan = store.stagePlan(
          planIdInput(args.planId),
          revisionInput(args.expectedRevision),
          'webmcp',
        );
        return {
          ok: true,
          status: 'awaiting_human_approval',
          plan: describePlan(store.getSnapshot(), plan),
          nextStep:
            'Wait for the human to review and approve in the site. No tool can approve. After approval, inspect_plan or export_cut_list can confirm the released cut sheet.',
        };
      },
    },
    {
      name: 'export_cut_list',
      title: 'Export the human-approved cut sheet',
      description:
        'Return CSV text for an exact complete FRESH plan that the human has approved in the site. Rejects unapproved/stale/partial plans. CSV has real per-part lengths, offsets, kerf and final remnants; human-entered text is formula-safe. Produces a planning document, never performs cuts or changes physical inventory.',
      inputSchema: {
        type: 'object',
        properties: { planId: planIdSchema },
        required: ['planId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      run(input) {
        const args = objectInput(input, ['planId']);
        const planId = planIdInput(args.planId);
        const snapshot = store.getSnapshot();
        const exported = exportApprovedPlan(snapshot, planId);
        store.recordExport(planId, 'webmcp');
        return {
          ok: true,
          planId,
          revision: snapshot.workspace.revision,
          mimeType: 'text/csv;charset=utf-8',
          ...exported,
          physicalModel: PHYSICAL_MODEL,
        };
      },
    },
  ];

  return definitions.map(({ run, ...definition }) => ({
    ...definition,
    execute(input, options) {
      try {
        // Chrome 149–152 provides input only; 153+ may additionally supply a signal.
        // Older browsers cannot communicate per-call cancellation to the callback.
        if (registrationSignal?.aborted || options?.signal?.aborted) {
          throw new WorkshopError(
            'ABORTED',
            'This tool invocation was cancelled before execution.',
          );
        }
        return run(input);
      } catch (error) {
        const code = error instanceof WorkshopError ? error.code : 'INTERNAL_ERROR';
        const message = errorMessage(error);
        store.recordActivity('webmcp', `${definition.name} · rejected`, `${code}: ${message}`);
        return {
          ok: false,
          error: {
            code,
            message,
            ...(error instanceof WorkshopError && error.details !== undefined
              ? { details: error.details }
              : {}),
          },
        };
      }
    },
  }));
}

export function initializeWebMCP(store: WorkshopStore): { ready: Promise<void>; dispose(): void } {
  const controller = new AbortController();
  // These are two real native surfaces, not a polyfill: Chrome 149 uses navigator,
  // 150–151 expose both, and 152+ / ChatGPT expose document.modelContext.
  const documentAPI = (document as Document & { modelContext?: NativeModelContext }).modelContext;
  const navigatorAPI = (navigator as Navigator & { modelContext?: NativeModelContext })
    .modelContext;
  const native =
    documentAPI && typeof documentAPI.registerTool === 'function'
      ? documentAPI
      : navigatorAPI && typeof navigatorAPI.registerTool === 'function'
        ? navigatorAPI
        : null;
  const provider =
    native === documentAPI ? 'document' : native === navigatorAPI ? 'navigator' : null;

  store.setBridge({
    state: 'checking',
    provider,
    registeredTools: 0,
    message: 'Checking native WebMCP support…',
  });
  const ready = (async () => {
    if (!native) {
      store.setBridge({
        state: 'unsupported',
        provider: null,
        registeredTools: 0,
        message:
          'Manual planning works here. For your browser agent, use ChatGPT’s in-app browser or enable WebMCP in Chrome 149+ and restart.',
      });
      return;
    }
    try {
      const tools = createToolDefinitions(store, controller.signal);
      for (const tool of tools) await native.registerTool(tool, { signal: controller.signal });
      if (!controller.signal.aborted) {
        store.setBridge({
          state: 'ready',
          provider,
          registeredTools: tools.length,
          message: `${tools.length} native WebMCP tools registered in this document. Your browser agent can discover them.`,
        });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      controller.abort();
      store.setBridge({
        state: 'error',
        provider,
        registeredTools: 0,
        message: `Native tool registration failed: ${errorMessage(error)}. Manual planning remains available.`,
      });
    }
  })();
  return { ready, dispose: () => controller.abort() };
}
