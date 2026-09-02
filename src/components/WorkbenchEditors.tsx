import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { errorMessage } from '../errors';
import { LIMITS, type Workspace, type WorkshopStore } from '../types';
import Icon from './Icon';

function integer(value: string, label: string, minimum: number, maximum: number, unit = 'mm') {
  const text = value.trim();
  const number = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(number)) {
    throw new Error(`${label} must be a whole number${unit === 'mm' ? ' in millimetres' : ''}.`);
  }
  if (number < minimum || number > maximum) {
    throw new Error(
      `${label} must be between ${minimum.toLocaleString('en-US')} and ${maximum.toLocaleString('en-US')}${unit === 'mm' ? ' mm' : ''}.`,
    );
  }
  return number;
}

function CommitField({
  id,
  label,
  value,
  onCommit,
  reportDirty,
  numeric = false,
  maxLength,
  compact = false,
  suffix,
}: {
  id: string;
  label: string;
  value: string | number;
  onCommit: (draft: string) => void;
  reportDirty: (id: string, dirty: boolean) => void;
  numeric?: boolean;
  maxLength?: number;
  compact?: boolean;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(String(value));
    setError(null);
    reportDirty(id, false);
  }, [value, id, reportDirty]);
  useEffect(() => () => reportDirty(id, false), [id, reportDirty]);

  function commit() {
    if (draft === String(value)) return;
    try {
      onCommit(draft);
      setDraft(numeric ? String(Number(draft.trim())) : draft.trim());
      setError(null);
      reportDirty(id, false);
    } catch (cause) {
      setError(errorMessage(cause));
      reportDirty(id, true);
    }
  }

  return (
    <div className={`field${numeric ? ' field--numeric' : ''}${compact ? ' field--compact' : ''}`}>
      <label className={compact ? 'sr-only' : undefined} htmlFor={id}>
        {label}
      </label>
      <div className="field-control">
        <input
          id={id}
          type="text"
          inputMode={numeric ? 'numeric' : undefined}
          autoComplete="off"
          spellCheck={!numeric}
          maxLength={maxLength}
          value={draft}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
            reportDirty(id, event.target.value !== String(value));
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(String(value));
              setError(null);
              reportDirty(id, false);
            }
          }}
        />
        {suffix && (
          <span className="field-suffix" aria-hidden="true">
            {suffix}
          </span>
        )}
      </div>
      {error && (
        <p className="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export default function WorkbenchEditors({
  workspace,
  store,
  disabled,
  onError,
  onDirtyChange,
}: {
  workspace: Workspace;
  store: WorkshopStore;
  disabled: boolean;
  onError: (cause: unknown) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const pendingFields = useRef(new Set<string>());
  const reportDirty = useCallback(
    (id: string, dirty: boolean) => {
      if (dirty) pendingFields.current.add(id);
      else pendingFields.current.delete(id);
      onDirtyChange(pendingFields.current.size > 0);
    },
    [onDirtyChange],
  );
  const [addingStock, setAddingStock] = useState(false);
  const [addingRequirement, setAddingRequirement] = useState(false);
  const [stockError, setStockError] = useState<string | null>(null);
  const [requirementError, setRequirementError] = useState<string | null>(null);
  const stockAddButton = useRef<HTMLButtonElement>(null);
  const requirementAddButton = useRef<HTMLButtonElement>(null);
  const stockHeading = useRef<HTMLHeadingElement>(null);
  const requirementHeading = useRef<HTMLHeadingElement>(null);
  const previousForms = useRef({ stock: false, requirement: false });

  useEffect(() => {
    if (previousForms.current.stock && !addingStock)
      (stockAddButton.current?.disabled ? stockHeading.current : stockAddButton.current)?.focus();
    if (previousForms.current.requirement && !addingRequirement)
      (requirementAddButton.current?.disabled
        ? requirementHeading.current
        : requirementAddButton.current
      )?.focus();
    previousForms.current = { stock: addingStock, requirement: addingRequirement };
  }, [addingStock, addingRequirement]);
  const availableMm = workspace.stock.reduce(
    (total, board) => total + (board.locked ? 0 : board.lengthMm),
    0,
  );
  const requestedParts = workspace.requirements.reduce((total, part) => total + part.quantity, 0);
  const protectedCount = workspace.stock.filter((board) => board.locked).length;

  function attempt(operation: () => void) {
    try {
      operation();
    } catch (cause) {
      onError(cause);
    }
  }

  function addStock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      store.addStock({
        label: String(data.get('label') ?? '').trim(),
        lengthMm: integer(
          String(data.get('length') ?? ''),
          'Usable stock length',
          1,
          LIMITS.lengthMm,
        ),
        kind: String(data.get('kind') ?? '') as 'board' | 'offcut',
        locked: data.get('locked') === 'on',
      });
      setAddingStock(false);
      setStockError(null);
      reportDirty('new-stock', false);
    } catch (cause) {
      setStockError(errorMessage(cause));
    }
  }

  function addRequirement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      store.addRequirement({
        label: String(data.get('label') ?? '').trim(),
        lengthMm: integer(String(data.get('length') ?? ''), 'Part length', 1, LIMITS.lengthMm),
        quantity: integer(
          String(data.get('quantity') ?? ''),
          'Part quantity',
          1,
          LIMITS.totalParts,
          'parts',
        ),
      });
      setAddingRequirement(false);
      setRequirementError(null);
      reportDirty('new-requirement', false);
    } catch (cause) {
      setRequirementError(errorMessage(cause));
    }
  }

  return (
    <fieldset className="measurement-surface" disabled={disabled}>
      <legend className="sr-only">Workshop measurements</legend>
      <section className="project-fields" aria-labelledby="project-heading">
        <h3 id="project-heading" className="sr-only">
          Project details
        </h3>
        <CommitField
          id="project-title"
          label="Project title"
          value={workspace.title}
          maxLength={100}
          reportDirty={reportDirty}
          onCommit={(title) => store.updateProject({ title: title.trim() })}
        />
        <CommitField
          id="project-material"
          label="Material & cross-section"
          value={workspace.material}
          maxLength={100}
          reportDirty={reportDirty}
          onCommit={(material) => store.updateProject({ material: material.trim() })}
        />
        <p className="field-hint project-hint">
          One material and cross-section per job. Project text: up to 100 characters.
        </p>
      </section>

      <section className="measurement-block" aria-labelledby="stock-heading">
        <div className="block-heading">
          <div>
            <h3 ref={stockHeading} id="stock-heading" tabIndex={-1}>
              Stock on the rack
            </h3>
            <p className="small-text">
              {workspace.stock.length} lengths · max {LIMITS.stockBoards} ·{' '}
              {availableMm.toLocaleString('en-US')} mm available
            </p>
          </div>
          <button
            ref={stockAddButton}
            type="button"
            className="button button--small button--secondary"
            disabled={addingStock || workspace.stock.length >= LIMITS.stockBoards}
            onClick={() => {
              setAddingStock(true);
              reportDirty('new-stock', true);
            }}
          >
            <Icon name="add" />
            Add stock
          </button>
        </div>
        {workspace.stock.length === 0 ? (
          <div className="empty-measurements">
            <p>Your rack is ready for a first length.</p>
            <span>
              Measure a board or offcut, deduct trim and defects, then add its usable length.
            </span>
          </div>
        ) : (
          <div className="inventory-list">
            <div className="inventory-labels" aria-hidden="true">
              <span>Label / type</span>
              <span>Usable length</span>
              <span>Availability</span>
              <span />
            </div>
            {workspace.stock.map((board) => (
              <div
                className={`inventory-row${board.locked ? ' inventory-row--protected' : ''}`}
                key={board.id}
              >
                <div className="stock-identity">
                  <CommitField
                    id={`stock-label-${board.id}`}
                    label={`Stock label ${board.id}`}
                    compact
                    value={board.label}
                    maxLength={80}
                    reportDirty={reportDirty}
                    onCommit={(label) => store.updateStock(board.id, { label: label.trim() })}
                  />
                  <div className="stock-meta">
                    <span className="reference">{board.id}</span>
                    <label>
                      <span className="sr-only">Stock type for {board.id}</span>
                      <select
                        value={board.kind}
                        onChange={(event) =>
                          attempt(() =>
                            store.updateStock(board.id, {
                              kind: event.target.value as 'board' | 'offcut',
                            }),
                          )
                        }
                      >
                        <option value="board">Full board</option>
                        <option value="offcut">Offcut</option>
                      </select>
                    </label>
                  </div>
                </div>
                <CommitField
                  id={`stock-length-${board.id}`}
                  label={`Usable length for ${board.label} (${board.id}) in millimetres`}
                  compact
                  numeric
                  suffix="mm"
                  value={board.lengthMm}
                  reportDirty={reportDirty}
                  onCommit={(value) =>
                    store.updateStock(board.id, {
                      lengthMm: integer(value, 'Usable stock length', 1, LIMITS.lengthMm),
                    })
                  }
                />
                <button
                  type="button"
                  className={`stock-lock${board.locked ? ' stock-lock--protected' : ''}`}
                  aria-pressed={board.locked}
                  aria-label={`${board.locked ? 'Unprotect' : 'Protect'} stock ${board.label} (${board.id})`}
                  onClick={() =>
                    attempt(() => store.updateStock(board.id, { locked: !board.locked }))
                  }
                >
                  <Icon name={board.locked ? 'lock' : 'unlock'} />
                  <span>{board.locked ? 'Protected' : 'Available'}</span>
                </button>
                <button
                  type="button"
                  className="icon-button icon-button--remove"
                  aria-label={`Remove stock ${board.label} (${board.id})`}
                  onClick={() => attempt(() => store.removeStock(board.id))}
                >
                  <Icon name="remove" />
                </button>
              </div>
            ))}
          </div>
        )}
        {addingStock && (
          <form className="add-form" onSubmit={addStock} aria-label="Add stock measurements">
            <h4>One more usable length</h4>
            <div className="add-form-fields">
              <label className="field">
                Stock label
                <input
                  name="label"
                  maxLength={80}
                  required
                  autoFocus
                  placeholder="e.g. Bench offcut"
                />
              </label>
              <label className="field">
                Usable length (mm)
                <input
                  name="length"
                  type="text"
                  inputMode="numeric"
                  required
                  placeholder="Whole mm"
                />
              </label>
              <label className="field">
                Stock type
                <select name="kind" defaultValue="board">
                  <option value="board">Full board</option>
                  <option value="offcut">Offcut</option>
                </select>
              </label>
            </div>
            <label className="checkbox-label">
              <input name="locked" type="checkbox" />
              Protect this length from planning
            </label>
            <p className="field-hint">
              Stock labels: up to 80 characters. Lengths: 1–
              {LIMITS.lengthMm.toLocaleString('en-US')} mm.
            </p>
            {stockError && (
              <p className="field-error" role="alert">
                {stockError}
              </p>
            )}
            <div className="form-actions">
              <button className="button button--small" type="submit">
                Add stock to inventory
              </button>
              <button
                type="button"
                className="button button--small button--quiet"
                aria-label="Cancel adding stock"
                onClick={() => {
                  setAddingStock(false);
                  setStockError(null);
                  reportDirty('new-stock', false);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        <p className="protection-note">
          <Icon name="lock" />
          <span>
            {protectedCount > 0
              ? `${protectedCount} protected ${protectedCount === 1 ? 'length stays' : 'lengths stay'} untouched. `
              : ''}
            Protection keeps stock out of every plan. Only you can release it.
          </span>
        </p>
      </section>

      <section className="measurement-block" aria-labelledby="requirements-heading">
        <div className="block-heading">
          <div>
            <h3 ref={requirementHeading} id="requirements-heading" tabIndex={-1}>
              Parts to make
            </h3>
            <p className="small-text">
              {requestedParts} parts · max {LIMITS.totalParts} · {workspace.requirements.length} cut
              requirements · max {LIMITS.requirements}
            </p>
          </div>
          <button
            ref={requirementAddButton}
            type="button"
            className="button button--small button--secondary"
            disabled={
              addingRequirement ||
              workspace.requirements.length >= LIMITS.requirements ||
              requestedParts >= LIMITS.totalParts
            }
            onClick={() => {
              setAddingRequirement(true);
              reportDirty('new-requirement', true);
            }}
          >
            <Icon name="add" />
            Add part
          </button>
        </div>
        {workspace.requirements.length === 0 ? (
          <div className="empty-measurements">
            <p>What are you making?</p>
            <span>
              Add a part name, its finished length and how many you need. The planner accounts for
              every copy.
            </span>
          </div>
        ) : (
          <div className="requirements-list">
            <div className="requirement-labels" aria-hidden="true">
              <span>Part</span>
              <span>Finished length</span>
              <span>Quantity</span>
              <span />
            </div>
            {workspace.requirements.map((part) => (
              <div className="requirement-row" key={part.id}>
                <div className="stock-identity">
                  <CommitField
                    id={`part-label-${part.id}`}
                    label={`Part label ${part.id}`}
                    compact
                    value={part.label}
                    maxLength={80}
                    reportDirty={reportDirty}
                    onCommit={(label) => store.updateRequirement(part.id, { label: label.trim() })}
                  />
                  <span className="reference">{part.id}</span>
                </div>
                <CommitField
                  id={`part-length-${part.id}`}
                  label={`Finished length for ${part.label} (${part.id}) in millimetres`}
                  compact
                  numeric
                  suffix="mm"
                  value={part.lengthMm}
                  reportDirty={reportDirty}
                  onCommit={(value) =>
                    store.updateRequirement(part.id, {
                      lengthMm: integer(value, 'Part length', 1, LIMITS.lengthMm),
                    })
                  }
                />
                <CommitField
                  id={`part-quantity-${part.id}`}
                  label={`Quantity for ${part.label} (${part.id})`}
                  compact
                  numeric
                  suffix="qty"
                  value={part.quantity}
                  reportDirty={reportDirty}
                  onCommit={(value) =>
                    store.updateRequirement(part.id, {
                      quantity: integer(value, 'Part quantity', 1, LIMITS.totalParts, 'parts'),
                    })
                  }
                />
                <button
                  type="button"
                  className="icon-button icon-button--remove"
                  aria-label={`Remove part ${part.label} (${part.id})`}
                  onClick={() => attempt(() => store.removeRequirement(part.id))}
                >
                  <Icon name="remove" />
                </button>
              </div>
            ))}
          </div>
        )}
        {addingRequirement && (
          <form className="add-form" onSubmit={addRequirement} aria-label="Add cut requirement">
            <h4>A part, and every copy of it</h4>
            <div className="add-form-fields">
              <label className="field">
                Part label
                <input name="label" maxLength={80} required autoFocus placeholder="e.g. Shelf" />
              </label>
              <label className="field">
                Finished length (mm)
                <input
                  name="length"
                  type="text"
                  inputMode="numeric"
                  required
                  placeholder="Whole mm"
                />
              </label>
              <label className="field">
                Part quantity
                <input name="quantity" type="text" inputMode="numeric" required defaultValue="1" />
              </label>
            </div>
            <p className="field-hint">
              Part labels: up to 80 characters. At most {LIMITS.totalParts} parts in the whole job.
            </p>
            {requirementError && (
              <p className="field-error" role="alert">
                {requirementError}
              </p>
            )}
            <div className="form-actions">
              <button className="button button--small" type="submit">
                Add cut requirement
              </button>
              <button
                type="button"
                className="button button--small button--quiet"
                aria-label="Cancel adding part"
                onClick={() => {
                  setAddingRequirement(false);
                  setRequirementError(null);
                  reportDirty('new-requirement', false);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="measurement-block physical-settings" aria-labelledby="settings-heading">
        <div className="block-heading">
          <div>
            <h3 id="settings-heading">The real-world allowance</h3>
            <p className="small-text">Physical settings · whole millimetres</p>
          </div>
          <span className="setting-mark" aria-hidden="true">
            mm
          </span>
        </div>
        <div className="settings-fields">
          <div>
            <CommitField
              id="kerf-mm"
              label="Saw kerf per part (mm)"
              numeric
              suffix="mm"
              value={workspace.settings.kerfMm}
              reportDirty={reportDirty}
              onCommit={(value) =>
                store.setSettings({ kerfMm: integer(value, 'Saw kerf', 0, LIMITS.kerfMm) })
              }
            />
            <p className="field-hint">Material lost to each saw pass. 0–{LIMITS.kerfMm} mm.</p>
          </div>
          <div>
            <CommitField
              id="reusable-mm"
              label="Minimum reusable remnant (mm)"
              numeric
              suffix="mm"
              value={workspace.settings.minReusableMm}
              reportDirty={reportDirty}
              onCommit={(value) =>
                store.setSettings({
                  minReusableMm: integer(value, 'Reusable remnant minimum', 0, LIMITS.lengthMm),
                })
              }
            />
            <p className="field-hint">
              Keep positive remnants at or above this length. Shorter pieces are scrap.
            </p>
          </div>
        </div>
        <p className="physical-note">
          One saw pass per produced part, including the last part on a board. Enter usable stock
          after deducting end trimming and defects; Offcut does not calculate those allowances.
        </p>
      </section>
      <p className="editing-note">
        Edits save on Enter or when you leave a field. Escape restores its last saved value.
      </p>
    </fieldset>
  );
}
