import type { Agent } from '@deepseek-ai/dsh-agent';
import { type ContinuableCreateRequest, type ResolvedSubagentStartRequest, type SubagentProvider, type SubagentRun } from '@deepseek-ai/dsh-subagent';
import type { Config } from './config.js';
/**
 * Build one child's creation metadata, across harness generations.
 *
 * This package compiles against its VENDORED `@deepseek-ai` copies while it RUNS
 * against whatever harness serves it, and the meta helper changed shape exactly
 * across that seam: the vendored copy takes `lineageSeedLength` (a number) and
 * emits `seedLength`, while current harnesses take `isSeeded` (a boolean) — and
 * a current session header REJECTS `seedLength` outright with "has invalid field
 * seedLength", then requires `isSeeded` to be a boolean. Passing the vendored
 * shape through therefore failed at the first delegated child with "session
 * header isSeeded must be a boolean", a type error the vendored `.d.ts` could
 * not catch because there it is a number.
 *
 * So the harness helper still supplies the generation-specific fields (cwd,
 * agentPreset, parentSession, origin, delegationDepth), and this normalizes the
 * ONE field that moved: the boolean fact replaces the length, and the length is
 * removed rather than left for a newer validator to reject.
 * @param parent - the delegating parent.
 * @param childDepth - the child's delegation depth.
 * @param isSeeded - whether the child session is seeded with a parent prefix.
 * @returns metadata accepted by the live session implementation.
 */
export declare function childMeta(parent: Agent, childDepth: number, isSeeded: boolean): Record<string, unknown>;
/**
 * The preset-pinning in-process subagent provider. Mirrors the spawn provider
 * (`@deepseek-ai/dsh-subagent-spawn-in-process`) but, instead of joining the
 * parent's preset, mounts the configured named preset for every child and forces
 * the configured model route.
 */
export declare class PresetInProcessProvider implements SubagentProvider {
    readonly name: string;
    private readonly readConfig;
    readonly capabilities: {
        outputSchema: boolean;
        depthLimit: boolean;
        toolFilter: boolean;
        persona: boolean;
    };
    readonly inheritsParentContext = false;
    constructor(name: string, readConfig: () => Config);
    start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>;
    prepareContinuable(request?: ContinuableCreateRequest): Promise<{
        agentOptions: import("./route.js").RouteOverrides;
        presetId?: string | undefined;
    }>;
}
