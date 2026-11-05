export type LskSaved = { path: string; at: number; reason: string };
export type LskMeter = { tokens: number; window: number; percent: number };

declare module "claude-code" {
  interface PluginState {
    "long-session-kit": {
      /** The session's project root (the folder it is linked to), read at session start; handoffs go to the top level of it by default. */
      root: string;
      isInteractive: boolean;
      /** A main-thread turn is running. */
      running: boolean;
      /** Millisecond time the last main-thread turn ended (0 = none yet). */
      lastActivityAt: number;
      /** The lastActivityAt value a handoff already covers: one handoff per idle period. */
      coveredAt: number;
      /** First context threshold already crossed and handed off (re-armed below it). */
      fired: boolean;
      /** Second context threshold already crossed, handed off and /compact suggested (re-armed below it). */
      firedSecond: boolean;
      busy: boolean;
      last: LskSaved | null;
      meter: LskMeter | null;
      /** Time a handoff from an earlier session was found, for the resume hint. */
      offerAt: number;
      /** True while the survey-time status line is pinned. */
      statusOn: boolean;
    };
  }
}
