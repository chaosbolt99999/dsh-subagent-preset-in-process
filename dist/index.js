import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { Config } from './config.js';
import { PresetInProcessProvider } from './provider.js';
import { CrewService } from './crew.js';
import { registerCrewTools } from './crew-tools.js';
export const name = 'subagent-preset-in-process';
export const inject = ['subagents', 'agents', 'tools'];
export const SETTINGS_NAMESPACE = settingsNamespace('subagent-preset-in-process');
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
    // Each `ctx.tools.register` is effect-scoped and auto-disposed on unload.
    registerCrewTools(ctx, crews);
    // Settings namespace: editable in Settings → Plugins. `base` carries the
    // composition config and `setSource`/`onChange` wire live re-resolution.
    installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, {
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
