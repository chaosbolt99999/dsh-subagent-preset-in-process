import type { Context } from '@deepseek-ai/cordis';
import { Config, type Config as ConfigType } from './config.js';
import { PresetInProcessProvider } from './provider.js';
import { CrewService } from './crew.js';
export declare const name = "subagent-preset-in-process";
export declare const inject: string[];
/**
 * The settings namespace this plugin owns — a plain lowercase-kebab-case string.
 * Earlier harness generations branded these with a `settingsNamespace()` helper
 * and validated the brand; current generations validate the string itself, so
 * the literal is the one form both accept.
 */
export declare const SETTINGS_NAMESPACE = "subagent-preset-in-process";
/** Consumer hooks for one settings section, structurally typed. */
interface SectionHooks<T> {
    setSource(get: () => T): void;
    onChange(): void;
}
/**
 * Wire one settings section, across harness generations.
 *
 * The harness MOVED this seam: earlier generations exported a free
 * `installSettingsSection()` plus a `settingsNamespace()` brand and had no such
 * method on the service; current generations expose
 * `settings.installSection(owner, ns, schema, entry, hooks)` and export neither
 * function. A plugin that statically imports either name therefore fails to LOAD
 * on the other generation — the whole profile refuses to boot with "does not
 * provide an export named …", which is exactly what this plugin did against
 * master (0.1.5) while it still imported the old helpers.
 *
 * So the service method is preferred, the old free helper is reached through a
 * DYNAMIC import (a missing name resolves to `undefined` there instead of
 * aborting the module), and neither being present is REPORTED rather than fatal:
 * a plugin without a settings card is still a working plugin.
 * @param ctx - the plugin's context.
 * @param ns - the namespace to own.
 * @param schema - the section schema.
 * @param entry - the composition-layer value used as `base`.
 * @param hooks - source sink and change notification.
 */
export declare function installSettings<T>(ctx: Context, ns: string, schema: unknown, entry: T, hooks: SectionHooks<T>): void;
export { Config };
export type { ConfigType };
export { PresetInProcessProvider };
export { CrewService };
/**
 * Register the preset-pinning subagent backend under `config.providerName`,
 * plus a named-crew service (`ctx.crews`) that materializes role-bound
 * continuable members and routes handoffs between them. Both consume a live
 * resolved config (composition base + the `subagent-preset-in-process`
 * settings namespace), so Web-UI edits take effect on later children without
 * a restart. Registration is effect-scoped: a duplicate provider name throws,
 * and removal blocks new starts without revoking already-returned runs.
 */
export declare function apply(ctx: Context, config: ConfigType): void;
