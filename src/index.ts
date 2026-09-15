import type { Context } from '@deepseek-ai/cordis'
// Type-only: brings the `settings` service into the Context augmentation used by
// `installSettings` below. Importing no VALUE from this package is deliberate.
import type {} from '@deepseek-ai/dsh-settings'
import { Config, type Config as ConfigType } from './config.js'
import { PresetInProcessProvider } from './provider.js'
import { installPinning, type PinDeps } from './pin.js'
import { CrewService } from './crew.js'
import { registerCrewTools } from './crew-tools.js'
import { registerPresetTool, type PresetChoice } from './preset-tool.js'

export const name = 'subagent-preset-in-process'
export const inject = ['subagents', 'agents', 'tools']

/**
 * The settings namespace this plugin owns — a plain lowercase-kebab-case string.
 * Earlier harness generations branded these with a `settingsNamespace()` helper
 * and validated the brand; current generations validate the string itself, so
 * the literal is the one form both accept.
 */
export const SETTINGS_NAMESPACE = 'subagent-preset-in-process'

/** Consumer hooks for one settings section, structurally typed. */
interface SectionHooks<T> {
  setSource(get: () => T): void
  onChange(): void
}

/** The settings method this plugin uses. */
interface SettingsWithSection {
  installSection(owner: Context, ns: string, schema: unknown, entry: unknown, hooks: SectionHooks<never>): void
}

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
export function installSettings<T>(
  ctx: Context,
  ns: string,
  schema: unknown,
  entry: T,
  hooks: SectionHooks<T>,
): void {
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = (settingsCtx as Context).get('settings') as unknown as SettingsWithSection
    settings.installSection(ctx, ns, schema, entry, hooks as unknown as SectionHooks<never>)
  })
}

export { Config }
export type { ConfigType }
export { PresetInProcessProvider }
export { CrewService }

/**
 * Register the preset-pinning subagent backend under `config.providerName`,
 * plus a named-crew service (`ctx.crews`) that materializes role-bound
 * continuable members and routes handoffs between them. Both consume a live
 * resolved config (composition base + the `subagent-preset-in-process`
 * settings namespace), so Web-UI edits take effect on later children without
 * a restart. Registration is effect-scoped: a duplicate provider name throws,
 * and removal blocks new starts without revoking already-returned runs.
 */
export function apply(ctx: Context, config: ConfigType): void {
  // Live resolved config: settings layer over the composition base. Children
  // read it at start time, so a settings change applies to the next child.
  let current: ConfigType = config

  // One provider instance per preset. `ctx.subagents` is a REGISTRY and the
  // provider NAME is the one thing a caller selects per delegation, so "pick the
  // preset in the tool call" is expressed as "pick the provider". The default
  // instance keeps `config.providerName` so existing rows and direct
  // `ctx.subagents.start()` calls resolve exactly as before.
  const baseName = config.providerName ?? 'preset'
  const providerFor = (preset: string | undefined): string =>
    preset === undefined || preset === '' ? baseName : `${baseName}:${preset}`

  const defaultProvider = new PresetInProcessProvider(
    baseName,
    () => ({ ...current, providerName: current.providerName ?? 'preset' }),
  )
  ctx.subagents.registerProvider(defaultProvider)

  const instances = new Map<string, PresetInProcessProvider>()
  for (const preset of Object.keys(current.presets ?? {})) {
    const instance = new PresetInProcessProvider(
      providerFor(preset),
      () => ({ ...current, providerName: current.providerName ?? 'preset' }),
      preset,
    )
    instances.set(preset, instance)
    ctx.subagents.registerProvider(instance)
  }

  // `super(ctx, 'crews')` registers the service and auto-removes it on unload.
  const crews = new CrewService(ctx, () => current)

  // Preset AND route pinning for the CONTINUABLE path. The continuation manager
  // owns a background child's creation, so neither the pinned preset nor the
  // pinned route can be chosen there by a provider: an unpatched harness keeps
  // only `seed` from `ContinuableCreateSpec` and discards the rest. These
  // listeners re-link the child onto its preset and replace its call
  // configuration before the next request. One entry per provider instance, so
  // a child's own descriptor identifies which instance owns it.
  const pinDeps: PinDeps[] = [
    {
      providerName: baseName,
      readConfig: () => ({ presetId: defaultProvider.view().presetId, crews: current.crews }),
      route: () => defaultProvider.route(),
    },
    ...[...instances.entries()].map(([preset, instance]) => ({
      providerName: providerFor(preset),
      readConfig: () => ({ presetId: instance.view().presetId, crews: current.crews }),
      route: () => instance.route(),
    })),
  ]
  ctx.effect(() => installPinning(ctx, pinDeps), 'subagent-preset-in-process.pinning')

  // The preset-selecting delegation tool. It owns the `preset` argument that the
  // shipped `tool-subagent` consumer cannot express, and it is what makes a
  // shared tool agent addressable from any depth without touching the
  // adjacent-agent messaging authority.
  if (current.presetTool?.enabled !== false) {
    const choices = (): PresetChoice[] => [
      { providerName: baseName, presetId: defaultProvider.view().presetId },
      ...[...instances.entries()].map(([preset, instance]) => ({
        providerName: providerFor(preset),
        presetId: instance.view().presetId,
      })),
    ]
    ctx.effect(() => registerPresetTool(ctx, {
      toolName: current.presetTool?.toolName ?? 'subagent_preset',
      readConfig: () => current,
      choices,
    }), 'subagent-preset-in-process.preset-tool')
  }

  // Each `ctx.tools.register` is effect-scoped and auto-disposed on unload.
  registerCrewTools(ctx, crews)

  // Settings namespace: editable in Settings → Plugins. `base` carries the
  // composition config and `setSource`/`onChange` wire live re-resolution.
  installSettings(ctx, SETTINGS_NAMESPACE, Config, config, {
    setSource: (get) => {
      current = get()
    },
    onChange: () => {
      // Resolved value already captured by setSource. Role/task definitions are
      // re-read from `current` on the next materialize(), so adding a crew or
      // editing role pins through Settings takes effect on the next
      // materialize — but `CrewService` intentionally keeps its constructor
      // crew set, so renaming/removing crews still needs a restart. Live crew
      // definitions ARE picked up here for crews the service already knows.
      crews.reloadCrews(current.crews ?? {})
    },
  })
}
