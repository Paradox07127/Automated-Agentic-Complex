// `region.*`: the 框选给她看 page's drag; only that page is served.

/** A point in page points, y down from the page's top left. */
export interface RegionPoint {
  x: number;
  y: number;
}

export interface RegionOps {
  /** The drag from its press to its release; native cancels a rect with a side under 8 points. */
  finish(from: RegionPoint, to: RegionPoint): Promise<void>;
  cancel(): Promise<void>;
}

// protocol.ts is at web's 400-line file limit, so the bridge's member is declared here.
declare module './protocol' {
  interface AgenticComplexBridge {
    /** The 框选给她看 page's own. */
    region: RegionOps;
  }
}
