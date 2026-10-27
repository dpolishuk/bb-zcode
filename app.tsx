import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type {
  PluginTimelineRendererProps,
  PluginNavPanelProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { useBbContext, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import type { workflowRunsRpcContract } from "./src/runsContract.js";
import type { WorkflowRunView } from "./src/runsContract.js";

/**
 * Renders the dynamic-workflow rows the bridge emits as the plugin's own
 * extension kind ("zcode/workflow-graph"). The payload carries the native
 * `create_workflow` causality graph; this component draws ZCode's timeline
 * language on it: a rail with phase stations, subagent pills under their
 * station, control-flow arcs above the rail, and hole markers. When the
 * graph is missing or truncated the declarative base alone remains - half a
 * phase picture would lie (upstream presentation spec).
 */

type Phase = { id: string; name?: string };
type Edge = { from: string; to: string; back?: boolean };
type Step = { id: string; kind?: string; label?: string; lane?: string };
type Participant = {
  id: string;
  phase: string;
  lane: string;
  steps: string[];
  many?: boolean;
  member?: { index: number; of: number };
};
type Hole = { siteId: string; name?: string; phase?: string };
type Graph = {
  steps?: Step[];
  lanes?: { id: string; name?: string }[];
  participants?: Participant[];
  handoffs?: Edge[];
  phases?: Phase[];
  phaseEdges?: Edge[];
  exits?: string[];
  holes?: Hole[];
  truncated?: boolean;
};
type Payload = {
  v: 1;
  state: "running" | "done" | "failed";
  ok?: boolean;
  title?: string;
  summary?: string;
  runId?: string;
  scriptPath?: string;
  error?: string;
  graph?: Graph;
  graphTruncated?: boolean;
};

const STATION_GAP = 120;
const RAIL_Y = 56;
const PILL_W = 96;
const PILL_H = 22;
const PILL_GAP = 6;

function laneLabel(graph: Graph, laneId: string): string {
  const lane = graph.lanes?.find((l) => l.id === laneId);
  return lane?.name ?? laneId;
}

function WorkflowGraphRow({ payload, Original }: PluginTimelineRendererProps) {
  const p = payload as Payload;
  const graph = p.graph;
  const phases = graph?.phases ?? [];
  const useGraph = graph && !graph.truncated && phases.length > 0;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {useGraph ? (
        <Timeline graph={graph} failed={p.state === "failed"} />
      ) : null}
      {graph?.truncated || p.graphTruncated ? (
        <div style={{ opacity: 0.7, fontSize: 12 }}>
          Graph truncated upstream - showing the summary only.
        </div>
      ) : null}
      {!useGraph && (p.state === "failed" || p.error) && p.error ? (
        <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{p.error}</div>
      ) : null}
      {/* The summary carries the compile diagnostics on a failed launch and
          the run text when no graph exists; with a graph the Original base
          already shows the one-line outcome. */}
      {!useGraph && p.summary ? (
        <div
          style={{
            fontSize: 12,
            whiteSpace: "pre-wrap",
            opacity: 0.85,
            maxHeight: 180,
            overflowY: "auto",
          }}
        >
          {p.summary}
        </div>
      ) : null}
      {p.runId || p.scriptPath ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            fontSize: 11,
            opacity: 0.75,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          {p.runId ? <span>{p.runId}</span> : null}
          {p.scriptPath ? <span>{p.scriptPath}</span> : null}
        </div>
      ) : null}
      <Original />
    </div>
  );
}

