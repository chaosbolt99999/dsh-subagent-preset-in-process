import { Config } from './config.js';
import { PresetInProcessProvider } from './provider.js';
import { installPinning } from './pin.js';
import { CrewService } from './crew.js';
import { registerCrewTools } from './crew-tools.js';
export const name = 'subagent-preset-in-process';
export const inject = ['subagents', 'agents', 'tools'];
/**
 * The settings namespace this plugin owns — a plain lowercase-kebab-case string.
 * Earlier harness generations branded these with a `settingsNamespace()` helper
 * and validated the brand; current generations validate the string itself, so
 * the literal is the one form both accept.
 */
export const SETTINGS_NAMESPACE = 'subagent-preset-in-process';
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
export function installSettings(ctx, ns, schema, entry, hooks) {
    ctx.inject(['settings'], (settingsCtx) => {
        const settings = settingsCtx.get('settings');
        if (settings === undefined)
            return;
        if (typeof settings.installSection === 'function') {
            settings.installSection(ctx, ns, schema, entry, hooks);
            return;
        }
        void import('@deepseek-ai/dsh-settings').then((mod) => {
            const legacy = mod.installSettingsSection;
            if (typeof legacy === 'function') {
                legacy(ctx, ns, schema, entry, hooks);
                return;
            }
            ctx.logger?.warn?.(`${name}: this harness exposes neither settings.installSection() nor installSettingsSection();`
                + ' the Settings → Plugins section for this plugin is unavailable and the composition config stays in force.');
        });
    });
}
export { Config };
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
export function apply(ctx, config) {
    // Live resolved config: settings layer over the composition base. Children
    // read it at start time, so a settings change applies to the next child.
    let current = config;
    ctx.subagents.registerProvider(new PresetInProcessProvider(config.providerName, () => ({ ...current, providerName: current.providerName ?? 'preset' })));
    // `super(ctx, 'crews')` registers the service and auto-removes it on unload.
    const crews = new CrewService(ctx, () => current);
    // Preset pinning for the CONTINUABLE path. The continuation manager owns a
    // background child's creation, so the pinned preset cannot be chosen there by
    // a provider; these listeners re-link the child onto it before its first
    // request. Owned by `ctx.effect` so unload removes both listeners.
    ctx.effect(() => installPinning(ctx, {
        providerName: config.providerName,
        readConfig: () => current,
    }), 'subagent-preset-in-process.pinning');
    // Each `ctx.tools.register` is effect-scoped and auto-disposed on unload.
    registerCrewTools(ctx, crews);
    // Settings namespace: editable in Settings → Plugins. `base` carries the
    // composition config and `setSource`/`onChange` wire live re-resolution.
    installSettings(ctx, SETTINGS_NAMESPACE, Config, config, {
        setSource: (get) => {
            current = get();
        },
        onChange: () => {
            // Resolved value already captured by setSource. Role/task definitions are
            // re-read from `current` on the next materialize(), so adding a crew or
            // editing role pins through Settings takes effect on the next
            // materialize — but `CrewService` intentionally keeps its constructor
            // crew set, so renaming/removing crews still needs a restart. Live crew
            // definitions ARE picked up here for crews the service already knows.
            crews.reloadCrews(current.crews ?? {});
        },
    });
}
