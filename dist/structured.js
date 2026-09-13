import { ToolArgsError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
/**
 * Child-scoped structured-output runtime, reimplemented from the shared driver's
 * `attachStructuredRuntime` (`@deepseek-ai/dsh-subagent-in-process-driver/structured`,
 * not exported). Keeps the same face: a `structured_output` tool the child must
 * call to finish, a trailing instruction, a terminal guard, and authoritative
 * `tools/result`-based capture.
 */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output';
export const STRUCTURED_OUTPUT_INSTRUCTION = 'When you have your final answer, you MUST report it by calling the `' +
    STRUCTURED_OUTPUT_TOOL +
    '` tool with arguments matching its parameter schema exactly. Do not finish with a plain text answer: only the tool call counts as your result.';
/**
 * @param children a live child's creation-window scope context.
 * @param schema the trusted schema subset to enforce.
 * @returns a handle whose `captured()` reads the terminal structured value.
 */
export function attachStructuredRuntime(children, schema) {
    const staged = new WeakMap();
    let pending;
    let captured;
    children.tools.register({
        name: STRUCTURED_OUTPUT_TOOL,
        description: 'Report your final structured result. Call this exactly once, when your answer is complete; the arguments must match this tool\'s parameter schema exactly.',
        parameters: schema,
        output: {
            schema: {
                type: 'object',
                properties: { recorded: { type: 'boolean', const: true } },
                required: ['recorded'],
                additionalProperties: false,
            },
            render: () => [{ type: 'text', text: 'Structured output recorded.' }],
        },
        execute(args, exec) {
            const violations = validateJsonSchemaValue(schema, args);
            if (violations.length > 0)
                throw new ToolArgsError(violations);
            staged.set(exec, { value: args });
            exec.concludeTurn();
            return Promise.resolve({ recorded: true });
        },
    });
    children.systemPrompt.section({
        name: `tool:${STRUCTURED_OUTPUT_TOOL}`,
        order: 190,
        text: STRUCTURED_OUTPUT_INSTRUCTION,
    });
    children.tools.guard((exec) => captured === undefined && pending === undefined
        ? undefined
        : `structured output already recorded: the run is complete, so \`${exec.name}\` is not executed`);
    children.on('tools/result', function (exec, result) {
        if (exec.name === STRUCTURED_OUTPUT_TOOL) {
            const entry = staged.get(exec);
            if (entry === undefined)
                return;
            staged.delete(exec);
            if (result.isError)
                return;
            if (exec.parent === undefined) {
                if (captured === undefined)
                    captured = { value: entry.value };
            }
            else if (captured === undefined && pending === undefined) {
                pending = { parent: exec.parent, value: entry.value };
            }
            return;
        }
        if (pending === undefined || pending.parent !== exec.token)
            return;
        const entry = pending;
        pending = undefined;
        if (result.isError)
            return;
        if (captured === undefined)
            captured = { value: entry.value };
    });
    return { captured: () => captured?.value };
}
