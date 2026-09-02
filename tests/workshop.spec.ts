import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Objective, PlanMetrics, PlanRecord, Workspace } from '../src/types';

const TOOL_NAMES = [
  'get_workshop',
  'plan_cuts',
  'inspect_plan',
  'compare_plans',
  'stage_plan_for_review',
  'export_cut_list',
] as const;
type ToolName = (typeof TOOL_NAMES)[number];
interface RegisteredTool {
  name: string;
  inputSchema: string;
}
interface NativeSurface {
  registerTool?: unknown;
  getTools?: () => Promise<RegisteredTool[]>;
  executeTool?: (tool: RegisteredTool, input: string) => Promise<string>;
}
type NativeResult<T> =
  ({ ok: true } & T) | { ok: false; error: { code: string; message: string; details?: unknown } };
type DescribedPlan = PlanRecord & {
  currentRevision: number;
  fresh: boolean;
  approved: boolean;
  awaitingHumanApproval: boolean;
  canRequestReview: boolean;
  wasteMm: number;
};
interface WorkshopPayload {
  workspace: Workspace;
  units: string;
  totalRequiredParts: number;
  requiredPartsMm: number;
  availableStockMm: number;
  protectedStockIds: string[];
  plans: { id: string; fresh: boolean; approved: boolean; complete: boolean }[];
}
interface ComparisonPayload {
  revision: number;
  baselinePlanId: string;
  plans: {
    id: string;
    objective: Objective;
    metrics: PlanMetrics;
    wasteMm: number;
    provenOptimal: boolean;
    deltaFromFirst: {
      stockUsedMm: number;
      boardCount: number;
      wasteMm: number;
      reusableMm: number;
      utilizationPercentagePoints: number;
    };
  }[];
}
interface ExportPayload {
  planId: string;
  revision: number;
  mimeType: string;
  filename: string;
  csv: string;
}

const selectedLayout = (page: Page) => page.locator('#cutting-plan .cutting-plan[data-plan-id]');
const reviewDialog = (page: Page) => page.locator('dialog[aria-labelledby="review-heading"]');
const replacementDialog = (page: Page) =>
  page.locator('dialog[aria-labelledby="confirmation-heading"]');
const csvButton = (page: Page) =>
  page.getByRole('button', { name: 'Download approved CSV', exact: true });
const printButton = (page: Page) =>
  page.getByRole('button', { name: 'Print approved cut sheet', exact: true });
const nativeProject = (info: TestInfo) => info.project.name === 'native-webmcp';

async function discoverTools(page: Page) {
  return page.evaluate(async () => {
    const surfaces = [
      (document as Document & { modelContext?: NativeSurface }).modelContext,
      (navigator as Navigator & { modelContext?: NativeSurface }).modelContext,
    ];
    const native = surfaces.find(
      (api) => typeof api?.getTools === 'function' && typeof api.executeTool === 'function',
    );
    const tools = native?.getTools ? await native.getTools() : [];
    return {
      hasRegistration: surfaces.some((api) => typeof api?.registerTool === 'function'),
      hasClient: Boolean(native),
      tools: tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })),
    };
  });
}

async function expectBrowserMode(page: Page, native: boolean) {
  const state = page.locator('#browser-agent .native-state');
  if (native) {
    await expect(
      state,
      'Native Chrome must expose real WebMCP; check the installed Chrome version and CHROME_PATH, not a polyfill',
    ).toContainText('Native WebMCP ready');
    await expect(page.locator('#browser-agent .native-provider')).toContainText(
      '6 tools registered',
    );
    await expect
      .poll(async () => (await discoverTools(page)).tools.map((tool) => tool.name).sort(), {
        message: 'The enabled browser must discover all six actually registered Offcut tools',
      })
      .toEqual([...TOOL_NAMES].sort());
    const discovery = await discoverTools(page);
    expect(discovery.hasRegistration).toBe(true);
    expect(discovery.hasClient).toBe(true);
    for (const tool of discovery.tools) {
      expect(
        typeof tool.inputSchema,
        `${tool.name} must expose the native JSON-string schema`,
      ).toBe('string');
      expect(JSON.parse(tool.inputSchema)).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    }
  } else {
    await expect(state).toContainText('Manual mode');
    await expect(page.locator('#browser-agent .native-provider')).toContainText(
      '0 tools registered',
    );
    expect(
      await discoverTools(page),
      'Ordinary mode must not register or emulate native tools',
    ).toEqual({ hasRegistration: false, hasClient: false, tools: [] });
  }
}

async function invokeTool<T>(
  page: Page,
  name: ToolName,
  input: Record<string, unknown>,
): Promise<NativeResult<T>> {
  return page.evaluate(
    async ({ name, input }) => {
      const surfaces = [
        (document as Document & { modelContext?: NativeSurface }).modelContext,
        (navigator as Navigator & { modelContext?: NativeSurface }).modelContext,
      ];
      const native = surfaces.find(
        (api) => typeof api?.getTools === 'function' && typeof api.executeTool === 'function',
      );
      if (!native?.getTools || !native.executeTool)
        throw new Error('Real native getTools/executeTool is unavailable in this document.');
      // Discover immediately before execution and keep the real RegisteredTool in
      // the page. A serialized descriptor or an object from an earlier page is not
      // a native tool capability.
      const tools = await native.getTools();
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool)
        throw new Error(
          `Native tool ${name} is missing; discovered: ${tools.map((candidate) => candidate.name).join(', ')}`,
        );
      const raw = await native.executeTool(tool, JSON.stringify(input));
      if (typeof raw !== 'string')
        throw new Error(`${name} returned a non-string native result: ${String(raw)}`);
      let result: unknown;
      try {
        result = JSON.parse(raw);
      } catch {
        throw new Error(`${name} returned invalid JSON: ${raw}`);
      }
      if (
        result === null ||
        typeof result !== 'object' ||
        !('ok' in result) ||
        typeof result.ok !== 'boolean'
      ) {
        throw new Error(`${name} returned no structured success/error contract: ${raw}`);
      }
      return result as NativeResult<T>;
    },
    { name, input },
  );
}

async function successfulTool<T>(page: Page, name: ToolName, input: Record<string, unknown>) {
  const result = await invokeTool<T>(page, name, input);
  if (!result.ok)
    throw new Error(
      `${name} unexpectedly rejected ${JSON.stringify(input)}: ${JSON.stringify(result.error)}`,
    );
  return result;
}

async function expectToolError(
  page: Page,
  name: ToolName,
  input: Record<string, unknown>,
  code: string,
  message: RegExp,
  details?: Record<string, unknown>,
) {
  const result = await invokeTool<Record<string, unknown>>(page, name, input);
  expect(
    result,
    `${name}(${JSON.stringify(input)}) returned ${JSON.stringify(result)}`,
  ).toMatchObject({
    ok: false,
    error: { code, message: expect.stringMatching(message), ...(details ? { details } : {}) },
  });
}

