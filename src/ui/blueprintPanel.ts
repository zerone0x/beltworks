/**
 * The blueprint library panel (D59, plain DOM as D39), toggled with the
 * blueprint key (`B` by default) and closed with `Escape`: the clipboard
 * (the last copied blueprint) with a name field to save it to the library;
 * the library's blueprints, each to paste (picks it up), export (its string
 * in the text field, and copied to the clipboard) or delete (asks twice);
 * and the text field, where a pasted blueprint string is imported into the
 * library. The library lives in `localStorage` (src/blueprint/library.ts).
 */

import type { Blueprint } from '../blueprint/blueprint';
import type { BlueprintLibrary, LibraryEntry } from '../blueprint/library';
import {
  BlueprintError,
  MAX_LABEL_LENGTH,
  decodeBlueprint,
  encodeBlueprint,
} from '../blueprint/string';
import { PANEL_STYLE, button, confirmTwice, copyText, isolateKeys } from './gameMenu';
import { actionFor } from './keybindings';

export interface BlueprintPanelActions {
  /** The last copied blueprint, or `null`. */
  clipboard(): Blueprint | null;
  /** Puts `bp` on the cursor (and makes it the clipboard). */
  hold(bp: Blueprint): void;
}

const FIELD_STYLE: Partial<CSSStyleDeclaration> = {
  boxSizing: 'border-box',
  color: '#e8e2d0',
  font: '12px ui-monospace, SFMono-Regular, Menlo, monospace',
  background: 'rgba(0, 0, 0, 0.35)',
  border: '1px solid rgba(232, 226, 208, 0.3)',
  borderRadius: '4px',
  padding: '3px 6px',
};

/** `n` entities, in words. */
const entitiesLabel = (n: number): string => `${String(n)} ${n === 1 ? 'entity' : 'entities'}`;

