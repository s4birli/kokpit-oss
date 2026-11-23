// Fake TerminalView: records writes, lets tests type and change the fitted size.
import type { TerminalLinkHost } from "../link-opener.ts";
import type { TerminalDims, TerminalView, TerminalViewFactory } from "../terminal-view.ts";

export class FakeTerminalView implements TerminalView {
  readonly writes: string[] = [];
  /** Writes marked as history replay (their side effects must not repeat), since creation. */
  readonly replayWrites: string[] = [];
  resets = 0;
  /** focus() calls (İş A: focusing a terminal from the Ajanlar panel). */
  focuses = 0;
  disposed = false;
  /** İş Z: every font size set, in order (the first one before the first fit). */
  readonly fontSizes: number[] = [];
  /** fit() calls, to check a font change refits. */
  fits = 0;
  /** Dims fit() returns after the next font size change (simulates glyphs changing size). */
  dimsAfterFont: TerminalDims | null | undefined;
  container: HTMLElement | null = null;
  /** Bağlantılar: what the panel gave this terminal to open its links with (absent = links not wired). */
  links: TerminalLinkHost | undefined;
  dims: TerminalDims | null;
  /** Writes attempted after dispose — must stay empty. */
  readonly writesAfterDispose: string[] = [];
  private dataCbs = new Set<(data: string) => void>();

  constructor(dims: TerminalDims | null) {
    this.dims = dims;
  }

  /** Everything currently on screen (writes since the last reset). */
  get screen(): string {
    return this.writes.join("");
  }

  open(container: HTMLElement): void {
    this.container = container;
  }
  setFontSize(px: number): void {
    this.fontSizes.push(px);
    if (this.dimsAfterFont !== undefined) this.dims = this.dimsAfterFont;
  }
  fit(): TerminalDims | null {
    this.fits++;
    return this.dims ? { ...this.dims } : null;
  }
  write(data: string, replay = false): void {
    if (this.disposed) {
      this.writesAfterDispose.push(data);
      return;
    }
    this.writes.push(data);
    if (replay) this.replayWrites.push(data);
  }
  reset(): void {
    if (this.disposed) {
      this.writesAfterDispose.push("<reset>");
      return;
    }
    this.resets++;
    this.writes.length = 0;
  }
  onData(cb: (data: string) => void): () => void {
    this.dataCbs.add(cb);
    return () => {
      this.dataCbs.delete(cb);
    };
  }
  focus(): void {
    this.focuses++;
  }
  dispose(): void {
    this.disposed = true;
    this.dataCbs.clear();
  }

  /** Simulates the user typing. */
  type(data: string): void {
    for (const cb of [...this.dataCbs]) cb(data);
  }
}

export interface FakeViewFactory {
  factory: TerminalViewFactory;
  views: FakeTerminalView[];
  /** Fitted size given to newly created views. */
  dims: TerminalDims | null;
}

export function makeFakeViewFactory(dims: TerminalDims | null = { cols: 100, rows: 30 }): FakeViewFactory {
  const out: FakeViewFactory = {
    views: [],
    dims,
    factory: (options) => {
      const v = new FakeTerminalView(out.dims);
      v.links = options?.links;
      out.views.push(v);
      return v;
    },
  };
  return out;
}

/** Controllable ResizeObserver stand-in; install with vi.stubGlobal. */
export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets: Element[] = [];
  disconnected = false;
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.targets.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  trigger(): void {
    if (this.disconnected) return;
    const entries = this.targets.map((target) => ({ target, contentRect: target.getBoundingClientRect() }));
    this.cb(entries as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
  }
  static triggerAll(): void {
    for (const o of FakeResizeObserver.instances) o.trigger();
  }
}
