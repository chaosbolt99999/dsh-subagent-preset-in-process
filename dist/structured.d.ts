import type { Context } from '@deepseek-ai/cordis';
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools';
/**
 * Child-scoped structured-output runtime, reimplemented from the shared driver's
 * `attachStructuredRuntime` (`@deepseek-ai/dsh-subagent-in-process-driver/structured`,
 * not exported). Keeps the same face: a `structured_output` tool the child must
 * call to finish, a trailing instruction, a terminal guard, and authoritative
 * `tools/result`-based capture.
 */
export declare const STRUCTURED_OUTPUT_TOOL = "structured_output";
export declare const STRUCTURED_OUTPUT_INSTRUCTION: string;
export interface StructuredHandle {
    captured(): unknown;
}
/**
 * @param children a live child's creation-window scope context.
 * @param schema the trusted schema subset to enforce.
 * @returns a handle whose `captured()` reads the terminal structured value.
 */
export declare function attachStructuredRuntime(children: Context, schema: ObjectJsonSchema): StructuredHandle;