/** A message for a failed import or export. */
function errorText(err: unknown): string {
  if (err instanceof BlueprintError) return `${err.message}.`;
  return `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
}

export class BlueprintPanel {
  readonly element: HTMLElement;
  private readonly clipboardInfo: HTMLElement;
  private readonly nameField: HTMLInputElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly list: HTMLElement;
  private readonly text: HTMLTextAreaElement;
  private readonly status: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly library: BlueprintLibrary,
    private readonly actions: BlueprintPanelActions,
  ) {
    const el = document.createElement('div');
    el.id = 'blueprint-panel';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Blueprints');
    el.hidden = true;
    Object.assign(el.style, PANEL_STYLE, {
      position: 'fixed',
      top: '56px',
      left: '50%',
      transform: 'translateX(-50%)',
      minWidth: '440px',
      maxWidth: '520px',
      zIndex: '35',
    });

    const head = document.createElement('div');
    Object.assign(head.style, { display: 'flex', alignItems: 'center', marginBottom: '6px' });
    const title = document.createElement('div');
    title.textContent = 'Blueprints';
    Object.assign(title.style, { fontWeight: '600', flex: '1' });
    const close = button('×');
    close.dataset.role = 'close';
    close.title = 'Close (Esc)';
    close.addEventListener('click', () => {
      this.close();
    });
    head.append(title, close);

    const clip = document.createElement('div');
    Object.assign(clip.style, { display: 'flex', alignItems: 'center', gap: '6px' });
    this.clipboardInfo = document.createElement('span');
    this.clipboardInfo.dataset.role = 'clipboard';
    Object.assign(this.clipboardInfo.style, { flex: '1', opacity: '0.85' });
    this.nameField = document.createElement('input');
    this.nameField.dataset.role = 'name';
    this.nameField.placeholder = 'Name';
    this.nameField.maxLength = MAX_LABEL_LENGTH;
    Object.assign(this.nameField.style, FIELD_STYLE, { width: '130px' });
    isolateKeys(this.nameField);
    this.saveButton = button('Save to library');
    this.saveButton.dataset.role = 'save';
    this.saveButton.addEventListener('click', () => {
      void this.saveClipboard();
    });
    this.nameField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.saveClipboard();
    });
    clip.append(this.clipboardInfo, this.nameField, this.saveButton);

    this.list = document.createElement('div');
    this.list.dataset.role = 'list';
    Object.assign(this.list.style, {
      margin: '8px 0',
      maxHeight: '40vh',
      overflowY: 'auto',
      borderTop: '1px solid rgba(232, 226, 208, 0.15)',
      borderBottom: '1px solid rgba(232, 226, 208, 0.15)',
    });

    this.text = document.createElement('textarea');
    this.text.dataset.role = 'string';
    this.text.rows = 3;
    this.text.spellcheck = false;
    this.text.placeholder = 'Paste a blueprint string here and press Import, or export one above.';
    Object.assign(this.text.style, FIELD_STYLE, { width: '100%', resize: 'vertical' });
    isolateKeys(this.text);
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '6px', marginTop: '6px' });
    const importButton = button('Import');
    importButton.dataset.role = 'import';
    importButton.addEventListener('click', () => {
      void this.importText();
    });
    const copyButton = button('Copy string');
    copyButton.dataset.role = 'copy';
    copyButton.addEventListener('click', () => {
      const value = this.text.value.trim();
      if (value === '') return;
      void copyText(value).then((ok) => {
        this.setStatus(ok ? 'Copied the string.' : 'Couldn’t copy: select the string and copy it.');
      });
    });
    row.append(importButton, copyButton);
    this.status = document.createElement('div');
    this.status.dataset.role = 'status';
    this.status.setAttribute('role', 'status');
    Object.assign(this.status.style, { marginTop: '6px', minHeight: '1.5em', opacity: '0.85' });

    el.append(head, clip, this.list, this.text, row, this.status);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.close();
      } else if (
        actionFor(e.code) === 'blueprints' &&
        !e.repeat &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        this.toggle();
      }
    });
    parent.append(el);
    this.element = el;
    this.render();
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.element.hidden = false;
    this.render();
  }

  close(): void {
    this.element.hidden = true;
    // Keep keyboard focus on the game, so WASD and the hotbar keys keep working.
    if (
      document.activeElement instanceof HTMLElement &&
      this.element.contains(document.activeElement)
    ) {
      document.activeElement.blur();
    }
  }

  /** Shows the clipboard and the library as they are now. */
  render(): void {
    const clip = this.actions.clipboard();
    this.clipboardInfo.textContent = clip
      ? `Copied: ${entitiesLabel(clip.entities.length)}`
      : 'Nothing copied yet (copy key, then drag a box)';
    this.saveButton.disabled = clip === null;
    this.nameField.disabled = clip === null;
    this.list.replaceChildren(...this.library.entries.map((e) => this.entryRow(e)));
    if (this.library.entries.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'The library is empty.';
      Object.assign(empty.style, { padding: '6px 0', opacity: '0.6' });
      this.list.append(empty);
    }
  }

  private setStatus(message: string): void {
    this.status.textContent = message;
  }

  private entryRow(entry: LibraryEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = 'blueprint';
    row.dataset.id = entry.id;
    row.dataset.name = entry.name;
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '4px 0',
    });
    const name = document.createElement('span');
    name.textContent = entry.name;
    Object.assign(name.style, { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis' });
    const count = document.createElement('span');
    count.textContent = entitiesLabel(entry.entities);
    Object.assign(count.style, { opacity: '0.6', fontSize: '12px' });
    const paste = button('Paste');
    paste.dataset.action = 'paste';
    paste.addEventListener('click', () => {
      void this.decode(entry.text).then((bp) => {
        if (!bp) return;
        this.close();
        this.actions.hold(bp);
      });
    });
    const exp = button('Export');
    exp.dataset.action = 'export';
    exp.addEventListener('click', () => {
      this.text.value = entry.text;
      this.text.select();
      void copyText(entry.text).then((ok) => {
        this.setStatus(
          ok
            ? `The string of “${entry.name}” is below and on the clipboard.`
            : `The string of “${entry.name}” is below: copy it from there.`,
        );
      });
    });
    const del = button('Delete');
    del.dataset.action = 'delete';
    confirmTwice(del, () => {
      this.library.remove(entry.id);
      this.setStatus(`Deleted “${entry.name}”.`);
      this.render();
    });
    row.append(name, count, paste, exp, del);
    return row;
  }

  /** The blueprint of string `text`, or `null` with the reason in the status line. */
  private async decode(text: string): Promise<Blueprint | null> {
    try {
      return await decodeBlueprint(text);
    } catch (err) {
      this.setStatus(errorText(err));
      return null;
    }
  }

  private async saveClipboard(): Promise<void> {
    const clip = this.actions.clipboard();
    if (!clip) return;
    const name =
      this.nameField.value.trim() || `Blueprint ${String(this.library.entries.length + 1)}`;
    try {
      const text = await encodeBlueprint({ ...clip, label: name.slice(0, MAX_LABEL_LENGTH) });
      this.library.add(name, text, clip.entities.length);
      this.nameField.value = '';
      this.setStatus(`Saved “${name}”.`);
      this.render();
    } catch (err) {
      this.setStatus(errorText(err));
    }
  }

  private async importText(): Promise<void> {
    const text = this.text.value.trim();
    if (text === '') {
      this.setStatus('Paste a blueprint string into the field first.');
      return;
    }
    const bp = await this.decode(text);
    if (!bp) return;
    const name = bp.label || `Imported blueprint ${String(this.library.entries.length + 1)}`;
    try {
      // Stored as written now, so an older format is migrated once.
      const stored = await encodeBlueprint({ ...bp, label: name });
      this.library.add(name, stored, bp.entities.length);
    } catch (err) {
      this.setStatus(errorText(err));
      return;
    }
    this.text.value = '';
    this.setStatus(`Imported “${name}” (${entitiesLabel(bp.entities.length)}).`);
    this.render();
  }
}
