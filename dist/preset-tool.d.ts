/**
 * The plugin-owned delegation tool whose `preset` argument selects the
 * composition a child is composed under.
 *
 * WHY A SEPARATE TOOL. The shipped `tool-subagent` consumer cannot express "use
 * preset X" per call: its schema exposes only `description`/`prompt`/
 * `run_in_background` (plus the optional model-selection triple), and
 * `SubagentStartRequest` carries no `presetId` on an unpatched harness. A
 * `tool-subagent` row therefore pins exactly the one preset its `provider`
 * instance was registered with, which is why the PRESET had to be a deployment
 * setting rather than a call argument.
 *
 * THE MECHANISM. `ctx.subagents` is a provider REGISTRY, not a single provider,
 * and the provider NAME is the one thing a caller may select per delegation. So
 * this plugin registers one provider instance per configured preset (`preset`,
 * `preset:<name>`) and this tool maps the `preset` argument to a registry name.
 * No harness change, no capability flag, and the same start paths the shipped
 * consumer uses.
 *
 * @module @dsh-subagent-preset-in-process/preset-tool
 */
import type { Context } from '@deepseek-ai/cordis';
import { type RouteOverrides } from './route.js';
import type { Config } from './config.js';
/** One selectable preset, resolved at call time. */
export interface PresetChoice {
    /** The registry name of the provider instance that composes this preset. */
    readonly providerName: string;
    /** The agent preset id it composes. */
    readonly presetId: string;
    /** Optional model-facing hint for when to choose it. */
    readonly description?: string;
    /**
     * The route THIS choice pins, entry-aware: a named preset's `provider`/`model`
     * wins over the plugin's top-level ones. Read per call so a Settings edit
     * applies to the next delegation without a restart.
     */
    readonly route: () => RouteOverrides;
}
/** Dependencies the tool reads; injected so tests need no live harness. */
export interface PresetToolDeps {
    /** Model-facing tool name. */
    readonly toolName: string;
    /** Live resolved plugin config. */
    readonly readConfig: () => Config;
    /** The selectable presets, in registration order. */
    readonly choices: () => readonly PresetChoice[];
}
/** A rendered delegation result; both shapes are plain, lossless JSON. */
export interface DelegationResult {
    readonly kind: 'continuable' | 'foreground';
    /** Present when `kind` is `continuable`. */
    readonly subagentId?: string;
    /** Present when `kind` is `foreground`. */
    readonly runId?: string;
    /** The child's closing output, joined to text. Present when `foreground`. */
    readonly text?: string;
}
/**
 * Resolve the `preset` argument to a registry name.
 *
 * Validated at CALL time rather than expressed as a schema `enum` on purpose:
 * the schema is part of every caller's request prefix, so baking the preset
 * names into it would make adding one preset silently invalidate the cached
 * prefix of every session that mounts this tool. A call-time check fails loud
 * with the valid names instead.
 * @param name - the caller's `preset` argument, or undefined for the default.
 * @param config - live resolved plugin config.
 * @returns the registry name of the provider instance to use.
 * @throws when the name is not a configured preset.
 */
export declare function providerNameFor(name: string | undefined, config: Config): string;
/**
 * Register the preset-selecting delegation tool.
 *
 * Registration is effect-scoped: unload removes the tool with the plugin. The
 * tool registers on the GLOBAL tool layer (this plugin is a host-plane bundle
 * row), so every agent — including agents nested several levels deep — can call
 * it. That is what makes a shared tool agent addressable from anywhere in the
 * tree without widening the adjacent-agent messaging authority.
 * @param ctx - the plugin's context.
 * @param deps - tool name, live config, and the selectable presets.
 * @returns a disposer.
 */
export declare function registerPresetTool(ctx: Context, deps: PresetToolDeps): () => void;