async function commit(page: Page, id: string, value: string, key: 'Enter' | 'Tab' = 'Enter') {
  const field = page.locator(`#${id}`);
  await field.fill(value);
  await field.press(key);
  await expect(field).toHaveValue(value);
  await expect(field).not.toHaveAttribute('aria-invalid', 'true');
}

async function revisionShown(page: Page) {
  const text = await page.locator('.revision-badge').innerText();
  const match = /Revision\s+(\d+)/u.exec(text);
  if (!match) throw new Error(`No workspace revision in the visible badge: ${text}`);
  return Number(match[1]);
}

async function findHumanPlan(page: Page, objective: Objective = 'least_stock') {
  const layout = selectedLayout(page);
  const previousId = (await layout.count()) ? await layout.getAttribute('data-plan-id') : null;
  await page.locator('#planning-objective').selectOption(objective);
  await expect(page.locator('#find-cutting-plan')).toBeEnabled();
  await page.locator('#find-cutting-plan').click();
  await expect(layout).toHaveAttribute('data-plan-id', /^plan-/u);
  if (previousId) await expect(layout).not.toHaveAttribute('data-plan-id', previousId);
  await expect(page.locator('#find-cutting-plan')).toBeEnabled();
  const id = await layout.getAttribute('data-plan-id');
  if (!id) throw new Error('Human solve did not display an actual plan ID.');
  return id;
}

async function approveOpenReview(page: Page, planId: string) {
  const dialog = reviewDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.cutting-plan')).toHaveAttribute('data-plan-id', planId);
  const acknowledgement = dialog.locator('#review-acknowledgement');
  const approval = dialog.locator('#approve-cut-sheet');
  await expect(acknowledgement).not.toBeChecked();
  await expect(approval).toBeDisabled();
  await acknowledgement.check();
  await expect(approval).toBeEnabled();
  await approval.click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId('approved-print-sheet')).toHaveAttribute('data-plan-id', planId);
  await expect(csvButton(page)).toBeEnabled();
  await expect(printButton(page)).toBeEnabled();
}

async function approveHumanPlan(page: Page, planId: string) {
  await page.getByRole('button', { name: 'Review this plan', exact: true }).click();
  await approveOpenReview(page, planId);
}

function expectCompletePlan(
  plan: DescribedPlan,
  workspace: Workspace,
  additionalExclusions: string[] = [],
) {
  expect(plan).toMatchObject({
    basedOnRevision: workspace.revision,
    currentRevision: workspace.revision,
    fresh: true,
  });
  expect(plan.solution.complete).toBe(true);
  expect(plan.solution.unfulfilled).toEqual([]);
  expect([...plan.solution.excludedStockIds].sort()).toEqual([...additionalExclusions].sort());
  const untouched = new Set([
    ...workspace.stock.filter((board) => board.locked).map((board) => board.id),
    ...additionalExclusions,
  ]);
  const produced = new Map<string, number[]>();
  for (const layout of plan.solution.layouts) {
    expect(untouched.has(layout.stockId), `Protected/excluded ${layout.stockId} was opened`).toBe(
      false,
    );
    const board = workspace.stock.find((board) => board.id === layout.stockId);
    expect(board).toBeDefined();
    expect(layout.stockLengthMm).toBe(board?.lengthMm);
    let offset = 0;
    for (const cut of layout.cuts) {
      const requirement = workspace.requirements.find((part) => part.id === cut.requirementId);
      expect(requirement, `Unexpected produced part ${cut.requirementId}`).toBeDefined();
      expect(cut.lengthMm).toBe(requirement?.lengthMm);
      expect(cut.offsetMm).toBe(offset);
      offset += cut.lengthMm + workspace.settings.kerfMm;
      produced.set(cut.requirementId, [...(produced.get(cut.requirementId) ?? []), cut.instance]);
    }
    expect(layout.kerfMm).toBe(layout.cuts.length * workspace.settings.kerfMm);
    expect(offset + layout.remnantMm).toBe(layout.stockLengthMm);
    expect(layout.remnantMm).toBeGreaterThanOrEqual(0);
    expect(layout.remnantKind).toBe(
      layout.remnantMm === 0
        ? 'none'
        : layout.remnantMm >= workspace.settings.minReusableMm
          ? 'reusable'
          : 'scrap',
    );
  }
  for (const part of workspace.requirements) {
    expect(
      (produced.get(part.id) ?? []).sort((a, b) => a - b),
      `${part.label} must appear exactly once per requested instance`,
    ).toEqual(Array.from({ length: part.quantity }, (_, index) => index + 1));
  }
  const metrics = plan.solution.metrics;
  expect(metrics.stockUsedMm).toBe(
    plan.solution.layouts.reduce((total, layout) => total + layout.stockLengthMm, 0),
  );
  expect(metrics.partsMm).toBe(
    workspace.requirements.reduce((total, part) => total + part.lengthMm * part.quantity, 0),
  );
  expect(metrics.kerfMm).toBe(
    workspace.requirements.reduce((total, part) => total + part.quantity, 0) *
      workspace.settings.kerfMm,
  );
  expect(metrics.stockUsedMm).toBe(
    metrics.partsMm + metrics.kerfMm + metrics.reusableMm + metrics.scrapMm,
  );
  expect(metrics.boardCount).toBe(plan.solution.layouts.length);
  expect(plan.wasteMm).toBe(metrics.kerfMm + metrics.scrapMm);
}

const CSV_HEADERS = [
  'Project',
  'Material (same cross-section)',
  'Plan ID',
  'Workspace revision',
  'Board ID',
  'Board label',
  'Usable stock length (mm)',
  'Cut order',
  'Part',
  'Part instance',
  'Part length (mm)',
  'Start from usable edge (mm)',
  'End before kerf (mm)',
  'Kerf after this part (mm)',
  'Final remnant (mm)',
  'Remnant class',
];

function csvRecords(csv: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && csv[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += character;
  }
  expect(quoted, 'Downloaded CSV has an unterminated quoted cell').toBe(false);
  if (row.length || cell.length) rows.push([...row, cell]);
  const [headers, ...values] = rows;
  expect(headers).toEqual(CSV_HEADERS);
  return values.map((value) => {
    expect(value).toHaveLength(headers.length);
    return Object.fromEntries(headers.map((header, index) => [header, value[index]]));
  });
}

async function downloadCsv(page: Page, info: TestInfo) {
  const [download] = await Promise.all([page.waitForEvent('download'), csvButton(page).click()]);
  const path = info.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  expect(await download.failure()).toBeNull();
  const csv = await readFile(path, 'utf8');
  await info.attach('approved-cut-sheet.csv', { path, contentType: 'text/csv' });
  return { csv, filename: download.suggestedFilename(), records: csvRecords(csv) };
}

