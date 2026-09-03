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
  // Advisory only: read tools still audit; returned workshop text/IDs are untrusted data.
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute(input: unknown, options?: NativeExecutionOptions): unknown;
}

// Producer schemas are objects. Tested 149/152 clients discover a real RegisteredTool
// and call executeTool(record, JSON.stringify(input)); discovered schemas and these
// structured callback results are JSON strings on that client surface.
interface NativeModelContext {
  // Pinned 149 registration can return synchronously; 152 returns a promise.
  registerTool(tool: OffcutTool, options?: { signal?: AbortSignal }): void | Promise<void>;
}

const PHYSICAL_MODEL = [
  'Integer mm; one material/cross-section. Stock is usable, after human-deducted end trim/defects.',
  'Per board: sum(parts)+n*kerf+remnant=usable stock; one kerf/part, INCLUDING final (no free factory-end cut).',
  'Positive remnant >= minReusableMm: reusable; shorter: scrap; zero: neither.',
  'Waste=kerf+short scrap, not reusable remnants or unopened stock.',
  'Estimate only; not machine instructions or a safe-cutting guarantee.',
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
    pendingMeasurements: snapshot.pendingMeasurements,
    fresh,
    approved: fresh && snapshot.approvedPlanId === plan.id,
    awaitingHumanApproval: fresh && snapshot.reviewPlanId === plan.id,
    canRequestReview: fresh && plan.solution.complete && !snapshot.pendingMeasurements,
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
        'Read committed human stock/protection, ALL part requirements, settings, revision, pending drafts and proposals BEFORE planning. Integer mm. Measurements and approval are human-owned; this tool changes neither.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
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
          pendingMeasurements: snapshot.pendingMeasurements,
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
            reusedFromPlanId: plan.reusedFromPlanId,
            fresh: plan.basedOnRevision === workspace.revision,
            complete: plan.solution.complete,
            approved:
              snapshot.approvedPlanId === plan.id && plan.basedOnRevision === workspace.revision,
            metrics: plan.solution.metrics,
            search: plan.solution.search,
          })),
          physicalModel: PHYSICAL_MODEL,
          workflow:
            'plan_cuts -> inspect_plan/compare_plans -> stage_plan_for_review -> HUMAN site approval -> export_cut_list. Finish/cancel pending drafts before staging/approval (PENDING_MEASUREMENTS); tools plan/export committed values. No tool approves, unlocks stock or consumes material. reusedFromPlanId: earlier search nodes/proof, never inherited approval.',
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
        'Propose ALL committed parts; honor protection, kerf and remnant rules. Lexicographic goals: least_stock(opened mm,waste,boards), fewest_boards(boards,opened mm,waste), least_waste(waste,opened mm,boards); waste=kerf+short scrap. excludedStockIds only protects MORE stock. Check complete/search.provenOptimal: a budget stop proves neither optimum nor infeasibility. reusedFromPlanId marks reused search nodes/proof, not new search. New IDs are unapproved; no stock is consumed.',
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
      annotations: { readOnlyHint: false, untrustedContentHint: true },
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
        const snapshot = store.getSnapshot();
        return {
          ok: true,
          plan: describePlan(snapshot, plan),
          nextStep: !plan.solution.complete
            ? 'No complete plan was found. Inspect unfulfilled quantities; a budget stop is not proof of infeasibility. The human may need to correct or add stock.'
            : snapshot.pendingMeasurements
              ? 'Inspect/compare this committed proposal. Finish or cancel measurement drafts before requesting review (PENDING_MEASUREMENTS). This new plan ID is unapproved.'
              : 'Compare or stage this unapproved proposal for human review.',
        };
      },
    },
    {
      name: 'inspect_plan',
      title: 'Inspect a proposal and its material balance',
      description:
        'Read exact layouts/instances/offsets, board kerf/reusable remnants/scrap, proof/freshness. reusedFromPlanId marks reused nodes/proof, not rerun search. Stale/partial plans cannot stage/export; pending drafts block review. No changes/approval.',
      inputSchema: {
        type: 'object',
        properties: { planId: planIdSchema },
        required: ['planId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
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
        'Compare 2-3 distinct COMPLETE FRESH plans for the SAME current job: real balances/deltas from first; negative stock/waste/board deltas mean less, not invented savings/carbon. protectedStockIds + each row’s additional excludedStockIds define constraints; sameConstraints/sameConstraintsAsFirst compare EFFECTIVE unions. Different-constraint what-ifs are allowed; human physics/protection stays fixed.',
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
      annotations: { readOnlyHint: true, untrustedContentHint: true },
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
        const protectedStockIds = snapshot.workspace.stock
          .filter((board) => board.locked)
          .map((board) => board.id);
        const protectedIds = new Set(protectedStockIds);
        // Human protection is fixed for these fresh plans. Only additional IDs
        // outside that set can change the effective protected+additional union.
        const firstAdditionalIds = new Set<string>();
        for (const id of plans[0].solution.excludedStockIds) {
          if (!protectedIds.has(id)) firstAdditionalIds.add(id);
        }
        const first = plans[0].solution.metrics;
        store.recordActivity(
          'webmcp',
          'compare_plans',
          `Compared ${plans.length} complete alternatives for revision ${snapshot.workspace.revision}.`,
        );
        const rows = plans.map((plan) => {
          const metrics = plan.solution.metrics;
          let additionalCount = 0;
          let sameConstraintsAsFirst = true;
          for (const id of plan.solution.excludedStockIds) {
            if (protectedIds.has(id)) continue;
            additionalCount++;
            if (!firstAdditionalIds.has(id)) sameConstraintsAsFirst = false;
          }
          sameConstraintsAsFirst &&= additionalCount === firstAdditionalIds.size;
          return {
            id: plan.id,
            objective: plan.solution.objective,
            reusedFromPlanId: plan.reusedFromPlanId,
            excludedStockIds: plan.solution.excludedStockIds,
            sameConstraintsAsFirst,
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
        });
        return {
          ok: true,
          revision: snapshot.workspace.revision,
          baselinePlanId: plans[0].id,
          protectedStockIds,
          sameConstraints: rows.every((row) => row.sameConstraintsAsFirst),
          plans: rows,
        };
      },
    },
    {
      name: 'stage_plan_for_review',
      title: 'Ask the human to review this exact plan',
      description:
        'Stage the exact COMPLETE FRESH plan at expectedRevision. Drafts reject with PENDING_MEASUREMENTS: finish/cancel them first. Returns awaiting_human_approval immediately, NOT approval. Human approval requires the site button; no tool can approve. Committed measurement changes invalidate review.',
      inputSchema: {
        type: 'object',
        properties: { planId: planIdSchema, expectedRevision: revisionSchema },
        required: ['planId', 'expectedRevision'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
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
            'Wait for HUMAN site review/approval; no tool can approve. Finish/cancel any new measurement drafts before approval. After approval, inspect_plan/export_cut_list confirms this exact released plan ID.',
        };
      },
    },
    {
      name: 'export_cut_list',
      title: 'Export the human-approved cut sheet',
      description:
        'Return CSV for the exact human-approved COMPLETE FRESH committed ID; reject unapproved/stale/partial plans. Include ALL part IDs/lengths/offsets, kerf and final remnants; quote/formula-escape human text. Pending drafts still allow this committed export. Planning document only: no cuts/inventory changes.',
      inputSchema: {
        type: 'object',
        properties: { planId: planIdSchema },
        required: ['planId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
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
  // Real native surfaces, not a polyfill: Chrome 149 uses navigator,
  // 150–151 expose both, and tested 152 uses document.modelContext.
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
          'Manual planning works here. Native tools need a supported WebMCP browser-agent host; see the setup guide for supported hosts/models, permissions and WebMCP-enabled Chrome.',
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
