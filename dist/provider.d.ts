import type { Agent } from '@deepseek-ai/dsh-agent';
import { type CreateAgentOptions } from '@deepseek-ai/dsh-agent';
import { type ContinuableCreateRequest, type ResolvedSubagentStartRequest, type SubagentProvider, type SubagentRun } from '@deepseek-ai/dsh-subagent';
import type { Config } from './config.js';
/** The creation-metadata type the agent service accepts. */
type ChildCreationMeta = NonNullable<CreateAgentOptions['meta']>;
/**
 * Build one child's durable creation metadata.
 *
 * Written out here rather than delegated to the harness's `childSessionMeta`:
 * this package's VENDORED copy of that helper is a generation behind (it takes
 * `lineageSeedLength` and emits `seedLength`, a field the current session header
 * REJECTS outright), and this plugin targets the current harness only. Owning
 * the object means its fields are exactly the ones the running session
 * validates; the cast covers the stale field types in the vendored `.d.ts`.
 * @param parent - the delegating parent.
 * @param childDepth - the child's delegation depth.
 * @param isSeeded - whether the child session is seeded with a parent prefix.
 * @returns metadata accepted by the live session implementation.
 */
export declare function childMeta(parent: Agent, childDepth: number, isSeeded: boolean): ChildCreationMeta;
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
export {};
