import { invoke } from "@tauri-apps/api/core";
import {
  BrowserSurfaceGuard,
  type BrowserSurfaceHold,
} from "./browser_surface_guard";
import { setAppliedInterfaceScale } from "./interface_scale_geometry";

/** Hide native page content before changing the main webview's coordinate space.
 * An uncertain zoom receipt retains the hold until a successful explicit retry. */
export class InterfaceZoom {
  private hold: BrowserSurfaceHold | null = null;
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private readonly guard: BrowserSurfaceGuard,
    private readonly zoom: (factor: number) => Promise<void> = async (
      factor,
    ) => {
      const actual = await invoke<number>("interface_scale_apply", { factor });
      if (!Number.isFinite(actual) || Math.abs(actual - factor) > 0.000001)
        throw new Error("The display size could not be confirmed");
    },
    private readonly applied: (
      factor: number,
    ) => void = setAppliedInterfaceScale,
  ) {}
  apply(value: number): Promise<void> {
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        if (this.hold && this.guard.getSnapshot().failed) this.guard.retry();
        const hold = (this.hold ??= this.guard.hold());
        await new Promise<void>((resolve, reject) => {
          let stop = () => {};
          const check = () => {
            if (hold.ready) {
              stop();
              resolve();
            } else if (this.guard.getSnapshot().failed) {
              stop();
              reject(new Error("The page could not be hidden"));
            }
          };
          stop = this.guard.subscribe(check);
          check();
        });
        const factor = value / 100;
        await this.zoom(factor);
        this.applied(factor);
        this.hold = null;
        hold.release();
      });
    this.pending = operation;
    return operation;
  }
}