function Timeline({ graph, failed }: { graph: Graph; failed: boolean }) {
  const phases = graph.phases!;
  const phaseIndex = new Map(phases.map((phase, i) => [phase.id, i]));
  const width = Math.max(320, phases.length * STATION_GAP + 40);
  const maxPills = Math.max(
    1,
    ...phases.map(
      (phase) =>
        graph.participants?.filter((c) => c.phase === phase.id).length ?? 0,
    ),
  );
  const height = RAIL_Y + 18 + maxPills * (PILL_H + PILL_GAP) + 14;
  const stationX = (index: number) =>
    (index + 0.5) * ((width - 40) / phases.length) + 20;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      style={{ maxHeight: 320, display: "block" }}
      role="img"
      aria-label="Workflow timeline"
    >
      {/* Control-flow arcs above the rail. */}
      {graph.phaseEdges?.map((edge, i) => {
        const from = phaseIndex.get(edge.from);
        const to = phaseIndex.get(edge.to);
        if (from === undefined || to === undefined) return null;
        const x1 = stationX(from);
        const x2 = stationX(to);
        const lift = Math.min(40, 14 + Math.abs(to - from) * 10);
        return (
          <path
            key={`edge-${i}`}
            d={`M ${x1} ${RAIL_Y - 8} C ${x1} ${RAIL_Y - 8 - lift}, ${x2} ${RAIL_Y - 8 - lift}, ${x2} ${RAIL_Y - 8}`}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.45}
            strokeWidth={1.25}
            strokeDasharray={edge.back ? "4 3" : undefined}
            markerEnd="url(#wf-arrow)"
          />
        );
      })}
      <defs>
        <marker
          id="wf-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path
            d="M 0 1 L 7 4 L 0 7 z"
            fill="currentColor"
            fillOpacity={0.45}
          />
        </marker>
      </defs>
      {/* The rail. */}
      <line
        x1={20}
        y1={RAIL_Y}
        x2={width - 20}
        y2={RAIL_Y}
        stroke="currentColor"
        strokeOpacity={0.35}
        strokeWidth={2}
      />
      {phases.map((phase, i) => {
        const x = stationX(i);
        const holes = graph.holes?.filter((h) => h.phase === phase.id) ?? [];
        const isExit = graph.exits?.includes(phase.id);
        return (
          <g key={phase.id}>
            <circle
              cx={x}
              cy={RAIL_Y}
              r={7}
              fill={failed && i === phases.length - 1 ? "currentColor" : "none"}
              fillOpacity={0.25}
              stroke="currentColor"
              strokeWidth={1.5}
            />
            {isExit ? (
              <circle
                cx={x}
                cy={RAIL_Y}
                r={3}
                fill="currentColor"
                fillOpacity={0.6}
              />
            ) : null}
            {holes.length > 0 ? (
              <rect
                x={x - 4}
                y={RAIL_Y - 16}
                width={8}
                height={8}
                transform={`rotate(45 ${x} ${RAIL_Y - 12})`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.25}
              >
                <title>{holes.map((h) => h.name ?? h.siteId).join(", ")}</title>
              </rect>
            ) : null}
            <text
              x={x}
              y={RAIL_Y - 24}
              textAnchor="middle"
              fontSize={11}
              fill="currentColor"
            >
              {(phase.name ?? phase.id).slice(0, 24)}
            </text>
          </g>
        );
      })}
      {/* Subagent pills under their phase station. */}
      {phases.map((phase, i) => {
        const cards = graph.participants?.filter((c) => c.phase === phase.id);
        if (!cards?.length) return null;
        const x = stationX(i);
        return (
          <g key={`pills-${phase.id}`}>
            {cards.slice(0, 6).map((card, j) => {
              const y = RAIL_Y + 14 + j * (PILL_H + PILL_GAP);
              return (
                <g key={card.id}>
                  <rect
                    x={x - PILL_W / 2}
                    y={y}
                    width={PILL_W}
                    height={PILL_H}
                    rx={PILL_H / 2}
                    fill="currentColor"
                    fillOpacity={0.08}
                    stroke="currentColor"
                    strokeOpacity={0.35}
                  />
                  <text
                    x={x}
                    y={y + PILL_H / 2 + 3.5}
                    textAnchor="middle"
                    fontSize={10}
                    fill="currentColor"
                  >
                    {`${laneLabel(graph, card.lane).slice(0, 12)}${card.many ? " ×n" : ""}`}
                  </text>
                </g>
              );
            })}
            {cards.length > 6 ? (
              <text
                x={x}
                y={RAIL_Y + 14 + 6 * (PILL_H + PILL_GAP) + 10}
                textAnchor="middle"
                fontSize={10}
                fill="currentColor"
                fillOpacity={0.7}
              >
                +{cards.length - 6} more
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_timelineRenderer({
    kind: "zcode/workflow-graph",
    component: WorkflowGraphRow,
  });
  // The workflows hub: run history for the project in view, read cross-thread
  // from the persisted run store via the plugin's sessionless RPC.
  app.slots.navPanel({
    id: "workflows",
    title: "Workflows",
    icon: "Workflow",
    path: "workflows",
    component: WorkflowHub,
  });
  // Per-thread run pane: the same history scoped by the thread's checkout.
  app.slots.threadPanelAction({
    id: "workflow-runs",
    title: "ZCode workflow runs",
    icon: "Workflow",
    component: WorkflowRunPane,
  });
});

type RunRow = WorkflowRunView;

type RunsState = {
  runs: RunRow[];
  truncated: boolean;
  error?: string;
  loading: boolean;
};

/** Poll the plugin's workflowRuns RPC; each cold read spawns a short CLI. */
function useWorkflowRuns(
  input: { threadId?: string; projectId?: string } | null,
): RunsState & { refresh: () => void } {
  const rpc = useRpc<typeof workflowRunsRpcContract>();
  const [state, setState] = useState<RunsState>({
    runs: [],
    truncated: false,
    loading: false,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!input) return;
    let cancelled = false;
    setState((previous) => ({ ...previous, loading: true }));
    rpc
      .call("workflowRuns", {
        threadId: input.threadId,
        projectId: input.projectId,
        limit: 50,
      })
      .then((reply) => {
        if (cancelled) return;
        setState({
          runs: reply.runs ?? [],
          truncated: reply.truncated === true,
          loading: false,
        });
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setState({
          runs: [],
          truncated: false,
          loading: false,
          error: error.message,
        });
      });
    return () => {
      cancelled = true;
    };
    // Slow auto-refresh: a cold read spawns a CLI process, so the poll only
    // paces live tailing; manual refresh covers the rest.
  }, [rpc, input?.threadId, input?.projectId, tick]);
  useEffect(() => {
    if (!input) return;
    const timer = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, [input?.threadId, input?.projectId]);
  return { ...state, refresh: () => setTick((n) => n + 1) };
}

const statusTone = (status: string): string =>
  status === "completed"
    ? "●"
    : status === "errored"
      ? "✕"
      : status === "stopped"
        ? "◼"
        : status === "running"
          ? "◐"
          : "○";

function RunsTable({ state }: { state: RunsState }) {
  if (state.error)
    return <div style={{ fontSize: 13, opacity: 0.85 }}>{state.error}</div>;
  if (!state.runs.length && !state.loading)
    return (
      <div style={{ fontSize: 13, opacity: 0.7 }}>
        No ZCode dynamic-workflow runs in this workspace yet.
      </div>
    );
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {state.runs.map((run) => (
        <div
          key={run.runId}
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr auto",
            gap: 8,
            alignItems: "baseline",
            fontSize: 12,
            borderBottom: "1px solid",
            borderBottomColor: "currentColor",
            paddingBottom: 4,
            opacity: 0.9,
          }}
        >
          <span title={run.status} aria-label={run.status}>
            {statusTone(run.status)}
          </span>
          <span style={{ overflowWrap: "anywhere" }}>
            {run.name ?? run.runId}
            {run.stopReason ? (
              <span style={{ opacity: 0.6 }}> ({run.stopReason})</span>
            ) : null}
            <span style={{ opacity: 0.55, display: "block" }}>
              {run.runId}
              {run.spentTokens !== undefined
                ? ` · ${run.spentTokens} tokens`
                : ""}
              {run.updatedAt
                ? ` · ${new Date(run.updatedAt).toLocaleString()}`
                : ""}
            </span>
          </span>
          <span style={{ opacity: 0.6 }}>
            {run.artifacts?.length ? `${run.artifacts.length} artifact(s)` : ""}
          </span>
        </div>
      ))}
      {state.truncated ? (
        <div style={{ fontSize: 11, opacity: 0.6 }}>Older runs truncated.</div>
      ) : null}
    </div>
  );
}

function WorkflowHub({}: PluginNavPanelProps) {
  const { projectId } = useBbContext();
  const state = useWorkflowRuns(projectId ? { projectId } : null);
  return (
    <div style={{ display: "grid", gap: 10, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong style={{ fontSize: 14 }}>ZCode workflow runs</strong>
        <span style={{ fontSize: 11, opacity: 0.6 }}>
          persisted history, read cross-thread
        </span>
        <button
          onClick={state.refresh}
          style={{ marginLeft: "auto", fontSize: 12 }}
        >
          {state.loading ? "Reading…" : "Refresh"}
        </button>
      </div>
      {!projectId ? (
        <div style={{ fontSize: 13, opacity: 0.7 }}>
          Select a project to list its workflow runs.
        </div>
      ) : (
        <RunsTable state={state} />
      )}
    </div>
  );
}

function WorkflowRunPane({ threadId }: PluginThreadPanelProps) {
  const state = useWorkflowRuns(threadId ? { threadId } : null);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Workflow runs</strong>
        <button
          onClick={state.refresh}
          style={{ marginLeft: "auto", fontSize: 12 }}
        >
          {state.loading ? "Reading…" : "Refresh"}
        </button>
      </div>
      <RunsTable state={state} />
    </div>
  );
}
