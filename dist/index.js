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
 * Wire this plugin's settings section.
 *
 * `settings.installSection(owner, ns, schema, entry, hooks)` is the current
 * seam and the only one this package targets. The cast is purely about this
 * package's VENDORED `@deepseek-ai/dsh-settings` being a generation behind (it
 * exports a free `installSettingsSection()` and has no method on the service) —
 * reach the real API rather than a shim.
 * @param ctx - the plugin's context.
 * @param ns - the namespace to own.
 * @param schema - the section schema.
 * @param entry - the composition-layer value used as `base`.
 * @param hooks - source sink and change notification.
 */
export function installSettings(ctx, ns, schema, entry, hooks) {
    ctx.inject(['settings'], (settingsCtx) => {
        const settings = settingsCtx.get('settings');
        settings.installSection(ctx, ns, schema, entry, hooks);
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
