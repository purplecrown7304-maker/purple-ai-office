import { describe, expect, it } from "vitest";
import {
  activityFor,
  canRun,
  MessageTracker,
  sortedMessages,
} from "../../src/lib/office/presentation";
import type { Agent, Message, Task } from "../../src/lib/office/types";
const agent = {
  id: "lead",
  slug: "gpt",
  status: "WORKING",
  current_task_id: "task",
} as Agent;
const task = {
  id: "task",
  lead_agent: "lead",
  reviewer_agent: "reviewer",
  status: "IMPLEMENTING",
  is_demo: true,
  demo_paused: false,
} as Task;
const message = {
  id: "m1",
  task_id: "task",
  from_agent: "lead",
  to_agent: "reviewer",
  type: "QUESTION",
  created_at: "2026-09-28T00:00:00Z",
} as Message;
describe("DB-driven presentation", () => {
  it("uses assigned roles and real agent ownership, not model names", () => {
    expect(activityFor(agent, task, null)).toBe("typing");
    expect(
      activityFor({ ...agent, current_task_id: "other" }, task, null),
    ).toBe("idle");
    expect(
      activityFor(
        { ...agent, id: "reviewer" },
        { ...task, status: "CROSS_REVIEW" },
        null,
      ),
    ).toBe("scan");
    expect(activityFor(agent, { ...task, status: "CROSS_REVIEW" }, null)).toBe(
      "idle",
    );
    expect(activityFor(agent, { ...task, status: "DISCUSSION" }, message)).toBe(
      "ellipsis",
    );
  });
  it("stops all motion and scheduling for paused, waiting and terminal tasks", () => {
    for (const status of [
      "WAITING_USER",
      "DONE",
      "CANCELLED",
      "ESCALATED",
      "BLOCKED",
      "WAITING_AGENT",
    ] as Task["status"][]) {
      expect(activityFor(agent, { ...task, status }, message)).toBe("idle");
      expect(canRun({ ...task, status })).toBe(false);
    }
    expect(activityFor(agent, { ...task, demo_paused: true }, message)).toBe(
      "idle",
    );
    expect(canRun({ ...task, demo_paused: true })).toBe(false);
  });
  it("deduplicates snapshots/queue updates and baselines reconnect without replaying history", () => {
    const tracker = new MessageTracker();
    tracker.baseline([message]);
    expect(tracker.accept(message, "task", ["lead", "reviewer"])).toBe(false);
    const next = { ...message, id: "m2" };
    expect(tracker.accept(next, "task", ["lead", "reviewer"])).toBe(true);
    expect(
      tracker.accept({ ...next, queue_status: "done" }, "task", [
        "lead",
        "reviewer",
      ]),
    ).toBe(false);
    tracker.baseline([message, next]);
    expect(tracker.accept(next, "task", ["lead", "reviewer"])).toBe(false);
    expect(
      tracker.accept({ ...message, id: "m3", to_agent: null }, "task", [
        "lead",
        "reviewer",
      ]),
    ).toBe(false);
    expect(
      tracker.accept({ ...message, id: "m4", task_id: "other" }, "task", [
        "lead",
        "reviewer",
      ]),
    ).toBe(false);
  });
  it("orders simultaneous messages by ID consistently without mutating input", () => {
    const rows = [
      { ...message, id: "z" },
      { ...message, id: "a" },
    ];
    expect(sortedMessages(rows).map((m) => m.id)).toEqual(["a", "z"]);
    expect(rows[0].id).toBe("z");
  });
});
