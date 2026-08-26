/** Central close dispatcher for renderer-owned transient UI surfaces. */

export type TransientSurfaceCloseReason =
  | "escape"
  | "outside"
  | "viewport"
  | "document-change"
  | "host-command"
  | "programmatic";

export interface TransientSurface {
  id: string;
  priority?: number;
  visible: () => boolean;
  close: (reason: TransientSurfaceCloseReason) => void;
}

export class TransientSurfaceRegistry {
  private readonly surfaces = new Map<string, Required<TransientSurface>>();

  register(surface: TransientSurface): () => void {
    const id = surface.id.trim();
    if (!id) throw new Error("Transient surface id is required");
    if (this.surfaces.has(id)) throw new Error(`Transient surface already registered: ${id}`);
    const entry: Required<TransientSurface> = { ...surface, id, priority: surface.priority ?? 0 };
    this.surfaces.set(id, entry);
    return () => {
      if (this.surfaces.get(id) === entry) this.surfaces.delete(id);
    };
  }

  visible(): string[] {
    return [...this.surfaces.values()]
      .filter((surface) => surface.visible())
      .sort((left, right) => right.priority - left.priority)
      .map((surface) => surface.id);
  }

  close(ids: readonly string[], reason: TransientSurfaceCloseReason = "programmatic"): string[] {
    const closed: string[] = [];
    for (const id of ids) {
      const surface = this.surfaces.get(id);
      if (!surface?.visible()) continue;
      surface.close(reason);
      closed.push(id);
    }
    return closed;
  }

  closeTop(reason: TransientSurfaceCloseReason = "escape"): string | null {
    const id = this.visible()[0];
    if (!id) return null;
    this.close([id], reason);
    return id;
  }

  closeAll(reason: TransientSurfaceCloseReason = "programmatic"): string[] {
    return this.close(this.visible(), reason);
  }
}

export const createTransientSurfaceRegistry = (): TransientSurfaceRegistry => new TransientSurfaceRegistry();