function expectCsvPlan(records: Record<string, string>[], plan: PlanRecord, workspace: Workspace) {
  const expected = plan.solution.layouts.flatMap((layout) =>
    layout.cuts.map((cut, index) => ({
      Project: workspace.title,
      'Material (same cross-section)': workspace.material,
      'Plan ID': plan.id,
      'Workspace revision': String(workspace.revision),
      'Board ID': layout.stockId,
      'Board label': layout.stockLabel,
      'Usable stock length (mm)': String(layout.stockLengthMm),
      'Cut order': String(index + 1),
      Part: cut.label,
      'Part instance': String(cut.instance),
      'Part length (mm)': String(cut.lengthMm),
      'Start from usable edge (mm)': String(cut.offsetMm),
      'End before kerf (mm)': String(cut.offsetMm + cut.lengthMm),
      'Kerf after this part (mm)': String(workspace.settings.kerfMm),
      'Final remnant (mm)': index === layout.cuts.length - 1 ? String(layout.remnantMm) : '',
      'Remnant class': index === layout.cuts.length - 1 ? layout.remnantKind : '',
    })),
  );
  expect(records).toEqual(expected);
}

async function printApproved(
  page: Page,
  info: TestInfo,
  approvedId: string,
  selectedDraftId: string,
  title: string,
) {
  await printButton(page).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  // Exercise the actual print-media surface and Chromium's PDF renderer rather
  // than depending on a platform printer dialog or replacing window.print.
  await page.emulateMedia({ media: 'print' });
  try {
    const sheet = page.getByTestId('approved-print-sheet');
    await expect(page.locator('.screen-app')).not.toBeVisible();
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('data-plan-id', approvedId);
    await expect(sheet.locator('.cutting-plan')).toHaveAttribute('data-plan-id', approvedId);
    await expect(sheet.getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(sheet).toContainText(approvedId);
    await expect(sheet).not.toContainText(selectedDraftId);
    const path = info.outputPath('approved-cut-sheet.pdf');
    const pdf = await page.pdf({
      path,
      format: 'A4',
      preferCSSPageSize: false,
      printBackground: true,
    });
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.subarray(-1024).toString('latin1')).toContain('%%EOF');
    await info.attach('approved-cut-sheet.pdf', { path, contentType: 'application/pdf' });
  } finally {
    await page.emulateMedia({ media: 'screen' });
  }
}

async function expectBlockedPrint(
  page: Page,
  heading: 'Finish your measurement edits first' | 'No approved cut sheet',
) {
  await page.emulateMedia({ media: 'print' });
  try {
    const sheet = page.getByTestId('approved-print-sheet');
    await expect(page.locator('.screen-app')).not.toBeVisible();
    await expect(sheet).toBeVisible();
    await expect(sheet).not.toHaveAttribute('data-plan-id');
    await expect(sheet.getByRole('heading', { level: 1 })).toHaveText(heading);
    await expect(sheet.locator('.cutting-plan')).toHaveCount(0);
  } finally {
    await page.emulateMedia({ media: 'screen' });
  }
}

async function expectEditingGates(page: Page) {
  await expect(page.locator('#find-cutting-plan')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Review this plan', exact: true })).toBeDisabled();
  await expect(csvButton(page)).toBeDisabled();
  await expect(printButton(page)).toBeDisabled();
}

async function clearMeasurements(page: Page) {
  await page.getByRole('button', { name: 'Clear measurements', exact: true }).click();
  await expect(replacementDialog(page)).toBeVisible();
  await replacementDialog(page)
    .getByRole('button', { name: 'Confirm clear measurements', exact: true })
    .click();
  await expect(replacementDialog(page)).not.toBeVisible();
}

async function addPart(page: Page, label: string, length: number, quantity: number) {
  await page.getByRole('button', { name: 'Add part', exact: true }).click();
  const form = page.getByRole('form', { name: 'Add cut requirement', exact: true });
  await form.getByLabel('Part label', { exact: true }).fill(label);
  await form.getByLabel('Finished length (mm)', { exact: true }).fill(String(length));
  await form.getByLabel('Part quantity', { exact: true }).fill(String(quantity));
  await form.getByRole('button', { name: 'Add cut requirement', exact: true }).click();
  await expect(form).not.toBeVisible();
}

async function addStock(page: Page, label: string, length: number, protectedStock = false) {
  await page.getByRole('button', { name: 'Add stock', exact: true }).click();
  const form = page.getByRole('form', { name: 'Add stock measurements', exact: true });
  await form.getByLabel('Stock label', { exact: true }).fill(label);
  await form.getByLabel('Usable length (mm)', { exact: true }).fill(String(length));
  await form
    .getByLabel('Protect this length from planning', { exact: true })
    .setChecked(protectedStock);
  await form.getByRole('button', { name: 'Add stock to inventory', exact: true }).click();
  await expect(form).not.toBeVisible();
}

async function humanPosition(page: Page) {
  // Synchronize with a rendered browser frame, not an elapsed-time guess.
  return page.evaluate(
    () =>
      new Promise<{ id: string; value: string; selection: number | null; x: number; y: number }>(
        (resolve) =>
          requestAnimationFrame(() => {
            const active = document.activeElement;
            resolve({
              id: active?.id ?? '',
              value: active instanceof HTMLInputElement ? active.value : '',
              selection: active instanceof HTMLInputElement ? active.selectionStart : null,
              x: window.scrollX,
              y: window.scrollY,
            });
          }),
      ),
  );
}

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    return {
      viewport,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      offenders: Array.from(document.querySelectorAll('body *'))
        .flatMap((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && (rect.right > viewport + 1 || rect.left < -1)
            ? [
                {
                  tag: element.tagName,
                  id: element.id,
                  class: element.getAttribute('class'),
                  left: rect.left,
                  right: rect.right,
                },
              ]
            : [];
        })
        .slice(0, 12),
    };
  });
  expect(dimensions.documentWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.viewport + 1,
  );
  expect(dimensions.bodyWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.viewport + 1,
  );
}

test.beforeEach(async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('#project-title')).toBeVisible();
  await expect(selectedLayout(page)).toHaveCount(0);
  await expect(csvButton(page)).toBeDisabled();
  await expect(page.getByTestId('approved-print-sheet')).not.toHaveAttribute('data-plan-id');
  await expectBrowserMode(page, nativeProject(info));
});

