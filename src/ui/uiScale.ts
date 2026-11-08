/**
 * The UI scale setting (D50): scales the DOM interface (panels, hotbar,
 * menus) with a CSS transform on each registered element, around the point
 * it is anchored at (the hotbar around its bottom center, a panel in the
 * top-left corner around that corner), so every element stays where it was
 * laid out and nothing else moves. Transforms keep pointer hit-testing
 * right and leave the layout code alone; at scale 1 the elements carry no
 * transform at all (beyond their own), so the screenshot tests see the same
 * pixels as before.
 */

interface Scaled {
  element: HTMLElement;
  /** `transform-origin`: the point the element is anchored at. */
  origin: string;
  /** The element's own transform, kept in front of the scale (e.g. a centering translate). */
  base: string;
}

/** The CSS transform for an element with its own transform `base`, at UI scale `scale`. */
export function scaledTransform(base: string, scale: number): string {
  if (scale === 1) return base;
  return `${base} scale(${String(scale)})`.trim();
}

export class UiScale {
  private readonly elements: Scaled[] = [];
  private scale = 1;

  /**
   * Scales `element` around `origin` (a `transform-origin`) from now on,
   * keeping the transform it has now in front of the scale.
   */
  register(element: HTMLElement, origin: string): void {
    const entry = { element, origin, base: element.style.transform };
    this.elements.push(entry);
    this.apply(entry);
  }

  get value(): number {
    return this.scale;
  }

  set(scale: number): void {
    if (scale === this.scale) return;
    this.scale = scale;
    for (const entry of this.elements) this.apply(entry);
  }

  private apply({ element, origin, base }: Scaled): void {
    element.style.transform = scaledTransform(base, this.scale);
    element.style.transformOrigin = this.scale === 1 ? '' : origin;
  }
}
