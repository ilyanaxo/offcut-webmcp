import { WorkshopError } from './errors';
import type { WorkshopSnapshot } from './types';

/** Quote every cell and neutralize spreadsheet formulas in human-entered text. */
function csvCell(value: string | number): string {
  const text = String(value);
  const safe = /^\s*[=+\-@]/u.test(text) || /^[\t\r]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function exportApprovedPlan(
  snapshot: WorkshopSnapshot,
  planId: string,
): { filename: string; csv: string } {
  const plan = snapshot.plans.find((candidate) => candidate.id === planId);
  if (!plan) throw new WorkshopError('PLAN_NOT_FOUND', 'This cutting plan no longer exists.');
  if (plan.basedOnRevision !== snapshot.workspace.revision) {
    throw new WorkshopError(
      'STALE_PLAN',
      'Measurements changed. Generate and approve a fresh plan before export.',
    );
  }
  if (!plan.solution.complete)
    throw new WorkshopError('INCOMPLETE_PLAN', 'A partial plan cannot become a cut sheet.');
  if (snapshot.approvedPlanId !== planId) {
    throw new WorkshopError(
      'APPROVAL_REQUIRED',
      'The human must review and approve this exact plan before export.',
    );
  }

  const { workspace } = snapshot;
  const rows: (string | number)[][] = [
    [
      'Project',
      'Material (same cross-section)',
      'Plan ID',
      'Workspace revision',
      'Board ID',
      'Board label',
      'Usable stock length (mm)',
      'Cut order',
      'Part ID',
      'Part',
      'Part instance',
      'Part length (mm)',
      'Start from usable edge (mm)',
      'End before kerf (mm)',
      'Kerf after this part (mm)',
      'Final remnant (mm)',
      'Remnant class',
    ],
  ];
  for (const layout of plan.solution.layouts) {
    for (let index = 0; index < layout.cuts.length; index += 1) {
      const cut = layout.cuts[index];
      const lastCut = index === layout.cuts.length - 1;
      rows.push([
        workspace.title,
        workspace.material,
        plan.id,
        workspace.revision,
        layout.stockId,
        layout.stockLabel,
        layout.stockLengthMm,
        index + 1,
        cut.requirementId,
        cut.label,
        cut.instance,
        cut.lengthMm,
        cut.offsetMm,
        cut.offsetMm + cut.lengthMm,
        workspace.settings.kerfMm,
        lastCut ? layout.remnantMm : '',
        lastCut ? layout.remnantKind : '',
      ]);
    }
  }
  const slug =
    workspace.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '') || 'cut-sheet';
  return {
    filename: `offcut-${slug}-r${workspace.revision}-${plan.id}.csv`,
    csv: `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`,
  };
}
