import type { Context } from '@deepseek-ai/cordis';
import type { CrewService } from './crew.js';
/** Register the crew tools on `ctx.tools`. Returns the disposers. */
export declare function registerCrewTools(ctx: Context, crews: CrewService): (() => void)[];
