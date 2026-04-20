/**
 * TodoWriteTool — Task tracking for the agent
 *
 * Based on Claude Code's TodoWriteTool
 * Manages a structured task list for the current session
 */

import { z } from 'zod';
import { buildTool, type ToolResult, type RenderOptions } from '../Tool.js';

const TodoItemSchema = z.object({
  content: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

const TodoWriteInputSchema = z.object({
  todos: z.array(TodoItemSchema).describe('The updated todo list'),
});

type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

// In-memory todo store (per session)
let currentTodos: Array<{ content: string; status: string }> = [];

export function getTodos() {
  return [...currentTodos];
}

export function clearTodos() {
  currentTodos = [];
}

export const TodoWriteTool = buildTool<TodoWriteInput>({
  name: 'TodoWrite',
  aliases: ['TodoWriteTool'],
  searchHint: 'task todo list track progress',
  description: `Create and manage a structured task list for the current session.
Use this to track progress on complex multi-step tasks.
Task states: pending, in_progress, completed.
Only one task should be in_progress at a time.`,
  inputSchema: TodoWriteInputSchema,

  userFacingName() { return 'TodoWrite'; },
  isReadOnly() { return false; },
  isConcurrencySafe() { return false; },
  isDestructive() { return false; },
  renderToolUseMessage(input: TodoWriteInput, _opts: RenderOptions) {
    const counts = { pending: 0, in_progress: 0, completed: 0 };
    for (const t of input.todos) counts[t.status]++;
    return `TodoWrite: ${counts.completed}✓ ${counts.in_progress}▸ ${counts.pending}○`;
  },

  async checkPermissions() {
    return { behavior: 'allow' as const };
  },

  async call(input: TodoWriteInput, context?: any): Promise<ToolResult> {
    // ── Delivery guard: prevent marking tasks as 'completed' without evidence ──
    // If any task is being set to 'completed' that was previously not completed,
    // we inject a warning reminder into the output so the model self-checks.
    const newlyCompleted = input.todos.filter((t) => {
      if (t.status !== 'completed') return false;
      const prev = currentTodos.find((p) => p.content === t.content);
      return !prev || prev.status !== 'completed';
    });

    let deliveryWarning = '';
    if (newlyCompleted.length > 0) {
      deliveryWarning = '\n\n⚠ LEMBRETE: Voce marcou tarefas como concluidas. '
        + 'Verifique se o artefato solicitado (arquivo, codigo, planilha, etc) '
        + 'foi EFETIVAMENTE entregue na conversa antes de encerrar. '
        + 'Se ainda nao entregou, continue trabalhando.';
    }

    currentTodos = input.todos.map((t) => ({
      content: t.content,
      status: t.status,
    }));

    const summary = currentTodos
      .map((t) => {
        const icon = t.status === 'completed' ? '[x]' :
          t.status === 'in_progress' ? '[>]' : '[ ]';
        return `${icon} ${t.content}`;
      })
      .join('\n');

    return {
      output: { todos: currentTodos },
      outputText: `Todo list updated:\n${summary}${deliveryWarning}`,
    };
  },
});
