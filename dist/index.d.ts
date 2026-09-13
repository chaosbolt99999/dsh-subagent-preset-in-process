import type { Context } from '@deepseek-ai/cordis';
import { Config, type Config as ConfigType } from './config.js';
import { PresetInProcessProvider } from './provider.js';
import { CrewService } from './crew.js';
export declare const name = "subagent-preset-in-process";
export declare const inject: string[];
export declare const SETTINGS_NAMESPACE: import("@deepseek-ai/dsh-settings").SettingsNamespace;
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
