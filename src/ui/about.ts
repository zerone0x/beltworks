/**
 * The About panel (plain DOM, D39; D61), opened from the title screen and
 * the game menu in their place, like the settings: the version, the
 * controls as currently bound (the help panel's list, src/ui/help.ts), the
 * credits, the game's own license (MIT) and the licenses of the third-party
 * code the game bundles (the build writes their full texts into
 * `third-party-licenses.txt`, see vite.config.ts). Back (or Escape, handled
 * by whoever shows it) returns.
 */

import { VERSION_LABEL } from '../version';
import { button } from './gameMenu';
import { controls } from './help';
import { bindings, keyLabel } from './keybindings';

/** Where players report bugs and give feedback. */
export const ISSUES_URL = 'https://github.com/zerone0x/beltworks/issues';
/** The bundled packages' license texts, written next to index.html by the build. */
export const LICENSES_FILE = 'third-party-licenses.txt';
/** The game's own license (MIT) in the repository. */
export const LICENSE_URL = 'https://github.com/zerone0x/beltworks/blob/main/LICENSE';

function heading(text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.textContent = text;
  Object.assign(el.style, { fontWeight: '600', margin: '12px 0 4px' });
  return el;
}

function paragraph(...parts: (string | Node)[]): HTMLParagraphElement {
  const p = document.createElement('p');
  p.append(...parts);
  Object.assign(p.style, { margin: '4px 0' });
  return p;
}

function link(text: string, href: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.textContent = text;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.style.color = '#f2d36b';
  return a;
}

export class AboutPanel {
  readonly element: HTMLElement;
  /** Called by Back: the screen that opened the panel shows itself again. */
  onBack: () => void = () => undefined;
  private readonly table: HTMLTableElement;
  private readonly rebind: HTMLElement;

  constructor() {
    const el = document.createElement('div');
    el.id = 'about-panel';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'About Beltworks');

    const top = document.createElement('div');
    Object.assign(top.style, { display: 'flex', alignItems: 'baseline', gap: '8px' });
    const title = document.createElement('div');
    title.textContent = 'Beltworks';
    Object.assign(title.style, { fontWeight: '700', fontSize: '18px', color: '#f2d36b' });
    const version = document.createElement('span');
    version.id = 'about-version';
    version.textContent = `${VERSION_LABEL} · public beta`;
    version.style.opacity = '0.7';
    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    const back = button('Back', 'about-back');
    back.style.margin = '0';
    back.addEventListener('click', () => {
      this.onBack();
    });
    top.append(title, version, spacer, back);

    const intro = paragraph(
      'A factory-automation game for the browser: mine by hand, then build machines, belts and ' +
        'research until the factory runs itself. Saves stay in this browser (export them from ' +
        'the game menu to keep a copy).',
    );

    const table = document.createElement('table');
    table.id = 'about-controls';
    Object.assign(table.style, { borderCollapse: 'collapse', fontSize: '12px' });
    const rebind = paragraph();
    Object.assign(rebind.style, { opacity: '0.7', fontSize: '12px' });

    const credits = paragraph(
      'Made by zerone0x. The code, the art (rendered in Blender from the project’s own ' +
        'procedural models) and the sound and music (synthesized in the browser) are all ' +
        'original: no third-party art, sound or fonts.',
    );
    const feedback = paragraph(
      'Found a bug or have an idea? ',
      link('Open an issue', ISSUES_URL),
      '.',
    );

    const own = paragraph(
      'Beltworks is free software under the ',
      link('MIT License', LICENSE_URL),
      ' (copyright 2026 zerone0x).',
    );
    // The libraries PixiJS brings into the bundle (the build lists them in the license file).
    const licenses = paragraph(
      'Built with PixiJS (MIT) and the small libraries it includes (earcut, ISC; tiny-lru, ' +
        'BSD-3-Clause; eventemitter3, @pixi/colord, ismobilejs and parse-svg-path, MIT). ',
      link('Full license texts', `${import.meta.env.BASE_URL}${LICENSES_FILE}`),
      '.',
    );

    el.append(
      top,
      intro,
      heading('Controls'),
      table,
      rebind,
      heading('Credits'),
      credits,
      feedback,
      heading('Licenses'),
      own,
      licenses,
    );
    this.element = el;
    this.table = table;
    this.rebind = rebind;
    this.refresh();
  }

  /** Lists the controls with the key bindings as they are now (call before showing it). */
  refresh(): void {
    this.rebind.textContent =
      `Every key can be changed in Settings; ${keyLabel(bindings().help)} shows this list ` +
      'in the game.';
    const table = this.table;
    table.replaceChildren();
    for (const { keys, action } of controls()) {
      const row = table.insertRow();
      const k = row.insertCell();
      k.textContent = keys;
      Object.assign(k.style, {
        padding: '0 12px 0 0',
        color: '#f2d36b',
        whiteSpace: 'nowrap',
        verticalAlign: 'top',
      });
      row.insertCell().textContent = action;
    }
  }
}
