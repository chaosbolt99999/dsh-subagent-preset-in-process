import { type ContinuableCreateRequest, type ResolvedSubagentStartRequest, type SubagentProvider, type SubagentRun } from '@deepseek-ai/dsh-subagent';
import type { Config } from './config.js';
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
