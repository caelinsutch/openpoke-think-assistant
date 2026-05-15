import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowsClockwiseIcon, PaperPlaneRightIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { Badge, Banner, Button, Surface, Text } from "@cloudflare/kumo";
import type {
  ExecutionAgentSummary,
  ExecutionTaskSummary,
  ExecutionTriggerSummary,
} from "./server";

interface DirectoryCaller {
  call: (method: string, args?: unknown[]) => Promise<unknown>;
}

interface OrchestrationPanelProps {
  directory: DirectoryCaller;
  open: boolean;
  onClose: () => void;
}

function formatTimestamp(value?: number): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function summarizeText(value?: string, fallback = "No details yet."): string {
  const text = value?.trim();
  if (!text) return fallback;
  return text.length > 180 ? text.slice(0, 177) + "..." : text;
}

export function OrchestrationPanel({ directory, open, onClose }: OrchestrationPanelProps) {
  const [agents, setAgents] = useState<ExecutionAgentSummary[]>([]);
  const [tasks, setTasks] = useState<ExecutionTaskSummary[]>([]);
  const [triggers, setTriggers] = useState<ExecutionTriggerSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentForm, setAgentForm] = useState({
    role: "general" as ExecutionAgentSummary["role"],
    title: "",
    instructions: "",
  });
  const [taskForm, setTaskForm] = useState({ agentId: "", title: "", instructions: "" });
  const [triggerForm, setTriggerForm] = useState({
    agentId: "",
    taskId: "",
    cron: "0 14 * * *",
  });

  const refresh = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const [nextAgents, nextTasks, nextTriggers] = await Promise.all([
        directory.call("listExecutionAgents", []),
        directory.call("listExecutionTasks", []),
        directory.call("listExecutionTriggers", []),
      ]);
      setAgents(nextAgents as ExecutionAgentSummary[]);
      setTasks(nextTasks as ExecutionTaskSummary[]);
      setTriggers(nextTriggers as ExecutionTriggerSummary[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load orchestration state");
    } finally {
      setLoading(false);
    }
  }, [directory, open]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreateAgent = async (event: FormEvent) => {
    event.preventDefault();
    const title = agentForm.title.trim();
    const instructions = agentForm.instructions.trim();
    if (!title || !instructions) return;

    setBusyAction("create-agent");
    setError(null);
    try {
      const created = (await directory.call("createExecutionAgent", [
        { role: agentForm.role, title, instructions },
      ])) as ExecutionAgentSummary;
      setAgentForm({ role: "general", title: "", instructions: "" });
      setTaskForm((prev) => ({ ...prev, agentId: prev.agentId || created.id }));
      setTriggerForm((prev) => ({ ...prev, agentId: prev.agentId || created.id }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create execution agent");
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreateTask = async (event: FormEvent) => {
    event.preventDefault();
    const title = taskForm.title.trim();
    const instructions = taskForm.instructions.trim();
    if (!taskForm.agentId || !title || !instructions) return;

    setBusyAction("create-task");
    setError(null);
    try {
      const created = (await directory.call("createExecutionTask", [
        { agentId: taskForm.agentId, title, instructions },
      ])) as ExecutionTaskSummary;
      setTaskForm((prev) => ({ ...prev, title: "", instructions: "" }));
      setTriggerForm((prev) => ({
        ...prev,
        agentId: prev.agentId || created.agentId,
        taskId: prev.taskId || created.id,
      }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create execution task");
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreateTrigger = async (event: FormEvent) => {
    event.preventDefault();
    const cron = triggerForm.cron.trim();
    if (!triggerForm.agentId || !triggerForm.taskId || !cron) return;

    setBusyAction("create-trigger");
    setError(null);
    try {
      await directory.call("createExecutionTrigger", [
        { agentId: triggerForm.agentId, taskId: triggerForm.taskId, cron },
      ]);
      setTriggerForm((prev) => ({ ...prev, taskId: "", cron: "0 14 * * *" }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create execution trigger");
    } finally {
      setBusyAction(null);
    }
  };

  const handleRunTask = async (taskId: string) => {
    setBusyAction("run-" + taskId);
    setError(null);
    try {
      await directory.call("runExecutionTask", [taskId, "Run from the orchestration panel."]);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run execution task");
    } finally {
      setBusyAction(null);
    }
  };

  if (!open) return null;

  const taskOptions = triggerForm.agentId
    ? tasks.filter((task) => task.agentId === triggerForm.agentId)
    : tasks;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
      <Surface className="h-full w-full max-w-5xl overflow-y-auto border-l border-kumo-line p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-kumo-line pb-4">
          <div>
            <Text size="lg" bold>
              Orchestration
            </Text>
            <Text size="xs" variant="secondary">
              Hidden execution agents, durable tasks, and scheduled triggers.
            </Text>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<ArrowsClockwiseIcon size={14} />}
              onClick={() => void refresh()}
              loading={loading}
            >
              Refresh
            </Button>
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              aria-label="Close orchestration panel"
              icon={<XIcon size={14} />}
              onClick={onClose}
            />
          </div>
        </div>

        {error && (
          <div className="mt-4">
            <Banner variant="error">{error}</Banner>
          </div>
        )}

        <div className="mt-5 grid gap-4 xl:grid-cols-3">
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <Text size="sm" bold>
                Agents
              </Text>
              <Badge variant="secondary">{agents.length}</Badge>
            </div>
            <form
              onSubmit={handleCreateAgent}
              className="space-y-2 rounded-lg border border-kumo-line p-3"
            >
              <select
                value={agentForm.role}
                onChange={(event) =>
                  setAgentForm((prev) => ({
                    ...prev,
                    role: event.target.value as ExecutionAgentSummary["role"],
                  }))
                }
                className="w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-accent"
              >
                <option value="general">General</option>
                <option value="research">Research</option>
                <option value="email">Email</option>
                <option value="reminder">Reminder</option>
              </select>
              <input
                value={agentForm.title}
                onChange={(event) =>
                  setAgentForm((prev) => ({ ...prev, title: event.target.value }))
                }
                placeholder="Agent title"
                className="w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
              />
              <textarea
                value={agentForm.instructions}
                onChange={(event) =>
                  setAgentForm((prev) => ({ ...prev, instructions: event.target.value }))
                }
                placeholder="Persistent instructions"
                rows={3}
                className="w-full resize-none rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
              />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                icon={<PlusIcon size={14} />}
                disabled={!agentForm.title.trim() || !agentForm.instructions.trim()}
                loading={busyAction === "create-agent"}
              >
                Create agent
              </Button>
            </form>
            <div className="space-y-2">
              {agents.map((agent) => (
                <div key={agent.id} className="rounded-lg border border-kumo-line p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Text size="sm" bold>
                      <span className="truncate block">{agent.title}</span>
                    </Text>
                    <Badge variant={agent.status === "error" ? "secondary" : "primary"}>
                      {agent.status}
                    </Badge>
                  </div>
                  <Text size="xs" variant="secondary">
                    {agent.role} / {agent.id}
                  </Text>
                  <p className="mt-2 text-xs text-kumo-subtle">
                    {summarizeText(agent.instructions)}
                  </p>
                  {agent.lastResult && (
                    <p className="mt-2 text-xs text-kumo-subtle">
                      {summarizeText(agent.lastResult)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <Text size="sm" bold>
                Tasks
              </Text>
              <Badge variant="secondary">{tasks.length}</Badge>
            </div>
            <form
              onSubmit={handleCreateTask}
              className="space-y-2 rounded-lg border border-kumo-line p-3"
            >
              <select
                value={taskForm.agentId}
                onChange={(event) =>
                  setTaskForm((prev) => ({ ...prev, agentId: event.target.value }))
                }
                className="w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-accent"
              >
                <option value="">Choose agent</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.title}
                  </option>
                ))}
              </select>
              <input
                value={taskForm.title}
                onChange={(event) =>
                  setTaskForm((prev) => ({ ...prev, title: event.target.value }))
                }
                placeholder="Task title"
                className="w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
              />
              <textarea
                value={taskForm.instructions}
                onChange={(event) =>
                  setTaskForm((prev) => ({ ...prev, instructions: event.target.value }))
                }
                placeholder="Task instructions"
                rows={3}
                className="w-full resize-none rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
              />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                icon={<PlusIcon size={14} />}
                disabled={
                  !taskForm.agentId || !taskForm.title.trim() || !taskForm.instructions.trim()
                }
                loading={busyAction === "create-task"}
              >
                Create task
              </Button>
            </form>
            <div className="space-y-2">
              {tasks.map((task) => (
                <div key={task.id} className="rounded-lg border border-kumo-line p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Text size="sm" bold>
                      <span className="truncate block">{task.title}</span>
                    </Text>
                    <Badge variant={task.status === "error" ? "secondary" : "primary"}>
                      {task.status}
                    </Badge>
                  </div>
                  <Text size="xs" variant="secondary">
                    {agents.find((agent) => agent.id === task.agentId)?.title ?? task.agentId}
                  </Text>
                  <p className="mt-2 text-xs text-kumo-subtle">
                    {summarizeText(task.instructions)}
                  </p>
                  <Text size="xs" variant="secondary">
                    Last run: {formatTimestamp(task.lastRunAt)}
                  </Text>
                  {task.result && (
                    <p className="mt-2 text-xs text-kumo-subtle">{summarizeText(task.result)}</p>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<PaperPlaneRightIcon size={14} />}
                    onClick={() => void handleRunTask(task.id)}
                    loading={busyAction === "run-" + task.id}
                    className="mt-2"
                  >
                    Run now
                  </Button>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <Text size="sm" bold>
                Triggers
              </Text>
              <Badge variant="secondary">{triggers.length}</Badge>
            </div>
            <form
              onSubmit={handleCreateTrigger}
              className="space-y-2 rounded-lg border border-kumo-line p-3"
            >
              <select
                value={triggerForm.agentId}
                onChange={(event) =>
                  setTriggerForm((prev) => ({ ...prev, agentId: event.target.value, taskId: "" }))
                }
                className="w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-accent"
              >
                <option value="">Choose agent</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.title}
                  </option>
                ))}
              </select>
              <select
                value={triggerForm.taskId}
                onChange={(event) =>
                  setTriggerForm((prev) => ({ ...prev, taskId: event.target.value }))
                }
                className="w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-accent"
              >
                <option value="">Choose task</option>
                {taskOptions.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
              <input
                value={triggerForm.cron}
                onChange={(event) =>
                  setTriggerForm((prev) => ({ ...prev, cron: event.target.value }))
                }
                placeholder="0 14 * * *"
                className="w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 font-mono text-sm text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
              />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                icon={<PlusIcon size={14} />}
                disabled={!triggerForm.agentId || !triggerForm.taskId || !triggerForm.cron.trim()}
                loading={busyAction === "create-trigger"}
              >
                Create trigger
              </Button>
            </form>
            <div className="space-y-2">
              {triggers.map((trigger) => {
                const task = tasks.find((entry) => entry.id === trigger.taskId);
                const agent = agents.find((entry) => entry.id === trigger.agentId);
                return (
                  <div key={trigger.id} className="rounded-lg border border-kumo-line p-3">
                    <div className="flex items-center justify-between gap-2">
                      <Text size="sm" bold>
                        <span className="truncate block">{task?.title ?? trigger.taskId}</span>
                      </Text>
                      <Badge variant={trigger.enabled ? "primary" : "secondary"}>
                        {trigger.enabled ? "enabled" : "disabled"}
                      </Badge>
                    </div>
                    <Text size="xs" variant="secondary">
                      {agent?.title ?? trigger.agentId}
                    </Text>
                    <p className="mt-2 font-mono text-xs text-kumo-subtle">{trigger.cron}</p>
                    <Text size="xs" variant="secondary">
                      Last fired: {formatTimestamp(trigger.lastRunAt)}
                    </Text>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </Surface>
    </div>
  );
}
