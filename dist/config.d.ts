import z from '@deepseek-ai/schemastery';
/**
 * Configuration for the preset-pinning subagent backend.
 *
 * `providerName` is the name this backend registers on `ctx.subagents`; a
 * `tool-subagent` instance points at it via `provider`. `presetId` is the
 * agent preset every (non-crew) child is composed under, and the fallback
 * composition when a crew role names none. `provider`/`model`/`maxTokens`
 * force the child's model route; `maxDepth` caps delegation recursion (a
 * number requires the provider's `depthLimit` capability, which it advertises)
 * or hands the budget to the child runtime with `'provider-managed'`.
 *
 * `crews` is an optional named-crew map. Each crew is a role-ordered set of
 * continuable members (planner <-> orchestrator <-> builder <-> verifier);
 * every role is pinned to its own `presetId` and optional model route, and
 * carries a `roleTask` statement delivered on each of its turns.
 */
/** One structured task in a role's task list. */
export declare const TaskSchema: z<Schemastery.ObjectS<{
    id: z<string, string>;
    title: z<string, string>;
    description: z<string, string>;
    acceptanceCriteria: z<string, string>;
    status: z<"pending" | "in_progress" | "done" | "failed" | "blocked", "pending" | "in_progress" | "done" | "failed" | "blocked">;
}>, Schemastery.ObjectT<{
    id: z<string, string>;
    title: z<string, string>;
    description: z<string, string>;
    acceptanceCriteria: z<string, string>;
    status: z<"pending" | "in_progress" | "done" | "failed" | "blocked", "pending" | "in_progress" | "done" | "failed" | "blocked">;
}>>;
export type Task = ReturnType<typeof TaskSchema>;
/** A crew role's per-role model-route override (the request-level knob). */
export declare const RoleAgentOptionsSchema: z<Schemastery.ObjectS<{
    provider: z<string, string>;
    model: z<string, string>;
    maxTokens: z<number, number>;
}>, Schemastery.ObjectT<{
    provider: z<string, string>;
    model: z<string, string>;
    maxTokens: z<number, number>;
}>>;
/** One role in a crew. */
export declare const CrewRoleSchema: z<Schemastery.ObjectS<{
    name: z<string, string>;
    presetId: z<string, string>;
    agentOptions: z<Schemastery.ObjectS<{
        provider: z<string, string>;
        model: z<string, string>;
        maxTokens: z<number, number>;
    }>, Schemastery.ObjectT<{
        provider: z<string, string>;
        model: z<string, string>;
        maxTokens: z<number, number>;
    }>>;
    provider: z<string, string>;
    model: z<string, string>;
    maxTokens: z<number, number>;
    toolFilter: z<Schemastery.ObjectS<{
        allow: z<string[], string[]>;
        deny: z<string[], string[]>;
    }>, Schemastery.ObjectT<{
        allow: z<string[], string[]>;
        deny: z<string[], string[]>;
    }>>;
    roleTask: z<string, string>;
    description: z<string, string>;
    tasks: z<({
        id?: string | null | undefined;
        title?: string | null | undefined;
        description?: string | null | undefined;
        acceptanceCriteria?: string | null | undefined;
        status?: "pending" | "in_progress" | "done" | "failed" | "blocked" | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        id: z<string, string>;
        title: z<string, string>;
        description: z<string, string>;
        acceptanceCriteria: z<string, string>;
        status: z<"pending" | "in_progress" | "done" | "failed" | "blocked", "pending" | "in_progress" | "done" | "failed" | "blocked">;
    }>[]>;
}>, Schemastery.ObjectT<{
    name: z<string, string>;
    presetId: z<string, string>;
    agentOptions: z<Schemastery.ObjectS<{
        provider: z<string, string>;
        model: z<string, string>;
        maxTokens: z<number, number>;
    }>, Schemastery.ObjectT<{
        provider: z<string, string>;
        model: z<string, string>;
        maxTokens: z<number, number>;
    }>>;
    provider: z<string, string>;
    model: z<string, string>;
    maxTokens: z<number, number>;
    toolFilter: z<Schemastery.ObjectS<{
        allow: z<string[], string[]>;
        deny: z<string[], string[]>;
    }>, Schemastery.ObjectT<{
        allow: z<string[], string[]>;
        deny: z<string[], string[]>;
    }>>;
    roleTask: z<string, string>;
    description: z<string, string>;
    tasks: z<({
        id?: string | null | undefined;
        title?: string | null | undefined;
        description?: string | null | undefined;
        acceptanceCriteria?: string | null | undefined;
        status?: "pending" | "in_progress" | "done" | "failed" | "blocked" | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        id: z<string, string>;
        title: z<string, string>;
        description: z<string, string>;
        acceptanceCriteria: z<string, string>;
        status: z<"pending" | "in_progress" | "done" | "failed" | "blocked", "pending" | "in_progress" | "done" | "failed" | "blocked">;
    }>[]>;
}>>;
export declare const CrewPipelineSchema: z<Schemastery.ObjectS<{
    order: z<string[], string[]>;
    verifyGate: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        verifierRole: z<string, string>;
        maxRetries: z<number, number>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        verifierRole: z<string, string>;
        maxRetries: z<number, number>;
    }>>;
}>, Schemastery.ObjectT<{
    order: z<string[], string[]>;
    verifyGate: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        verifierRole: z<string, string>;
        maxRetries: z<number, number>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        verifierRole: z<string, string>;
        maxRetries: z<number, number>;
    }>>;
}>>;
export declare const CrewSchema: z<Schemastery.ObjectS<{
    orchestratorRole: z<string, string>;
    mode: z<"routed" | "pipeline", "routed" | "pipeline">;
    roles: z<({
        name?: string | null | undefined;
        presetId?: string | null | undefined;
        agentOptions?: ({
            provider?: string | null | undefined;
            model?: string | null | undefined;
            maxTokens?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
        provider?: string | null | undefined;
        model?: string | null | undefined;
        maxTokens?: number | null | undefined;
        toolFilter?: ({
            allow?: string[] | null | undefined;
            deny?: string[] | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
        roleTask?: string | null | undefined;
        description?: string | null | undefined;
        tasks?: ({
            id?: string | null | undefined;
            title?: string | null | undefined;
            description?: string | null | undefined;
            acceptanceCriteria?: string | null | undefined;
            status?: "pending" | "in_progress" | "done" | "failed" | "blocked" | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[] | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        name: z<string, string>;
        presetId: z<string, string>;
        agentOptions: z<Schemastery.ObjectS<{
            provider: z<string, string>;
            model: z<string, string>;
            maxTokens: z<number, number>;
        }>, Schemastery.ObjectT<{
            provider: z<string, string>;
            model: z<string, string>;
            maxTokens: z<number, number>;
        }>>;
        provider: z<string, string>;
        model: z<string, string>;
        maxTokens: z<number, number>;
        toolFilter: z<Schemastery.ObjectS<{
            allow: z<string[], string[]>;
            deny: z<string[], string[]>;
        }>, Schemastery.ObjectT<{
            allow: z<string[], string[]>;
            deny: z<string[], string[]>;
        }>>;
        roleTask: z<string, string>;
        description: z<string, string>;
        tasks: z<({
            id?: string | null | undefined;
            title?: string | null | undefined;
            description?: string | null | undefined;
            acceptanceCriteria?: string | null | undefined;
            status?: "pending" | "in_progress" | "done" | "failed" | "blocked" | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
            id: z<string, string>;
            title: z<string, string>;
            description: z<string, string>;
            acceptanceCriteria: z<string, string>;
            status: z<"pending" | "in_progress" | "done" | "failed" | "blocked", "pending" | "in_progress" | "done" | "failed" | "blocked">;
        }>[]>;
    }>[]>;
    pipeline: z<Schemastery.ObjectS<{
        order: z<string[], string[]>;
        verifyGate: z<Schemastery.ObjectS<{
            enabled: z<boolean, boolean>;
            verifierRole: z<string, string>;
            maxRetries: z<number, number>;
        }>, Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
            verifierRole: z<string, string>;
            maxRetries: z<number, number>;
        }>>;
    }>, Schemastery.ObjectT<{
        order: z<string[], string[]>;
        verifyGate: z<Schemastery.ObjectS<{
            enabled: z<boolean, boolean>;
            verifierRole: z<string, string>;
            maxRetries: z<number, number>;
        }>, Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
            verifierRole: z<string, string>;
            maxRetries: z<number, number>;
        }>>;
    }>>;
}>, Schemastery.ObjectT<{
    orchestratorRole: z<string, string>;
    mode: z<"routed" | "pipeline", "routed" | "pipeline">;
    roles: z<({
        name?: string | null | undefined;
        presetId?: string | null | undefined;
        agentOptions?: ({
            provider?: string | null | undefined;
            model?: string | null | undefined;
            maxTokens?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
        provider?: string | null | undefined;
        model?: string | null | undefined;
        maxTokens?: number | null | undefined;
        toolFilter?: ({
            allow?: string[] | null | undefined;
            deny?: string[] | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
        roleTask?: string | null | undefined;
        description?: string | null | undefined;
        tasks?: ({
            id?: string | null | undefined;
            title?: string | null | undefined;
            description?: string | null | undefined;
            acceptanceCriteria?: string | null | undefined;
            status?: "pending" | "in_progress" | "done" | "failed" | "blocked" | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[] | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        name: z<string, string>;
        presetId: z<string, string>;
        agentOptions: z<Schemastery.ObjectS<{
            provider: z<string, string>;
            model: z<string, string>;
            maxTokens: z<number, number>;
        }>, Schemastery.ObjectT<{
            provider: z<string, string>;
            model: z<string, string>;
            maxTokens: z<number, number>;
        }>>;
        provider: z<string, string>;
        model: z<string, string>;
        maxTokens: z<number, number>;
        toolFilter: z<Schemastery.ObjectS<{
            allow: z<string[], string[]>;
            deny: z<string[], string[]>;
        }>, Schemastery.ObjectT<{
            allow: z<string[], string[]>;
            deny: z<string[], string[]>;
        }>>;
        roleTask: z<string, string>;
        description: z<string, string>;
        tasks: z<({
            id?: string | null | undefined;
            title?: string | null | undefined;
            description?: string | null | undefined;
            acceptanceCriteria?: string | null | undefined;
            status?: "pending" | "in_progress" | "done" | "failed" | "blocked" | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
            id: z<string, string>;
            title: z<string, string>;
            description: z<string, string>;
            acceptanceCriteria: z<string, string>;
            status: z<"pending" | "in_progress" | "done" | "failed" | "blocked", "pending" | "in_progress" | "done" | "failed" | "blocked">;
        }>[]>;
    }>[]>;
    pipeline: z<Schemastery.ObjectS<{
        order: z<string[], string[]>;
        verifyGate: z<Schemastery.ObjectS<{
            enabled: z<boolean, boolean>;
            verifierRole: z<string, string>;
            maxRetries: z<number, number>;
        }>, Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
            verifierRole: z<string, string>;
            maxRetries: z<number, number>;
        }>>;
    }>, Schemastery.ObjectT<{
        order: z<string[], string[]>;
        verifyGate: z<Schemastery.ObjectS<{
            enabled: z<boolean, boolean>;
            verifierRole: z<string, string>;
            maxRetries: z<number, number>;
        }>, Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
            verifierRole: z<string, string>;
            maxRetries: z<number, number>;
        }>>;
    }>>;
}>>;
export declare const CrewsSchema: z<import("@deepseek-ai/cosmokit").Dict<{
    orchestratorRole?: string | null | undefined;
    mode?: "routed" | "pipeline" | null | undefined;
    roles?: ({
        name?: string | null | undefined;
        presetId?: string | null | undefined;
        agentOptions?: ({
            provider?: string | null | undefined;
            model?: string | null | undefined;
            maxTokens?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
        provider?: string | null | undefined;
        model?: string | null | undefined;
        maxTokens?: number | null | undefined;
        toolFilter?: ({
            allow?: string[] | null | undefined;
            deny?: string[] | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
        roleTask?: string | null | undefined;
        description?: string | null | undefined;
        tasks?: ({
            id?: string | null | undefined;
            title?: string | null | undefined;
            description?: string | null | undefined;
            acceptanceCriteria?: string | null | undefined;
            status?: "pending" | "in_progress" | "done" | "failed" | "blocked" | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[] | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict)[] | null | undefined;
    pipeline?: ({
        order?: string[] | null | undefined;
        verifyGate?: ({
            enabled?: boolean | null | undefined;
            verifierRole?: string | null | undefined;
            maxRetries?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
} & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
    orchestratorRole: z<string, string>;
    mode: z<"routed" | "pipeline", "routed" | "pipeline">;
    roles: z<({
        name?: string | null | undefined;
        presetId?: string | null | undefined;
        agentOptions?: ({
            provider?: string | null | undefined;
            model?: string | null | undefined;
            maxTokens?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
        provider?: string | null | undefined;
        model?: string | null | undefined;
        maxTokens?: number | null | undefined;
        toolFilter?: ({
            allow?: string[] | null | undefined;
            deny?: string[] | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
        roleTask?: string | null | undefined;
        description?: string | null | undefined;
        tasks?: ({
            id?: string | null | undefined;
            title?: string | null | undefined;
            description?: string | null | undefined;
            acceptanceCriteria?: string | null | undefined;
            status?: "pending" | "in_progress" | "done" | "failed" | "blocked" | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[] | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        name: z<string, string>;
        presetId: z<string, string>;
        agentOptions: z<Schemastery.ObjectS<{
            provider: z<string, string>;
            model: z<string, string>;
            maxTokens: z<number, number>;
        }>, Schemastery.ObjectT<{
            provider: z<string, string>;
            model: z<string, string>;
            maxTokens: z<number, number>;
        }>>;
        provider: z<string, string>;
        model: z<string, string>;
        maxTokens: z<number, number>;
        toolFilter: z<Schemastery.ObjectS<{
            allow: z<string[], string[]>;
            deny: z<string[], string[]>;
        }>, Schemastery.ObjectT<{
            allow: z<string[], string[]>;
            deny: z<string[], string[]>;
        }>>;
        roleTask: z<string, string>;
        description: z<string, string>;
        tasks: z<({
            id?: string | null | undefined;
            title?: string | null | undefined;
            description?: string | null | undefined;
            acceptanceCriteria?: string | null | undefined;
            status?: "pending" | "in_progress" | "done" | "failed" | "blocked" | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
            id: z<string, string>;
            title: z<string, string>;
            description: z<string, string>;
            acceptanceCriteria: z<string, string>;
            status: z<"pending" | "in_progress" | "done" | "failed" | "blocked", "pending" | "in_progress" | "done" | "failed" | "blocked">;
        }>[]>;
    }>[]>;
    pipeline: z<Schemastery.ObjectS<{
        order: z<string[], string[]>;
        verifyGate: z<Schemastery.ObjectS<{
            enabled: z<boolean, boolean>;
            verifierRole: z<string, string>;
            maxRetries: z<number, number>;
        }>, Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
            verifierRole: z<string, string>;
            maxRetries: z<number, number>;
        }>>;
    }>, Schemastery.ObjectT<{
        order: z<string[], string[]>;
        verifyGate: z<Schemastery.ObjectS<{
            enabled: z<boolean, boolean>;
            verifierRole: z<string, string>;
            maxRetries: z<number, number>;
        }>, Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
            verifierRole: z<string, string>;
            maxRetries: z<number, number>;
        }>>;
    }>>;
}>, string>>;
/**
 * The plugin's composition-time `Config` (same shape as the settings schema).
 *
 * `provider`/`model`/`maxTokens` are the DEFAULT child route. A request-level
 * `agentOptions` — on a `tool-subagent` row, on a direct `ctx.subagents.start()`
 * call, or on a crew role — overrides them field by field (see `src/route.ts`).
 */
export declare const Config: z<Schemastery.ObjectS<{
    providerName: z<string, string>;
    presetId: z<string, string>;
    provider: z<string, string>;
    model: z<string, string>;
    maxTokens: z<number, number>;
    maxDepth: z<number | "provider-managed", number | "provider-managed">;
    crews: z<import("@deepseek-ai/cosmokit").Dict<{
        orchestratorRole?: string | null | undefined;
        mode?: "routed" | "pipeline" | null | undefined;
        roles?: ({
            name?: string | null | undefined;
            presetId?: string | null | undefined;
            agentOptions?: ({
                provider?: string | null | undefined;
                model?: string | null | undefined;
                maxTokens?: number | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            provider?: string | null | undefined;
            model?: string | null | undefined;
            maxTokens?: number | null | undefined;
            toolFilter?: ({
                allow?: string[] | null | undefined;
                deny?: string[] | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            roleTask?: string | null | undefined;
            description?: string | null | undefined;
            tasks?: ({
                id?: string | null | undefined;
                title?: string | null | undefined;
                description?: string | null | undefined;
                acceptanceCriteria?: string | null | undefined;
                status?: "pending" | "in_progress" | "done" | "failed" | "blocked" | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict)[] | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[] | null | undefined;
        pipeline?: ({
            order?: string[] | null | undefined;
            verifyGate?: ({
                enabled?: boolean | null | undefined;
                verifierRole?: string | null | undefined;
                maxRetries?: number | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
        orchestratorRole: z<string, string>;
        mode: z<"routed" | "pipeline", "routed" | "pipeline">;
        roles: z<({
            name?: string | null | undefined;
            presetId?: string | null | undefined;
            agentOptions?: ({
                provider?: string | null | undefined;
                model?: string | null | undefined;
                maxTokens?: number | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            provider?: string | null | undefined;
            model?: string | null | undefined;
            maxTokens?: number | null | undefined;
            toolFilter?: ({
                allow?: string[] | null | undefined;
                deny?: string[] | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            roleTask?: string | null | undefined;
            description?: string | null | undefined;
            tasks?: ({
                id?: string | null | undefined;
                title?: string | null | undefined;
                description?: string | null | undefined;
                acceptanceCriteria?: string | null | undefined;
                status?: "pending" | "in_progress" | "done" | "failed" | "blocked" | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict)[] | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
            name: z<string, string>;
            presetId: z<string, string>;
            agentOptions: z<Schemastery.ObjectS<{
                provider: z<string, string>;
                model: z<string, string>;
                maxTokens: z<number, number>;
            }>, Schemastery.ObjectT<{
                provider: z<string, string>;
                model: z<string, string>;
                maxTokens: z<number, number>;
            }>>;
            provider: z<string, string>;
            model: z<string, string>;
            maxTokens: z<number, number>;
            toolFilter: z<Schemastery.ObjectS<{
                allow: z<string[], string[]>;
                deny: z<string[], string[]>;
            }>, Schemastery.ObjectT<{
                allow: z<string[], string[]>;
                deny: z<string[], string[]>;
            }>>;
            roleTask: z<string, string>;
            description: z<string, string>;
            tasks: z<({
                id?: string | null | undefined;
                title?: string | null | undefined;
                description?: string | null | undefined;
                acceptanceCriteria?: string | null | undefined;
                status?: "pending" | "in_progress" | "done" | "failed" | "blocked" | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
                id: z<string, string>;
                title: z<string, string>;
                description: z<string, string>;
                acceptanceCriteria: z<string, string>;
                status: z<"pending" | "in_progress" | "done" | "failed" | "blocked", "pending" | "in_progress" | "done" | "failed" | "blocked">;
            }>[]>;
        }>[]>;
        pipeline: z<Schemastery.ObjectS<{
            order: z<string[], string[]>;
            verifyGate: z<Schemastery.ObjectS<{
                enabled: z<boolean, boolean>;
                verifierRole: z<string, string>;
                maxRetries: z<number, number>;
            }>, Schemastery.ObjectT<{
                enabled: z<boolean, boolean>;
                verifierRole: z<string, string>;
                maxRetries: z<number, number>;
            }>>;
        }>, Schemastery.ObjectT<{
            order: z<string[], string[]>;
            verifyGate: z<Schemastery.ObjectS<{
                enabled: z<boolean, boolean>;
                verifierRole: z<string, string>;
                maxRetries: z<number, number>;
            }>, Schemastery.ObjectT<{
                enabled: z<boolean, boolean>;
                verifierRole: z<string, string>;
                maxRetries: z<number, number>;
            }>>;
        }>>;
    }>, string>>;
}>, Schemastery.ObjectT<{
    providerName: z<string, string>;
    presetId: z<string, string>;
    provider: z<string, string>;
    model: z<string, string>;
    maxTokens: z<number, number>;
    maxDepth: z<number | "provider-managed", number | "provider-managed">;
    crews: z<import("@deepseek-ai/cosmokit").Dict<{
        orchestratorRole?: string | null | undefined;
        mode?: "routed" | "pipeline" | null | undefined;
        roles?: ({
            name?: string | null | undefined;
            presetId?: string | null | undefined;
            agentOptions?: ({
                provider?: string | null | undefined;
                model?: string | null | undefined;
                maxTokens?: number | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            provider?: string | null | undefined;
            model?: string | null | undefined;
            maxTokens?: number | null | undefined;
            toolFilter?: ({
                allow?: string[] | null | undefined;
                deny?: string[] | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            roleTask?: string | null | undefined;
            description?: string | null | undefined;
            tasks?: ({
                id?: string | null | undefined;
                title?: string | null | undefined;
                description?: string | null | undefined;
                acceptanceCriteria?: string | null | undefined;
                status?: "pending" | "in_progress" | "done" | "failed" | "blocked" | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict)[] | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[] | null | undefined;
        pipeline?: ({
            order?: string[] | null | undefined;
            verifyGate?: ({
                enabled?: boolean | null | undefined;
                verifierRole?: string | null | undefined;
                maxRetries?: number | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
        orchestratorRole: z<string, string>;
        mode: z<"routed" | "pipeline", "routed" | "pipeline">;
        roles: z<({
            name?: string | null | undefined;
            presetId?: string | null | undefined;
            agentOptions?: ({
                provider?: string | null | undefined;
                model?: string | null | undefined;
                maxTokens?: number | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            provider?: string | null | undefined;
            model?: string | null | undefined;
            maxTokens?: number | null | undefined;
            toolFilter?: ({
                allow?: string[] | null | undefined;
                deny?: string[] | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            roleTask?: string | null | undefined;
            description?: string | null | undefined;
            tasks?: ({
                id?: string | null | undefined;
                title?: string | null | undefined;
                description?: string | null | undefined;
                acceptanceCriteria?: string | null | undefined;
                status?: "pending" | "in_progress" | "done" | "failed" | "blocked" | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict)[] | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
            name: z<string, string>;
            presetId: z<string, string>;
            agentOptions: z<Schemastery.ObjectS<{
                provider: z<string, string>;
                model: z<string, string>;
                maxTokens: z<number, number>;
            }>, Schemastery.ObjectT<{
                provider: z<string, string>;
                model: z<string, string>;
                maxTokens: z<number, number>;
            }>>;
            provider: z<string, string>;
            model: z<string, string>;
            maxTokens: z<number, number>;
            toolFilter: z<Schemastery.ObjectS<{
                allow: z<string[], string[]>;
                deny: z<string[], string[]>;
            }>, Schemastery.ObjectT<{
                allow: z<string[], string[]>;
                deny: z<string[], string[]>;
            }>>;
            roleTask: z<string, string>;
            description: z<string, string>;
            tasks: z<({
                id?: string | null | undefined;
                title?: string | null | undefined;
                description?: string | null | undefined;
                acceptanceCriteria?: string | null | undefined;
                status?: "pending" | "in_progress" | "done" | "failed" | "blocked" | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
                id: z<string, string>;
                title: z<string, string>;
                description: z<string, string>;
                acceptanceCriteria: z<string, string>;
                status: z<"pending" | "in_progress" | "done" | "failed" | "blocked", "pending" | "in_progress" | "done" | "failed" | "blocked">;
            }>[]>;
        }>[]>;
        pipeline: z<Schemastery.ObjectS<{
            order: z<string[], string[]>;
            verifyGate: z<Schemastery.ObjectS<{
                enabled: z<boolean, boolean>;
                verifierRole: z<string, string>;
                maxRetries: z<number, number>;
            }>, Schemastery.ObjectT<{
                enabled: z<boolean, boolean>;
                verifierRole: z<string, string>;
                maxRetries: z<number, number>;
            }>>;
        }>, Schemastery.ObjectT<{
            order: z<string[], string[]>;
            verifyGate: z<Schemastery.ObjectS<{
                enabled: z<boolean, boolean>;
                verifierRole: z<string, string>;
                maxRetries: z<number, number>;
            }>, Schemastery.ObjectT<{
                enabled: z<boolean, boolean>;
                verifierRole: z<string, string>;
                maxRetries: z<number, number>;
            }>>;
        }>>;
    }>, string>>;
}>>;
export type Config = ReturnType<typeof Config>;
