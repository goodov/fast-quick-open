import { parsePrefillRequest, type PrefillRequest } from './prefill.ts';

/** The `extension.fastQuickOpen` command's keybinding args: a partial {@link PrefillRequest}. */
export type FastQuickOpenArgs = Partial<PrefillRequest>;

/** Parses (and validates) the raw args object passed to the command. */
export function parseFastQuickOpenArgs(args: unknown): FastQuickOpenArgs {
  return {
    ...parsePrefillRequest(args),
  };
}
