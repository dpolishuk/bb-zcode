import { z } from "zod";

/**
 * The workflowRuns RPC contract shared by the server registration and the
 * frontend's typed `useRpc` client. Pure zod: the app bundle imports it as a
 * type only, so nothing node-side leaks into the browser build.
 */

export const workflowRunViewSchema = z.looseObject({
  runId: z.string(),
  name: z.string().optional(),
  status: z.enum(["pending", "running", "completed", "errored", "stopped"]),
  stopReason: z.string().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  spentTokens: z.number().optional(),
  parentSessionId: z.string().optional(),
  toolCallId: z.string().optional(),
  artifacts: z
    .array(
      z.looseObject({
        id: z.string(),
        kind: z.string(),
        title: z.string().optional(),
      }),
    )
    .optional(),
});
export type WorkflowRunView = z.infer<typeof workflowRunViewSchema>;

export const workflowRunsRpcContract = {
  workflowRuns: {
    input: z.object({
      threadId: z.string().min(1).optional(),
      projectId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    output: z.object({
      runs: z.array(workflowRunViewSchema),
      truncated: z.boolean(),
    }),
  },
} as const;