test(
  'Native tools preserve human stock protection through objective comparison, review and approved-only release',
  { tag: '@native' },
  async ({ page }, info) => {
    const initial = await successfulTool<WorkshopPayload>(page, 'get_workshop', {});
    const board = initial.workspace.stock.find((board) => board.id === 'A-01');
    if (!board) throw new Error('The illustrative fixture must expose its stable A-01 board.');
    await page
      .getByRole('button', { name: `Protect stock ${board.label} (${board.id})`, exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: `Unprotect stock ${board.label} (${board.id})`,
        exact: true,
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    const workshop = await successfulTool<WorkshopPayload>(page, 'get_workshop', {});
    expect(workshop.units).toBe('mm');
    expect(workshop.protectedStockIds).toEqual([board.id]);
    expect(workshop.workspace.revision).toBeGreaterThan(initial.workspace.revision);
    const extra = workshop.workspace.stock
      .filter((board) => board.kind === 'offcut' && !board.locked)
      .at(-1);
    if (!extra) throw new Error('The illustrative fixture needs an additional offcut exclusion.');
    const objectives: Objective[] = ['least_stock', 'fewest_boards', 'least_waste'];
    const plans: DescribedPlan[] = [];
    for (const objective of objectives) {
      const result = await successfulTool<{ plan: DescribedPlan }>(page, 'plan_cuts', {
        expectedRevision: workshop.workspace.revision,
        objective,
        excludedStockIds: [extra.id],
      });
      expect(result.plan).toMatchObject({
        actor: 'webmcp',
        approved: false,
        awaitingHumanApproval: false,
        canRequestReview: true,
        solution: { objective },
      });
      expectCompletePlan(result.plan, workshop.workspace, [extra.id]);
      await expect(selectedLayout(page)).toHaveAttribute('data-plan-id', result.plan.id);
      await expect(csvButton(page)).toBeDisabled();
      plans.push(result.plan);
    }
    const inspected = await successfulTool<{ plan: DescribedPlan }>(page, 'inspect_plan', {
      planId: plans[0].id,
    });
    expect(inspected.plan).toEqual(plans[0]);
    const comparison = await successfulTool<ComparisonPayload>(page, 'compare_plans', {
      planIds: plans.map((plan) => plan.id),
    });
    expect(comparison.revision).toBe(workshop.workspace.revision);
    expect(comparison.baselinePlanId).toBe(plans[0].id);
    expect(comparison.plans).toHaveLength(3);
    comparison.plans.forEach((entry, index) => {
      const plan = plans[index],
        first = plans[0].solution.metrics,
        metrics = plan.solution.metrics;
      expect(entry).toEqual({
        id: plan.id,
        objective: objectives[index],
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
      });
    });
    for (const plan of plans) {
      expect(plans[0].solution.metrics.stockUsedMm).toBeLessThanOrEqual(
        plan.solution.metrics.stockUsedMm,
      );
      expect(plans[1].solution.metrics.boardCount).toBeLessThanOrEqual(
        plan.solution.metrics.boardCount,
      );
      expect(plans[2].wasteMm).toBeLessThanOrEqual(plan.wasteMm);
      await expect(
        page.getByRole('button', { name: new RegExp(`^View .+ plan ${plan.id}$`, 'u') }),
      ).toBeVisible();
    }
    await expectToolError(
      page,
      'export_cut_list',
      { planId: plans[0].id },
      'APPROVAL_REQUIRED',
      /human.*review.*approve/iu,
    );
    const staged = await successfulTool<{ status: string; plan: DescribedPlan }>(
      page,
      'stage_plan_for_review',
      { planId: plans[0].id, expectedRevision: workshop.workspace.revision },
    );
    expect(staged).toMatchObject({
      status: 'awaiting_human_approval',
      plan: { id: plans[0].id, approved: false, awaitingHumanApproval: true },
    });
    await expectToolError(
      page,
      'export_cut_list',
      { planId: plans[0].id },
      'APPROVAL_REQUIRED',
      /human.*approve/iu,
    );
    await approveOpenReview(page, plans[0].id);
    const approved = await successfulTool<{ plan: DescribedPlan }>(page, 'inspect_plan', {
      planId: plans[0].id,
    });
    expect(approved.plan).toMatchObject({
      approved: true,
      awaitingHumanApproval: false,
      fresh: true,
    });
    const exported = await successfulTool<ExportPayload>(page, 'export_cut_list', {
      planId: plans[0].id,
    });
    expect(exported).toMatchObject({
      planId: plans[0].id,
      revision: workshop.workspace.revision,
      mimeType: 'text/csv;charset=utf-8',
    });
    // Empty agent exclusions cannot remove the human's protection. This new draft
    // becomes selected but must never replace the approved CSV/print content.
    const draft = await successfulTool<{ plan: DescribedPlan }>(page, 'plan_cuts', {
      expectedRevision: workshop.workspace.revision,
      objective: 'least_waste',
      excludedStockIds: [],
    });
    expectCompletePlan(draft.plan, workshop.workspace);
    expect(draft.plan.approved).toBe(false);
    expect(draft.plan.id).not.toBe(plans[0].id);
    await expect(selectedLayout(page)).toHaveAttribute('data-plan-id', draft.plan.id);
    await expectToolError(
      page,
      'export_cut_list',
      { planId: draft.plan.id },
      'APPROVAL_REQUIRED',
      /human.*approve/iu,
    );
    const downloaded = await downloadCsv(page, info);
    expect(downloaded.filename).toBe(exported.filename);
    expect(downloaded.csv).toBe(exported.csv);
    expectCsvPlan(downloaded.records, plans[0], workshop.workspace);
    await printApproved(page, info, plans[0].id, draft.plan.id, workshop.workspace.title);
    expect((await successfulTool<WorkshopPayload>(page, 'get_workshop', {})).workspace).toEqual(
      workshop.workspace,
    );
    await info.attach('native-contract-results.json', {
      body: JSON.stringify(
        { workshop, plans, comparison, staged, approved, draft, exported },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    await page.getByRole('button', { name: 'Revoke approval', exact: true }).click();
    await expect(csvButton(page)).toBeDisabled();
    await expect(printButton(page)).toBeDisabled();
    await expectToolError(
      page,
      'export_cut_list',
      { planId: plans[0].id },
      'APPROVAL_REQUIRED',
      /human.*approve/iu,
    );
    await expectBlockedPrint(page, 'No approved cut sheet');
  },
);

test(
  'Only Enter/blur commits reach native tools; committed revisions invalidate approval, staging, comparison and export',
  { tag: '@native' },
  async ({ page }) => {
    const initial = await successfulTool<WorkshopPayload>(page, 'get_workshop', {});
    const kerf = page.locator('#kerf-mm');
    await kerf.fill('4');
    await expect(page.locator('#find-cutting-plan')).toBeDisabled();
    expect((await successfulTool<WorkshopPayload>(page, 'get_workshop', {})).workspace).toEqual(
      initial.workspace,
    );
    await kerf.press('Enter');
    const entered = await successfulTool<WorkshopPayload>(page, 'get_workshop', {});
    expect(entered.workspace.settings.kerfMm).toBe(4);
    expect(entered.workspace.revision).toBeGreaterThan(initial.workspace.revision);
    await commit(page, 'reusable-mm', '500', 'Tab');
    const blurred = await successfulTool<WorkshopPayload>(page, 'get_workshop', {});
    expect(blurred.workspace.settings.minReusableMm).toBe(500);
    expect(blurred.workspace.revision).toBeGreaterThan(entered.workspace.revision);
    const stock = page.locator('#stock-length-A-01');
    const savedLength = await stock.inputValue();
    await stock.fill('2999');
    expect((await successfulTool<WorkshopPayload>(page, 'get_workshop', {})).workspace).toEqual(
      blurred.workspace,
    );
    await stock.press('Escape');
    await expect(stock).toHaveValue(savedLength);
    expect((await successfulTool<WorkshopPayload>(page, 'get_workshop', {})).workspace).toEqual(
      blurred.workspace,
    );
    await commit(page, 'stock-length-A-01', '2900');
    await commit(page, 'part-length-shelf', '725');
    await commit(page, 'part-quantity-shelf', '3', 'Tab');
    await commit(page, 'project-title', 'Revision-bound workshop');
    await commit(page, 'project-material', 'Oak, 20 × 100 mm', 'Tab');
    const recorded = await successfulTool<WorkshopPayload>(page, 'get_workshop', {});
    expect(recorded.workspace).toMatchObject({
      title: 'Revision-bound workshop',
      material: 'Oak, 20 × 100 mm',
      settings: { kerfMm: 4, minReusableMm: 500 },
    });
    expect(recorded.workspace.stock.find((board) => board.id === 'A-01')?.lengthMm).toBe(2900);
    expect(recorded.workspace.requirements.find((part) => part.id === 'shelf')).toMatchObject({
      lengthMm: 725,
      quantity: 3,
    });
    const proposed = await successfulTool<{ plan: DescribedPlan }>(page, 'plan_cuts', {
      expectedRevision: recorded.workspace.revision,
      objective: 'least_stock',
    });
    expectCompletePlan(proposed.plan, recorded.workspace);
    await expect(selectedLayout(page)).toHaveAttribute('data-plan-id', proposed.plan.id);
    await approveHumanPlan(page, proposed.plan.id);
    await commit(page, 'kerf-mm', '5');
    const current = await successfulTool<WorkshopPayload>(page, 'get_workshop', {});
    expect(current.workspace.revision).toBeGreaterThan(recorded.workspace.revision);
    await expect(csvButton(page)).toBeDisabled();
    await expect(printButton(page)).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Review this plan', exact: true }),
    ).toBeDisabled();
    await expect(selectedLayout(page)).toContainText('This plan is out of date.');
    const stale = await successfulTool<{ plan: DescribedPlan }>(page, 'inspect_plan', {
      planId: proposed.plan.id,
    });
    expect(stale.plan).toMatchObject({
      fresh: false,
      approved: false,
      awaitingHumanApproval: false,
      canRequestReview: false,
      basedOnRevision: recorded.workspace.revision,
      currentRevision: current.workspace.revision,
    });
    const revisionDetails = {
      expectedRevision: recorded.workspace.revision,
      currentRevision: current.workspace.revision,
    };
    await expectToolError(
      page,
      'plan_cuts',
      { expectedRevision: recorded.workspace.revision, objective: 'least_stock' },
      'REVISION_CONFLICT',
      /revision.*no longer current/iu,
      revisionDetails,
    );
    await expectToolError(
      page,
      'stage_plan_for_review',
      { expectedRevision: recorded.workspace.revision, planId: proposed.plan.id },
      'REVISION_CONFLICT',
      /revision.*no longer current/iu,
      revisionDetails,
    );
    await expectToolError(
      page,
      'stage_plan_for_review',
      { expectedRevision: current.workspace.revision, planId: proposed.plan.id },
      'STALE_PLAN',
      /revision/iu,
    );
    await expectToolError(
      page,
      'export_cut_list',
      { planId: proposed.plan.id },
      'STALE_PLAN',
      /measurements changed/iu,
    );
    const fresh = await successfulTool<{ plan: DescribedPlan }>(page, 'plan_cuts', {
      expectedRevision: current.workspace.revision,
      objective: 'least_stock',
    });
    await expectToolError(
      page,
      'compare_plans',
      { planIds: [proposed.plan.id, fresh.plan.id] },
      'STALE_PLAN',
      /fresh plans/iu,
    );
    await expectToolError(
      page,
      'export_cut_list',
      { planId: fresh.plan.id },
      'APPROVAL_REQUIRED',
      /human.*approve/iu,
    );
    await expect(reviewDialog(page)).not.toBeVisible();
    await expectBlockedPrint(page, 'No approved cut sheet');
  },
);

test(
  'Native proposals leave focused human drafts and scroll untouched, and unfinished rows cannot receive human approval',
  { tag: '@native' },
  async ({ page }) => {
    const initial = await successfulTool<WorkshopPayload>(page, 'get_workshop', {});
    await findHumanPlan(page);
    await expect(selectedLayout(page).locator('.cutting-layouts')).toBeFocused();
    for (const scenario of [
      { width: 1365, height: 900, id: 'kerf-mm', draft: '4', objective: 'least_stock' as const },
      {
        width: 390,
        height: 844,
        id: 'stock-length-A-01',
        draft: '2800',
        objective: 'least_waste' as const,
      },
    ]) {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      const field = page.locator(`#${scenario.id}`);
      const saved = await field.inputValue();
      await field.fill(scenario.draft);
      await expect(field).toBeFocused();
      await expect(page.locator('#find-cutting-plan')).toBeDisabled();
      const before = await humanPosition(page);
      expect((await successfulTool<WorkshopPayload>(page, 'get_workshop', {})).workspace).toEqual(
        initial.workspace,
      );
      const proposal = await successfulTool<{ plan: DescribedPlan }>(page, 'plan_cuts', {
        expectedRevision: initial.workspace.revision,
        objective: scenario.objective,
      });
      expectCompletePlan(proposal.plan, initial.workspace);
      await expect(selectedLayout(page)).toHaveAttribute('data-plan-id', proposal.plan.id);
      expect(
        await humanPosition(page),
        'Native planning must not navigate away from an active human edit',
      ).toEqual(before);
      await expect(field).toBeFocused();
      await field.press('Escape');
      await expect(field).toHaveValue(saved);
      await expect(page.locator('#find-cutting-plan')).toBeEnabled();
      if (scenario.width === 390) await expectNoPageOverflow(page);
    }
    await page.getByRole('button', { name: 'Add part', exact: true }).click();
    const form = page.getByRole('form', { name: 'Add cut requirement', exact: true });
    const pending = form.getByLabel('Part label', { exact: true });
    await pending.fill('Not yet recorded');
    const before = await humanPosition(page);
    const proposal = await successfulTool<{ plan: DescribedPlan }>(page, 'plan_cuts', {
      expectedRevision: initial.workspace.revision,
      objective: 'least_stock',
    });
    await expect(selectedLayout(page)).toHaveAttribute('data-plan-id', proposal.plan.id);
    expect(await humanPosition(page)).toEqual(before);
    await expect(pending).toBeFocused();
    await expectEditingGates(page);
    await successfulTool(page, 'stage_plan_for_review', {
      expectedRevision: initial.workspace.revision,
      planId: proposal.plan.id,
    });
    const dialog = reviewDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.cutting-plan')).toHaveAttribute('data-plan-id', proposal.plan.id);
    await expect(dialog).toContainText('Unfinished measurement edits are not in this proposal.');
    await expect(dialog.locator('#review-acknowledgement')).toBeDisabled();
    await expect(dialog.locator('#approve-cut-sheet')).toBeDisabled();
    await expectToolError(
      page,
      'export_cut_list',
      { planId: proposal.plan.id },
      'APPROVAL_REQUIRED',
      /human.*approve/iu,
    );
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(pending).toBeFocused();
    await expect(page.locator('#find-cutting-plan')).toBeDisabled();
    await form.getByRole('button', { name: 'Cancel adding part', exact: true }).click();
    await expect(form).not.toBeVisible();
    await expect(page.locator('#find-cutting-plan')).toBeEnabled();
    expect((await successfulTool<WorkshopPayload>(page, 'get_workshop', {})).workspace).toEqual(
      initial.workspace,
    );
    const inspected = await successfulTool<{ plan: DescribedPlan }>(page, 'inspect_plan', {
      planId: proposal.plan.id,
    });
    expect(inspected.plan).toMatchObject({ approved: false, awaitingHumanApproval: false });
  },
);

test(
  'Ordinary Chrome completes manual planning and real CSV/PDF release, persisting measurements but never page-session approval',
  { tag: '@manual' },
  async ({ page }, info) => {
    const measurements = {
      'project-title': 'Manual shelf "batch", 02',
      'project-material': 'Oak · 20 × 100 mm · usable lengths',
      'stock-length-A-01': '2800',
      'part-length-shelf': '715',
      'part-quantity-shelf': '3',
      'kerf-mm': '4',
      'reusable-mm': '350',
    };
    for (const [id, value] of Object.entries(measurements)) await commit(page, id, value);
    await page
      .getByRole('button', { name: 'Protect stock Long board (A-01)', exact: true })
      .click();
    const partCount = await page
      .locator('input[id^="part-quantity-"]')
      .evaluateAll((fields) =>
        fields.reduce((total, field) => total + Number((field as HTMLInputElement).value), 0),
      );
    const shelfLabel = await page.locator('#part-label-shelf').inputValue();
    const revision = await revisionShown(page);
    const approvedId = await findHumanPlan(page);
    await expect(selectedLayout(page)).toContainText(`${partCount} / ${partCount} parts planned`);
    await approveHumanPlan(page, approvedId);
    const draftId = await findHumanPlan(page, 'least_waste');
    expect(draftId).not.toBe(approvedId);
    await expect(
      page.getByRole('button', { name: new RegExp(`^View .+ plan ${approvedId}$`, 'u') }),
    ).toHaveAttribute('aria-pressed', 'false');
    await expect(
      page.getByRole('button', { name: new RegExp(`^View .+ plan ${draftId}$`, 'u') }),
    ).toHaveAttribute('aria-pressed', 'true');
    const downloaded = await downloadCsv(page, info);
    expect(downloaded.filename).toMatch(new RegExp(`-r${revision}\\.csv$`, 'u'));
    expect(downloaded.records).toHaveLength(partCount);
    for (const row of downloaded.records) {
      expect(row).toMatchObject({
        Project: measurements['project-title'],
        'Material (same cross-section)': measurements['project-material'],
        'Plan ID': approvedId,
        'Workspace revision': String(revision),
        'Kerf after this part (mm)': '4',
      });
      expect(row['Board ID']).not.toBe('A-01');
    }
    const shelves = downloaded.records.filter((row) => row.Part === shelfLabel);
    expect(shelves).toHaveLength(3);
    for (const row of shelves) expect(row['Part length (mm)']).toBe('715');
    await printApproved(page, info, approvedId, draftId, measurements['project-title']);
    await page.reload();
    await expectBrowserMode(page, false);
    for (const [id, value] of Object.entries(measurements))
      await expect(page.locator(`#${id}`)).toHaveValue(value);
    await expect(
      page.getByRole('button', { name: 'Unprotect stock Long board (A-01)', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(selectedLayout(page)).toHaveCount(0);
    await expect(reviewDialog(page)).not.toBeVisible();
    await expect(csvButton(page)).toBeDisabled();
    await expect(printButton(page)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Revoke approval', exact: true })).toHaveCount(0);
    await expectBlockedPrint(page, 'No approved cut sheet');
    await expect(page.locator('#find-cutting-plan')).toBeEnabled();
  },
);

test(
  'Unfinished fields, invalid numbers and pending add forms block solving and release until saved or cancelled',
  { tag: '@manual' },
  async ({ page }) => {
    const approvedId = await findHumanPlan(page);
    await approveHumanPlan(page, approvedId);
    const kerf = page.locator('#kerf-mm');
    const savedKerf = await kerf.inputValue();
    await kerf.fill('4');
    await expectEditingGates(page);
    await kerf.press('Escape');
    await expect(kerf).toHaveValue(savedKerf);
    await expect(page.getByTestId('approved-print-sheet')).toHaveAttribute(
      'data-plan-id',
      approvedId,
    );
    await expect(csvButton(page)).toBeEnabled();
    for (const invalid of [
      { id: 'kerf-mm', value: '3.5', error: /whole number.*millimetres/iu },
      { id: 'reusable-mm', value: '-1', error: /whole number.*millimetres/iu },
      { id: 'stock-length-A-01', value: '', error: /whole number.*millimetres/iu },
      { id: 'part-length-shelf', value: '0', error: /between 1 and 100,000/iu },
      { id: 'part-quantity-shelf', value: '0', error: /between 1 and 40/iu },
    ]) {
      const field = page.locator(`#${invalid.id}`);
      const saved = await field.inputValue();
      await field.fill(invalid.value);
      await field.press('Enter');
      await expect(field).toHaveValue(invalid.value);
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator(`#${invalid.id}-error`)).toContainText(invalid.error);
      await expectEditingGates(page);
      await expectBlockedPrint(page, 'Finish your measurement edits first');
      await field.press('Escape');
      await expect(field).toHaveValue(saved);
      await expect(field).not.toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#find-cutting-plan')).toBeEnabled();
      await expect(csvButton(page)).toBeEnabled();
      await expect(printButton(page)).toBeEnabled();
      await expect(page.getByTestId('approved-print-sheet')).toHaveAttribute(
        'data-plan-id',
        approvedId,
      );
    }
    const stockAdd = page.getByRole('button', { name: 'Add stock', exact: true });
    await stockAdd.click();
    const stockForm = page.getByRole('form', { name: 'Add stock measurements', exact: true });
    await stockForm.getByLabel('Stock label', { exact: true }).fill('A pending usable board');
    await stockForm.getByLabel('Usable length (mm)', { exact: true }).fill('2400');
    await expectEditingGates(page);
    await expectBlockedPrint(page, 'Finish your measurement edits first');
    await stockForm.getByRole('button', { name: 'Cancel adding stock', exact: true }).click();
    await expect(stockForm).not.toBeVisible();
    await expect(stockAdd).toBeFocused();
    await expect(csvButton(page)).toBeEnabled();
    const partAdd = page.getByRole('button', { name: 'Add part', exact: true });
    await partAdd.click();
    const partForm = page.getByRole('form', { name: 'Add cut requirement', exact: true });
    await partForm.getByLabel('Part label', { exact: true }).fill('An unfinished part');
    await partForm.getByLabel('Finished length (mm)', { exact: true }).fill('12.5');
    await partForm.getByRole('button', { name: 'Add cut requirement', exact: true }).click();
    await expect(partForm.getByRole('alert')).toContainText(/whole number.*millimetres/iu);
    await expectEditingGates(page);
    await partForm.getByRole('button', { name: 'Cancel adding part', exact: true }).click();
    await expect(partForm).not.toBeVisible();
    await expect(partAdd).toBeFocused();
    await expect(csvButton(page)).toBeEnabled();
    const beforePrintRevision = await revisionShown(page);
    await kerf.fill('4');
    await expectEditingGates(page);
    // Print CSS hides the focused field, causing its normal blur commit.
    // A valid changed measurement invalidates approval, never releases old cuts.
    await expectBlockedPrint(page, 'No approved cut sheet');
    await expect(kerf).toHaveValue('4');
    expect(await revisionShown(page)).toBe(beforePrintRevision + 1);
    await expect(page.locator('#find-cutting-plan')).toBeEnabled();
    await expect(csvButton(page)).toBeDisabled();
    await expect(printButton(page)).toBeDisabled();
    await expectBlockedPrint(page, 'No approved cut sheet');
  },
);

test(
  'Replacing measurements requires explicit confirmation and discards proposals, approval and unfinished rows',
  { tag: '@manual' },
  async ({ page }) => {
    const originalTitle = await page.locator('#project-title').inputValue();
    const originalLength = await page.locator('#stock-length-A-01').inputValue();
    const originalKerf = await page.locator('#kerf-mm').inputValue();
    await commit(page, 'project-title', 'Keep these measurements');
    await commit(page, 'stock-length-A-01', '2800');
    await commit(page, 'kerf-mm', '6');
    await page
      .getByRole('button', { name: 'Protect stock Long board (A-01)', exact: true })
      .click();
    const approvedId = await findHumanPlan(page);
    await approveHumanPlan(page, approvedId);
    await findHumanPlan(page, 'least_waste');
    const revision = await revisionShown(page);
    const load = page.getByRole('button', { name: 'Load illustrative sample', exact: true });
    const clear = page.getByRole('button', { name: 'Clear measurements', exact: true });
    const dialog = replacementDialog(page);
    await load.click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Keep my measurements', exact: true }),
    ).toBeFocused();
    await expect(page.locator('#project-title')).toHaveValue('Keep these measurements');
    await expect(page.getByTestId('approved-print-sheet')).toHaveAttribute(
      'data-plan-id',
      approvedId,
    );
    await dialog.getByRole('button', { name: 'Keep my measurements', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(load).toBeFocused();
    expect(await revisionShown(page)).toBe(revision);
    await clear.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(clear).toBeFocused();
    await expect(page.locator('#kerf-mm')).toHaveValue('6');
    await expect(page.getByTestId('approved-print-sheet')).toHaveAttribute(
      'data-plan-id',
      approvedId,
    );
    expect(await revisionShown(page)).toBe(revision);
    await load.click();
    await dialog
      .getByRole('button', { name: 'Confirm load illustrative sample', exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('#project-title')).toHaveValue(originalTitle);
    await expect(page.locator('#stock-length-A-01')).toHaveValue(originalLength);
    await expect(page.locator('#kerf-mm')).toHaveValue(originalKerf);
    await expect(
      page.getByRole('button', { name: 'Protect stock Long board (A-01)', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    await expect(selectedLayout(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^View .+ plan plan-/u })).toHaveCount(0);
    await expect(csvButton(page)).toBeDisabled();
    await expect(printButton(page)).toBeDisabled();
    const resetRevision = await revisionShown(page);
    expect(resetRevision).toBeGreaterThan(revision);
    await page.locator('#kerf-mm').fill('3.5');
    await page.locator('#kerf-mm').press('Enter');
    await page.getByRole('button', { name: 'Add stock', exact: true }).click();
    await expect(
      page.getByRole('form', { name: 'Add stock measurements', exact: true }),
    ).toBeVisible();
    await clearMeasurements(page);
    expect(await revisionShown(page)).toBeGreaterThan(resetRevision);
    await expect(page.locator('input[id^="stock-length-"]')).toHaveCount(0);
    await expect(page.locator('input[id^="part-length-"]')).toHaveCount(0);
    await expect(
      page.getByRole('form', { name: 'Add stock measurements', exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('#kerf-mm')).toHaveValue(originalKerf);
    await expect(page.locator('#kerf-mm')).not.toHaveAttribute('aria-invalid', 'true');
    await expect(selectedLayout(page)).toHaveCount(0);
    await expect(reviewDialog(page)).not.toBeVisible();
    await expect(page.locator('#find-cutting-plan')).toBeDisabled();
    await expectBlockedPrint(page, 'No approved cut sheet');
  },
);

test(
  'Empty and insufficient stock remain explicit, non-releasable proposals until the human supplies allowed stock',
  { tag: ['@native', '@manual'] },
  async ({ page }, info) => {
    await clearMeasurements(page);
    await commit(page, 'kerf-mm', '3');
    await commit(page, 'reusable-mm', '100');
    await expect(page.locator('#find-cutting-plan')).toBeDisabled();
    await expect(page.locator('#cutting-plan')).toContainText('Add at least one part');
    if (nativeProject(info)) {
      const empty = await successfulTool<WorkshopPayload>(page, 'get_workshop', {});
      expect(empty.workspace.stock).toEqual([]);
      expect(empty.workspace.requirements).toEqual([]);
      await expectToolError(
        page,
        'plan_cuts',
        { expectedRevision: empty.workspace.revision, objective: 'least_stock' },
        'NO_REQUIREMENTS',
        /add at least one required part/iu,
      );
    }
    await addPart(page, 'One-metre shelf', 1000, 2);
    await expect(page.locator('#cutting-plan')).toContainText('There is no stock yet.');
    const emptyStockId = await findHumanPlan(page);
    await expect(selectedLayout(page)).toContainText('0 / 2 parts · incomplete');
    await expect(
      selectedLayout(page).getByRole('region', {
        name: 'Unfulfilled cut requirements',
        exact: true,
      }),
    ).toContainText('2 × One-metre shelf');
    await expect(
      page.getByRole('button', { name: 'Review this plan', exact: true }),
    ).toBeDisabled();
    await expect(csvButton(page)).toBeDisabled();
    await expect(printButton(page)).toBeDisabled();
    if (nativeProject(info)) {
      const workshop = await successfulTool<WorkshopPayload>(page, 'get_workshop', {});
      const inspected = await successfulTool<{ plan: DescribedPlan }>(page, 'inspect_plan', {
        planId: emptyStockId,
      });
      expect(inspected.plan).toMatchObject({
        actor: 'human',
        approved: false,
        canRequestReview: false,
        solution: {
          complete: false,
          layouts: [],
          unfulfilled: [
            { label: 'One-metre shelf', quantity: 2, reason: expect.stringMatching(/\S/u) },
          ],
        },
      });
      await expectToolError(
        page,
        'stage_plan_for_review',
        { planId: emptyStockId, expectedRevision: workshop.workspace.revision },
        'INCOMPLETE_PLAN',
        /incomplete plan/iu,
      );
      await expectToolError(
        page,
        'export_cut_list',
        { planId: emptyStockId },
        'INCOMPLETE_PLAN',
        /partial plan/iu,
      );
    }
    await addStock(page, 'Enough for one part', 1003);
    const insufficientId = await findHumanPlan(page);
    await expect(selectedLayout(page)).toContainText('1 / 2 parts · incomplete');
    await expect(
      selectedLayout(page).getByRole('region', {
        name: 'Unfulfilled cut requirements',
        exact: true,
      }),
    ).toContainText('1 × One-metre shelf');
    await expect(
      page.getByRole('button', { name: 'Review this plan', exact: true }),
    ).toBeDisabled();
    await expectBlockedPrint(page, 'No approved cut sheet');
    if (nativeProject(info)) {
      const inspected = await successfulTool<{ plan: DescribedPlan }>(page, 'inspect_plan', {
        planId: insufficientId,
      });
      expect(inspected.plan.solution.complete).toBe(false);
      expect(inspected.plan.solution.unfulfilled).toMatchObject([
        { quantity: 1, reason: expect.stringMatching(/\S/u) },
      ]);
      expect(inspected.plan.solution.metrics).toMatchObject({
        partsMm: 1000,
        kerfMm: 3,
        boardCount: 1,
      });
      const other = await successfulTool<{ plan: DescribedPlan }>(page, 'plan_cuts', {
        expectedRevision: inspected.plan.currentRevision,
        objective: 'fewest_boards',
      });
      await expectToolError(
        page,
        'compare_plans',
        { planIds: [insufficientId, other.plan.id] },
        'INCOMPLETE_PLAN',
        /complete plans only/iu,
      );
    }
    await addStock(page, 'Kept for another job', 1003, true);
    await findHumanPlan(page);
    await expect(selectedLayout(page)).toContainText('1 / 2 parts · incomplete');
    await expect(
      selectedLayout(page).getByRole('region', {
        name: 'Protected and excluded stock',
        exact: true,
      }),
    ).toContainText('Kept for another job');
    await expect(
      page.getByRole('button', { name: 'Review this plan', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: /^Unprotect stock Kept for another job \(/u }).click();
    const completeId = await findHumanPlan(page);
    await expect(selectedLayout(page)).toContainText('2 / 2 parts planned');
    if (nativeProject(info)) {
      const workshop = await successfulTool<WorkshopPayload>(page, 'get_workshop', {});
      const inspected = await successfulTool<{ plan: DescribedPlan }>(page, 'inspect_plan', {
        planId: completeId,
      });
      expectCompletePlan(inspected.plan, workshop.workspace);
      expect(inspected.plan.solution.metrics).toMatchObject({
        stockUsedMm: 2006,
        partsMm: 2000,
        kerfMm: 6,
        reusableMm: 0,
        scrapMm: 0,
        boardCount: 2,
      });
    }
    await approveHumanPlan(page, completeId);
    const downloaded = await downloadCsv(page, info);
    expect(downloaded.records).toHaveLength(2);
    for (const row of downloaded.records)
      expect(row).toMatchObject({
        'Plan ID': completeId,
        Part: 'One-metre shelf',
        'Part length (mm)': '1000',
        'Start from usable edge (mm)': '0',
        'Kerf after this part (mm)': '3',
        'Final remnant (mm)': '0',
        'Remnant class': 'none',
      });
  },
);

test(
  'The narrow workbench contains real proposal IDs and review controls without page overflow, preserving modal Escape and focus',
  { tag: '@manual' },
  async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await commit(page, 'project-title', `Workshop-${'long'.repeat(20)}`);
    await expectNoPageOverflow(page);
    const ids: string[] = [];
    for (const objective of ['least_stock', 'least_waste', 'fewest_boards'] as const)
      ids.push(await findHumanPlan(page, objective));
    for (const id of ids)
      await expect(
        page.getByRole('button', { name: new RegExp(`^View .+ plan ${id}$`, 'u') }),
      ).toBeVisible();
    await expectNoPageOverflow(page);
    await selectedLayout(page)
      .getByRole('button', { name: 'Jump to cutting layout', exact: true })
      .click();
    await expect(selectedLayout(page).locator('.cutting-layouts')).toBeFocused();
    await expect(selectedLayout(page).locator('.cutting-layouts')).toBeInViewport();
    const review = page.getByRole('button', { name: 'Review this plan', exact: true });
    await review.click();
    const dialog = reviewDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#review-heading')).toBeFocused();
    await expect(dialog.locator('#approve-cut-sheet')).toBeDisabled();
    const reject = dialog.getByRole('button', { name: 'Reject proposal', exact: true });
    const close = dialog.getByRole('button', {
      name: 'Close review without approval',
      exact: true,
    });
    // Native dialogs may hand focus to browser chrome at the page boundary.
    // Defend internal keyboard order and native modality, not an invented UA wrap.
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab');
    const jump = dialog.getByRole('button', { name: 'Jump to cutting layout', exact: true });
    await expect(jump).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog.locator('.cutting-layouts')).toBeFocused();
    await expect(dialog.locator('.cutting-layouts')).toBeInViewport();
    await reject.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.locator('#review-acknowledgement')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(reject).toBeFocused();
    expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(true);
    await page.locator('.wordmark').focus();
    await expect(reject).toBeFocused();
    await dialog.locator('#review-acknowledgement').check();
    await expect(dialog.locator('#approve-cut-sheet')).toBeEnabled();
    await expectNoPageOverflow(page);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(review).toBeFocused();
    await expect(csvButton(page)).toBeDisabled();
    await expect(page.getByTestId('approved-print-sheet')).not.toHaveAttribute('data-plan-id');
    await review.click();
    await expect(dialog.locator('#review-acknowledgement')).not.toBeChecked();
    await expect(dialog.locator('#approve-cut-sheet')).toBeDisabled();
    await approveOpenReview(page, ids.at(-1)!);
    await expectNoPageOverflow(page);
    await page.locator('#browser-agent').scrollIntoViewIfNeeded();
    await expectNoPageOverflow(page);
  },
);
